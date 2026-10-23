/**
 * Resource Budget & Disk Safety Governance Service
 *
 * Implements conservative limits, concurrency clamping, disk headroom guards,
 * and strict prohibitions against global Docker pruning on shared hosts.
 */

class ResourceBudgetError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ResourceBudgetError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Observed Host Specifications (Oracle Cloud Infrastructure VPS)
 */
const OBSERVED_HOST_CAPACITY = Object.freeze({
  ocpuCount: 4,
  totalMemoryBytes: 23 * 1024 * 1024 * 1024, // ~23 GiB
  observedAvailableMemoryBytes: 14 * 1024 * 1024 * 1024, // ~14 GiB at observation
  totalDiskBytes: 145 * 1024 * 1024 * 1024,
  observedFreeDiskBytes: 54 * 1024 * 1024 * 1024, // 54 GB free at observation
  observedRunningContainers: 45
});

/**
 * Conservative Staging Resource Budget Defaults
 */
const DEFAULT_RESOURCE_BUDGET = Object.freeze({
  // Candidate application container limits
  candidateDefaultCpu: 1.0,
  candidateMaxCpu: 2.0,
  candidateDefaultMemoryMb: 1024,
  candidateMaxMemoryMb: 4096,

  // Dedicated staging ingress container limits
  ingressCpu: 0.5,
  ingressMemoryMb: 256,

  // Strict concurrency limit
  maxBuildConcurrency: 1,

  // Disk headroom guards
  minHostFreeDiskBytes: 10 * 1024 * 1024 * 1024, // 10 GB minimum free disk floor
  minBuildFreeDiskBytes: 12 * 1024 * 1024 * 1024, // 12 GB required before build

  // Host reserve budget: minimum memory preserved for OS & 45 existing containers
  reservedSystemMemoryMb: 8192 // 8 GB reserved for existing workloads
});

/**
 * Validates and clamps candidate resource allocations.
 * Ensures allocations do not exceed operator budget on the 4-OCPU host.
 *
 * @param {Object} requested - { cpuLimit, memoryLimitMb }
 * @param {Object} [operatorConfig] - Configurable overrides
 * @returns {Object} Validated and clamped limits
 */
function validateCandidateResourceBudget(requested = {}, operatorConfig = {}) {
  const maxCpu = Number(operatorConfig.candidateMaxCpu || process.env.KPANEL_MAX_CPU_LIMIT || DEFAULT_RESOURCE_BUDGET.candidateMaxCpu);
  const maxMemMb = Number(operatorConfig.candidateMaxMemoryMb || process.env.KPANEL_MAX_MEMORY_LIMIT_MB || DEFAULT_RESOURCE_BUDGET.candidateMaxMemoryMb);

  const rawCpu = requested.cpuLimit !== undefined && requested.cpuLimit !== null ? Number(requested.cpuLimit) : DEFAULT_RESOURCE_BUDGET.candidateDefaultCpu;
  if (isNaN(rawCpu) || rawCpu <= 0) {
    throw new ResourceBudgetError(`Invalid CPU limit "${requested.cpuLimit}". Must be a positive number.`, 'INVALID_CPU_LIMIT');
  }

  if (rawCpu > maxCpu) {
    throw new ResourceBudgetError(
      `Requested CPU limit (${rawCpu} cores) exceeds maximum allowed staging budget (${maxCpu} cores) on 4-OCPU host.`,
      'RESOURCE_LIMIT_EXCEEDED',
      { requested: rawCpu, maxAllowed: maxCpu }
    );
  }

  const rawMemMb = requested.memoryLimitMb !== undefined && requested.memoryLimitMb !== null ? Number(requested.memoryLimitMb) : DEFAULT_RESOURCE_BUDGET.candidateDefaultMemoryMb;
  if (isNaN(rawMemMb) || rawMemMb < 64) {
    throw new ResourceBudgetError(`Invalid memory limit "${requested.memoryLimitMb}". Minimum is 64 MB.`, 'INVALID_MEMORY_LIMIT');
  }

  if (rawMemMb > maxMemMb) {
    throw new ResourceBudgetError(
      `Requested memory limit (${rawMemMb} MB) exceeds maximum allowed staging budget (${maxMemMb} MB).`,
      'RESOURCE_LIMIT_EXCEEDED',
      { requested: rawMemMb, maxAllowed: maxMemMb }
    );
  }

  const clampedCpu = Math.max(0.1, Math.min(maxCpu, rawCpu));
  const clampedMemMb = Math.max(64, Math.min(maxMemMb, rawMemMb));

  return {
    cpuLimit: clampedCpu,
    nanoCpus: Math.round(clampedCpu * 1e9),
    memoryLimitMb: clampedMemMb,
    memoryBytes: clampedMemMb * 1024 * 1024,
    operatorMaxCpu: maxCpu,
    operatorMaxMemoryMb: maxMemMb
  };
}

/**
 * Assesses host disk headroom before dispatching builds or creating containers.
 * Fails closed if host free space is below the safe threshold.
 *
 * @param {number} availableDiskBytes - Free disk space on root volume
 * @param {string} [purpose='build'] - Operation purpose ('build' | 'stage')
 * @param {Object} [options] - Options
 * @returns {Object} Headroom report
 */
function evaluateDiskHeadroom(availableDiskBytes, purpose = 'build', options = {}) {
  const minRequired = purpose === 'build'
    ? (options.minBuildFreeDiskBytes || DEFAULT_RESOURCE_BUDGET.minBuildFreeDiskBytes)
    : (options.minHostFreeDiskBytes || DEFAULT_RESOURCE_BUDGET.minHostFreeDiskBytes);

  if (typeof availableDiskBytes !== 'number' || isNaN(availableDiskBytes)) {
    throw new ResourceBudgetError('Available host disk bytes must be a valid number.', 'INVALID_DISK_INPUT');
  }

  const freeMb = Math.round(availableDiskBytes / (1024 * 1024));
  const minMb = Math.round(minRequired / (1024 * 1024));

  if (availableDiskBytes < minRequired) {
    throw new ResourceBudgetError(
      `Host disk pressure guard triggered: ${freeMb} MB free disk is below the safety threshold of ${minMb} MB for ${purpose}. Operation aborted.`,
      'DISK_PRESSURE_ABORT',
      { availableMb: freeMb, requiredMb: minMb, purpose }
    );
  }

  return {
    safe: true,
    availableMb: freeMb,
    requiredMb: minMb,
    purpose,
    headroomMb: freeMb - minMb
  };
}

/**
 * Assesses build concurrency constraints.
 * Strictly enforces concurrency of 1 maximum for initial staging.
 *
 * @param {number} activeBuildCount - Number of currently running builds
 * @returns {Object} Concurrency validation
 */
function enforceBuildConcurrency(activeBuildCount) {
  const count = typeof activeBuildCount === 'number' ? activeBuildCount : 0;
  const max = DEFAULT_RESOURCE_BUDGET.maxBuildConcurrency;

  if (count >= max) {
    throw new ResourceBudgetError(
      `Build concurrency limit reached (${count}/${max}). Concurrent builds are strictly clamped to 1 to preserve CPU and memory headroom for existing 45 workloads.`,
      'BUILD_CONCURRENCY_EXCEEDED',
      { active: count, max }
    );
  }

  return {
    allowed: true,
    active: count,
    max
  };
}

/**
 * Validates prohibition on automated global Docker pruning and dangerous cleanup flags.
 * Under NO circumstances may K-Panel invoke `docker system prune`, `docker image prune`,
 * `docker builder prune`, or compose down with `--remove-orphans` or `--volumes`.
 *
 * @param {string} command - Command string or API endpoint
 */
function validatePruneCommandSafety(command) {
  const lower = String(command || '').toLowerCase();

  // 1. Prohibit compose down dangerous flags
  if (lower.includes('--remove-orphans')) {
    throw new ResourceBudgetError(
      `Cleanup flag "--remove-orphans" in ("${command}") is strictly prohibited. It risks stopping or removing unmanaged or neighbor containers on a shared host.`,
      'REMOVE_ORPHANS_PROHIBITED',
      { command }
    );
  }

  if (lower.includes('--volumes') || (/\bdown\b/.test(lower) && /\s+-v\b/.test(lower))) {
    throw new ResourceBudgetError(
      `Cleanup flag "--volumes" in ("${command}") is strictly prohibited. It risks destroying persistent host or shared storage volumes.`,
      'VOLUMES_CLEANUP_PROHIBITED',
      { command }
    );
  }

  // 2. Prohibit image prune commands (with or without filters)
  if (lower.includes('docker image prune') || lower.includes('/images/prune')) {
    throw new ResourceBudgetError(
      `Image pruning ("${command}") is strictly prohibited during cleanup. Image prune operations risk deleting base images shared with Dokploy, n8n, or production services.`,
      'GLOBAL_PRUNING_PROHIBITED',
      { command }
    );
  }

  // 3. Prohibit global Docker prune operations
  const prohibitedPruneCommands = [
    'docker system prune',
    'docker builder prune',
    'docker volume prune',
    'docker container prune',
    'docker network prune',
    '/system/prune',
    '/build/prune',
    '/volumes/prune',
    '/containers/prune',
    '/networks/prune'
  ];

  for (const prohibited of prohibitedPruneCommands) {
    if (lower.includes(prohibited)) {
      throw new ResourceBudgetError(
        `Automated global Docker pruning ("${command}") is strictly prohibited. Global pruning on a shared host with 45 containers risks deleting neighbor images, volumes, and build caches.`,
        'GLOBAL_PRUNING_PROHIBITED',
        { command }
      );
    }
  }

  // 4. Prohibit wildcard container or image deletions
  if (
    lower.includes('docker rm -f $(') ||
    lower.includes('docker rmi -f $(') ||
    lower.includes('docker kill $(') ||
    lower.includes('docker rm *') ||
    lower.includes('docker rmi *')
  ) {
    throw new ResourceBudgetError(
      `Wildcard container/image deletion ("${command}") is strictly prohibited on a shared host.`,
      'WILDCARD_CLEANUP_PROHIBITED',
      { command }
    );
  }

  return { safe: true };
}

/**
 * Evaluates a proposed smoke-test cleanup plan against strict multi-tenant safety invariants.
 *
 * Invariants enforced:
 * 1. Exact, unique smoke-test Compose project name required (rejects empty, short, or protected names).
 * 2. Exact smokeRunId required.
 * 3. Rejects unattended cleanup (unattended === true).
 * 4. Rejects without operator confirmation (operatorConfirmed === true).
 * 5. Rejects dangerous flags (--remove-orphans, --volumes).
 * 6. Foreign containers (not belonging to project or lacking matching smokeRunId) cannot be selected.
 * 7. Protected containers (kpanel-frontend-1, dokploy, n8n, etc.) are strictly shielded.
 * 8. Ambiguous ownership (missing labels, conflicting project names) blocks cleanup / preserves resources.
 * 9. Images are left in place unless exact ownership is proven; image prune commands are prohibited.
 * 10. Enumerates exactly what containers and networks will be stopped/removed.
 *
 * @param {Object} cleanupRequest - Cleanup parameters and target resource lists
 * @returns {Object} Validated cleanup specification
 */
function validateSmokeCleanupPlan(cleanupRequest = {}) {
  if (!cleanupRequest || typeof cleanupRequest !== 'object') {
    throw new ResourceBudgetError('Cleanup request object is required.', 'INVALID_CLEANUP_REQUEST');
  }

  // 1. Prohibit unattended cleanup
  if (cleanupRequest.unattended === true) {
    throw new ResourceBudgetError(
      'Unattended cleanup is strictly prohibited. Disposable staging cleanup requires explicit operator review and confirmation.',
      'UNATTENDED_CLEANUP_PROHIBITED'
    );
  }

  // 2. Command flags validation
  if (cleanupRequest.flags) {
    const flagsStr = Array.isArray(cleanupRequest.flags) ? cleanupRequest.flags.join(' ') : String(cleanupRequest.flags);
    if (flagsStr.includes('--remove-orphans')) {
      throw new ResourceBudgetError(
        'Flag --remove-orphans is strictly prohibited during cleanup to prevent accidental deletion of foreign containers.',
        'REMOVE_ORPHANS_PROHIBITED'
      );
    }
    if (flagsStr.includes('--volumes') || flagsStr.includes('-v')) {
      throw new ResourceBudgetError(
        'Flag --volumes is strictly prohibited during cleanup to prevent destruction of shared or persistent storage.',
        'VOLUMES_CLEANUP_PROHIBITED'
      );
    }
  }

  // 3. Require operator confirmation
  if (cleanupRequest.operatorConfirmed !== true) {
    throw new ResourceBudgetError(
      'Operator confirmation is required before any destructive cleanup operation can be authorized or executed.',
      'OPERATOR_CONFIRMATION_REQUIRED'
    );
  }

  // 4. Exact, unique Compose project name required
  const projectName = String(cleanupRequest.projectName || '').trim().toLowerCase();
  const protectedProjects = ['kpanel', 'kpanel-clean', 'dokploy', 'n8n'];
  if (!projectName || projectName.length < 3) {
    throw new ResourceBudgetError(
      'An exact, unique smoke-test Compose project name is required for cleanup.',
      'EXACT_PROJECT_NAME_REQUIRED'
    );
  }
  if (protectedProjects.includes(projectName)) {
    throw new ResourceBudgetError(
      `Cannot clean up protected host project "${projectName}". Cleanup is strictly restricted to disposable smoke projects.`,
      'PROTECTED_PROJECT_CLEANUP_BLOCKED',
      { projectName }
    );
  }

  // 5. Exact smokeRunId required
  const smokeRunId = String(cleanupRequest.smokeRunId || '').trim();
  if (!smokeRunId) {
    throw new ResourceBudgetError(
      'Exact smoke-run ID is required for cleanup provenance verification.',
      'SMOKE_RUN_ID_REQUIRED'
    );
  }

  // 6. Inspect containers to be cleaned up
  const protectedContainerNames = [
    'kpanel-frontend-1',
    'kpanel-backend-1',
    'dokploy-traefik',
    'traefik',
    'n8n',
    'caddy',
    'nginx'
  ];
  const containers = Array.isArray(cleanupRequest.containers) ? cleanupRequest.containers : [];
  const recordedContainerIds = Array.isArray(cleanupRequest.recordedContainerIds) ? cleanupRequest.recordedContainerIds : [];

  const toRemoveContainers = [];
  const preservedContainers = [];
  const ambiguousContainers = [];

  for (const c of containers) {
    const cName = String(c.name || c.Names || '').trim().toLowerCase();
    const cId = String(c.id || c.Id || c.ID || '').trim();
    const cLabels = c.labels || c.Labels || {};
    const cProject = String(cLabels['com.docker.compose.project'] || c.project || '').trim().toLowerCase();
    const cRunId = String(cLabels['io.kpanel.smoke-run-id'] || c.smokeRunId || '').trim();

    // Check for protected container names
    if (protectedContainerNames.some((p) => cName.includes(p))) {
      throw new ResourceBudgetError(
        `Target container "${cName}" collides with protected production workload! Foreign containers cannot be selected for cleanup.`,
        'FOREIGN_CONTAINER_PROTECTED',
        { containerName: cName }
      );
    }

    // Check project identity
    const projectMatches = cProject === projectName;
    const runIdMatches = cRunId === smokeRunId;
    const isRecorded = recordedContainerIds.length === 0 || recordedContainerIds.includes(cId) || recordedContainerIds.includes(cName);

    // If container belongs to another project -> foreign container
    if (cProject && !projectMatches) {
      throw new ResourceBudgetError(
        `Container "${cName}" belongs to foreign project "${cProject}", not smoke project "${projectName}". Foreign containers cannot be selected for cleanup.`,
        'FOREIGN_CONTAINER_PROTECTED',
        { containerName: cName, project: cProject }
      );
    }

    // If identity or ownership is ambiguous (missing label or mismatched runId) -> fail closed / preserve
    if (!projectMatches || !runIdMatches || !isRecorded) {
      ambiguousContainers.push({
        id: cId,
        name: cName,
        reason: !projectMatches
          ? 'Project mismatch'
          : (!runIdMatches ? 'Smoke run ID mismatch or missing label' : 'Not in recorded container list')
      });
      preservedContainers.push({ id: cId, name: cName });
    } else {
      toRemoveContainers.push({ id: cId, name: cName, project: cProject, smokeRunId: cRunId });
    }
  }

  // If any container was ambiguous, fail closed to prevent accidental deletion
  if (ambiguousContainers.length > 0) {
    throw new ResourceBudgetError(
      `Ambiguous ownership detected for container(s): ${ambiguousContainers.map((a) => `${a.name} (${a.reason})`).join(', ')}. Ambiguous resources block cleanup to prevent accidental deletion.`,
      'AMBIGUOUS_OWNERSHIP_BLOCKS_CLEANUP',
      { ambiguousContainers }
    );
  }

  // 7. Inspect images: Leave images in place if exact ownership cannot be proven; never prune images
  const images = Array.isArray(cleanupRequest.images) ? cleanupRequest.images : [];
  const recordedImageIds = Array.isArray(cleanupRequest.recordedImageIds) ? cleanupRequest.recordedImageIds : [];
  const toRemoveImages = [];
  const preservedImages = [];

  for (const img of images) {
    const imgId = String(img.id || img.Id || img.name || img).trim();
    // Only remove if exact image ID was recorded and explicitly requested without pruning and proven unshared
    if (recordedImageIds.includes(imgId) && cleanupRequest.removeRecordedImages === true && !img.hasExternalReferences) {
      toRemoveImages.push(imgId);
    } else {
      preservedImages.push(imgId);
    }
  }

  return {
    authorized: true,
    operatorConfirmed: true,
    projectName,
    smokeRunId,
    removalPlan: {
      containersToRemove: toRemoveContainers,
      networksToRemove: [`${projectName}_staging_net`],
      imagesToRemove: toRemoveImages,
      imagesPreserved: preservedImages,
      preservedCount: preservedContainers.length + preservedImages.length
    },
    commands: [
      `docker compose -p "${projectName}" down`
    ]
  };
}

/**
 * Validates persistent run metadata contract for reliable recovery after SSH disconnect
 * or process interruption.
 *
 * @param {Object} metadata - Run metadata object
 * @returns {Object} Validated metadata contract
 */
const ALLOWED_EXECUTION_STATUSES = Object.freeze([
  'intent_recorded',
  'images_built',
  'containers_running',
  'verified',
  'cleaned_up',
  'aborted'
]);

function validateRunMetadataContract(metadata = {}) {
  if (!metadata || typeof metadata !== 'object') {
    throw new ResourceBudgetError('Run metadata object is required.', 'INVALID_RUN_METADATA');
  }

  const {
    projectName,
    smokeRunId,
    stagingDirectory,
    loopbackPort,
    beforeStartContainerIds,
    beforeStartContainersFile,
    baseImageReferences,
    candidateContainerId,
    ingressContainerId,
    stagingNetworkId,
    candidateImage,
    ingressImage,
    imageReferences,
    executionStatus,
    createdAt,
    updatedAt,
    timestamps
  } = metadata;

  // 1. Project name
  const cleanProject = String(projectName || '').trim().toLowerCase();
  const protectedProjects = ['kpanel', 'kpanel-clean', 'dokploy', 'n8n'];
  if (!cleanProject || cleanProject.length < 3 || !/^[a-z0-9][a-z0-9_-]+$/.test(cleanProject)) {
    throw new ResourceBudgetError(`Invalid Compose project name "${projectName}".`, 'INVALID_PROJECT_NAME');
  }
  if (protectedProjects.includes(cleanProject)) {
    throw new ResourceBudgetError(`Project name "${cleanProject}" collides with protected project.`, 'PROTECTED_PROJECT_BLOCKED');
  }

  // 2. Smoke run ID
  if (!smokeRunId || typeof smokeRunId !== 'string' || smokeRunId.trim().length < 3) {
    throw new ResourceBudgetError('Exact smoke-run ID is required in run metadata.', 'SMOKE_RUN_ID_REQUIRED');
  }

  // 3. Staging directory
  if (!stagingDirectory || typeof stagingDirectory !== 'string' || !(stagingDirectory.startsWith('/') || /^[a-zA-Z]:/.test(stagingDirectory))) {
    throw new ResourceBudgetError('Staging directory must be a valid absolute path.', 'INVALID_STAGING_DIRECTORY');
  }
  const prohibitedPaths = ['/', '/etc', '/var', '/root', '/bin', '/sbin', '/usr', '/home'];
  const lowerDir = stagingDirectory.toLowerCase();
  if (prohibitedPaths.includes(stagingDirectory) || lowerDir.includes('dokploy') || lowerDir.includes('n8n')) {
    throw new ResourceBudgetError(`Staging directory "${stagingDirectory}" is a system or production directory.`, 'FORBIDDEN_STAGING_DIRECTORY');
  }

  // 4. Loopback port
  const port = parseInt(loopbackPort, 10);
  if (isNaN(port) || port < 1024 || port > 65535) {
    throw new ResourceBudgetError(`Invalid loopback port "${loopbackPort}". High port (1024-65535) required.`, 'INVALID_LOOPBACK_PORT');
  }
  if (PROHIBITED_HOST_PORTS.includes(port)) {
    throw new ResourceBudgetError(`Port ${port} is in prohibited host ports list.`, 'PROHIBITED_HOST_PORT');
  }

  // 5. Execution Status
  const status = executionStatus ? String(executionStatus).trim().toLowerCase() : (candidateContainerId ? 'containers_running' : 'intent_recorded');
  if (!ALLOWED_EXECUTION_STATUSES.includes(status)) {
    throw new ResourceBudgetError(
      `Invalid execution status "${executionStatus}". Allowed: ${ALLOWED_EXECUTION_STATUSES.join(', ')}.`,
      'INVALID_EXECUTION_STATUS',
      { status: executionStatus, allowed: ALLOWED_EXECUTION_STATUSES }
    );
  }

  // 6. Container IDs: allowed to be null during intent_recorded or images_built phases
  if (candidateContainerId !== undefined && candidateContainerId !== null) {
    if (typeof candidateContainerId !== 'string' || !candidateContainerId.trim()) {
      throw new ResourceBudgetError('Candidate container ID must be a non-empty string when defined.', 'INVALID_CONTAINER_ID');
    }
  }
  if (ingressContainerId !== undefined && ingressContainerId !== null) {
    if (typeof ingressContainerId !== 'string' || !ingressContainerId.trim()) {
      throw new ResourceBudgetError('Ingress container ID must be a non-empty string when defined.', 'INVALID_CONTAINER_ID');
    }
  }

  // 7. Before-start container IDs and file
  if (beforeStartContainerIds !== undefined && !Array.isArray(beforeStartContainerIds)) {
    throw new ResourceBudgetError('Before-start container IDs must be an array.', 'INVALID_BEFORE_START_IDS');
  }
  if (beforeStartContainersFile !== undefined && beforeStartContainersFile !== null) {
    if (typeof beforeStartContainersFile !== 'string' || !beforeStartContainersFile.trim()) {
      throw new ResourceBudgetError('Before-start containers file path must be a valid string.', 'INVALID_BEFORE_START_FILE');
    }
  }

  // 8. Base image references
  const baseRefs = baseImageReferences || imageReferences;
  if (baseRefs !== undefined && !Array.isArray(baseRefs)) {
    throw new ResourceBudgetError('Base image references must be an array of image tags.', 'INVALID_BASE_IMAGE_REFERENCES');
  }

  const nowIso = new Date().toISOString();
  return {
    valid: true,
    metadata: {
      projectName: cleanProject,
      smokeRunId: smokeRunId.trim(),
      stagingDirectory,
      loopbackPort: port,
      executionStatus: status,
      beforeStartContainersFile: beforeStartContainersFile ? beforeStartContainersFile.trim() : null,
      beforeStartContainerIds: Array.isArray(beforeStartContainerIds) ? beforeStartContainerIds : [],
      baseImageReferences: Array.isArray(baseRefs) ? baseRefs.map(String) : ['node:20-alpine', 'nginxinc/nginx-unprivileged:alpine'],
      candidateImage: candidateImage ? String(candidateImage).trim() : `kpanel-smoke-candidate:${smokeRunId.trim()}`,
      ingressImage: ingressImage ? String(ingressImage).trim() : `kpanel-smoke-ingress:${smokeRunId.trim()}`,
      candidateContainerId: candidateContainerId ? candidateContainerId.trim() : null,
      ingressContainerId: ingressContainerId ? ingressContainerId.trim() : null,
      stagingNetworkId: stagingNetworkId ? String(stagingNetworkId).trim() : null,
      imageReferences: Array.isArray(baseRefs) ? baseRefs.map(String) : [],
      createdAt: createdAt || (timestamps?.initializedAt) || nowIso,
      updatedAt: updatedAt || nowIso,
      timestamps: timestamps || { initializedAt: createdAt || nowIso }
    }
  };
}

/**
 * Creates a durable run-intent record before the first authorized image pull, build, or container creation.
 *
 * @param {Object} params - Pre-mutation configuration
 * @returns {Object} Validated pre-mutation journal contract
 */
function createPreMutationRunJournal(params = {}) {
  const now = new Date().toISOString();
  const rawMetadata = {
    projectName: params.projectName,
    smokeRunId: params.smokeRunId,
    stagingDirectory: params.stagingDirectory,
    loopbackPort: params.loopbackPort !== undefined ? params.loopbackPort : 18080,
    beforeStartContainersFile: params.beforeStartContainersFile || null,
    beforeStartContainerIds: Array.isArray(params.beforeStartContainerIds) ? params.beforeStartContainerIds : [],
    baseImageReferences: Array.isArray(params.baseImageReferences) ? params.baseImageReferences : ['node:20-alpine', 'nginxinc/nginx-unprivileged:alpine'],
    candidateImage: params.candidateImage || `kpanel-smoke-candidate:${params.smokeRunId}`,
    ingressImage: params.ingressImage || `kpanel-smoke-ingress:${params.smokeRunId}`,
    candidateContainerId: null,
    ingressContainerId: null,
    stagingNetworkId: null,
    executionStatus: 'intent_recorded',
    createdAt: now,
    updatedAt: now
  };

  const validation = validateRunMetadataContract(rawMetadata);
  return validation.metadata;
}

/**
 * Updates an existing run metadata journal after an authorized operation
 * (e.g. build completion, container start, verification, cleanup).
 *
 * @param {Object} currentJournal - Current journal metadata object
 * @param {string} nextStatus - Next execution status
 * @param {Object} [updates] - Additional fields to merge (container IDs, network ID, etc.)
 * @returns {Object} Updated, validated journal metadata
 */
function updateRunJournalStatus(currentJournal = {}, nextStatus, updates = {}) {
  if (!currentJournal || typeof currentJournal !== 'object') {
    throw new ResourceBudgetError('Current journal object is required for status update.', 'INVALID_JOURNAL_INPUT');
  }

  const currentStatus = currentJournal.executionStatus || 'intent_recorded';
  const targetStatus = String(nextStatus || '').trim().toLowerCase();

  // Valid status transitions
  const VALID_TRANSITIONS = {
    intent_recorded: ['images_built', 'containers_running', 'cleaned_up', 'aborted'],
    images_built: ['containers_running', 'cleaned_up', 'aborted'],
    containers_running: ['verified', 'cleaned_up', 'aborted'],
    verified: ['cleaned_up', 'aborted'],
    cleaned_up: [],
    aborted: ['cleaned_up']
  };

  const allowedNext = VALID_TRANSITIONS[currentStatus] || [];
  if (!allowedNext.includes(targetStatus)) {
    throw new ResourceBudgetError(
      `Illegal run status transition from "${currentStatus}" to "${targetStatus}". Allowed: [${allowedNext.join(', ')}].`,
      'ILLEGAL_STATUS_TRANSITION',
      { currentStatus, targetStatus, allowedNext }
    );
  }

  const merged = {
    ...currentJournal,
    ...updates,
    executionStatus: targetStatus,
    updatedAt: new Date().toISOString()
  };

  const validation = validateRunMetadataContract(merged);
  return validation.metadata;
}

/**
 * Validates service-based container discovery (rejects zero, multiple, or unexpected IDs).
 *
 * @param {Object} discoveryResult - Service and discovered ID list
 * @returns {Object} Validated single container specification
 */
function validateServiceContainerDiscovery(discoveryResult = {}) {
  const { service, ids, containers } = discoveryResult;
  if (!service || (service !== 'candidate' && service !== 'ingress')) {
    throw new ResourceBudgetError(`Service must be "candidate" or "ingress" (received: "${service}").`, 'INVALID_SERVICE_NAME');
  }

  const idList = Array.isArray(ids)
    ? ids.map(s => String(s).trim()).filter(Boolean)
    : (typeof ids === 'string' && ids.trim() ? ids.trim().split(/\s+/).filter(Boolean) : []);

  if (idList.length === 0) {
    throw new ResourceBudgetError(
      `Zero container IDs discovered for service "${service}". Exactly one container expected.`,
      'ZERO_CONTAINERS_DISCOVERED',
      { service }
    );
  }

  if (idList.length > 1) {
    throw new ResourceBudgetError(
      `Multiple container IDs (${idList.length}) discovered for service "${service}": [${idList.join(', ')}]. Exactly one container expected.`,
      'MULTIPLE_CONTAINERS_DISCOVERED',
      { service, idList }
    );
  }

  const containerId = idList[0];

  // If container inspect objects are provided, verify all 3 labels separately
  if (containers && Array.isArray(containers)) {
    const matched = containers.find(c => c.id === containerId || c.Id === containerId);
    if (!matched) {
      throw new ResourceBudgetError(`Discovered container ID "${containerId}" not found in inspect list.`, 'CONTAINER_NOT_IN_INSPECT');
    }
    const labels = matched.labels || matched.Labels || {};
    const projectLabel = labels['com.docker.compose.project'];
    const serviceLabel = labels['com.docker.compose.service'];
    const runIdLabel = labels['io.kpanel.smoke-run-id'];

    if (!projectLabel || !serviceLabel || !runIdLabel) {
      throw new ResourceBudgetError(
        `Missing required labels on container "${containerId}" (project="${projectLabel}", service="${serviceLabel}", runId="${runIdLabel}").`,
        'INCOMPLETE_CONTAINER_LABELS',
        { containerId, projectLabel, serviceLabel, runIdLabel }
      );
    }
    if (serviceLabel !== service) {
      throw new ResourceBudgetError(
        `Service label mismatch on container "${containerId}": expected "${service}", found "${serviceLabel}".`,
        'SERVICE_LABEL_MISMATCH',
        { expected: service, found: serviceLabel }
      );
    }
  }

  return {
    service,
    containerId,
    verifiedSingleId: true
  };
}

/**
 * Compares exact pre-existing container IDs and states to verify 100% neighbor preservation.
 *
 * @param {Array<string>} beforeStartIds - Pre-startup container IDs
 * @param {Array<Object|string>} currentContainers - Post-cleanup active containers
 * @returns {Object} Preservation report
 */
function comparePreExistingContainerState(beforeStartIds = [], currentContainers = []) {
  if (!Array.isArray(beforeStartIds) || beforeStartIds.length === 0) {
    throw new ResourceBudgetError('Before-start container IDs array is required for comparison.', 'MISSING_BEFORE_START_IDS');
  }

  const beforeSet = new Set(beforeStartIds.map(id => String(id).trim()));
  const currentMap = new Map();

  for (const c of currentContainers) {
    const cId = String(c.id || c.Id || c.ID || c).trim();
    const cState = String(c.state || c.State || c.status || 'running').toLowerCase();
    currentMap.set(cId, cState);
  }

  const missingIds = [];
  const stoppedIds = [];

  for (const originalId of beforeSet) {
    if (!currentMap.has(originalId)) {
      missingIds.push(originalId);
    } else {
      const state = currentMap.get(originalId);
      if (state !== 'running' && !state.startsWith('up')) {
        stoppedIds.push({ id: originalId, state });
      }
    }
  }

  if (missingIds.length > 0 || stoppedIds.length > 0) {
    throw new ResourceBudgetError(
      `Pre-existing workload state mutation detected! Missing containers: [${missingIds.join(', ')}]; Non-running containers: [${stoppedIds.map(s => `${s.id}:${s.state}`).join(', ')}]. Count comparison alone is insufficient.`,
      'PRE_EXISTING_WORKLOAD_MUTATED',
      { missingIds, stoppedIds, originalCount: beforeSet.size, currentCount: currentMap.size }
    );
  }

  return {
    verified: true,
    originalCount: beforeSet.size,
    matchedRunningCount: beforeSet.size,
    preservationConfirmed: true
  };
}

/**
 * Prohibited host ports for staging loopback ingress.
 */
const PROHIBITED_HOST_PORTS = Object.freeze([
  22, 53, 80, 443, 2375, 2376, 2377, 3000, 3030, 4222, 5000, 5001, 5678, 7946, 4789, 8080, 9000, 9443
]);

/**
 * Comprehensive Staging Resource Preflight Evaluation.
 * Evaluates host memory, disk headroom, CPU/RAM budgets, combined staging capacity,
 * host load, occupied loopback port, Docker daemon, Docker Compose, and ARM64 compatibility.
 *
 * @param {Object} hostMetrics - Current host metrics and state
 * @param {Object} [options] - Evaluation options and requested staging parameters
 * @returns {Object} Comprehensive resource preflight report
 */
function evaluateStagingResourcePreflight(hostMetrics = {}, options = {}) {
  const checks = [];
  const blockers = [];
  const warnings = [];

  function recordCheck(code, passed, message, meta = {}) {
    checks.push({ code, passed, message, ...meta });
    if (!passed) {
      blockers.push({ code, message, ...meta });
    }
  }

  // 1. Candidate Resource Limits & Clamping Verification
  let candidateBudget;
  try {
    candidateBudget = validateCandidateResourceBudget(
      {
        cpuLimit: options.candidateCpu !== undefined ? options.candidateCpu : DEFAULT_RESOURCE_BUDGET.candidateDefaultCpu,
        memoryLimitMb: options.candidateMemoryMb !== undefined ? options.candidateMemoryMb : DEFAULT_RESOURCE_BUDGET.candidateDefaultMemoryMb
      },
      options
    );
    recordCheck(
      'CANDIDATE_RESOURCE_LIMITS',
      true,
      `Candidate limits verified (${candidateBudget.cpuLimit} CPU, ${candidateBudget.memoryLimitMb} MB RAM).`,
      candidateBudget
    );
  } catch (err) {
    recordCheck('CANDIDATE_RESOURCE_LIMITS', false, err.message, { code: err.code });
    if (options.throwOnError) throw err;
  }

  // 2. Ingress Resource Limits Verification
  const ingressCpu = options.ingressCpu !== undefined ? Number(options.ingressCpu) : DEFAULT_RESOURCE_BUDGET.ingressCpu;
  const ingressMemoryMb = options.ingressMemoryMb !== undefined ? Number(options.ingressMemoryMb) : DEFAULT_RESOURCE_BUDGET.ingressMemoryMb;
  const isIngressCpuSafe = !isNaN(ingressCpu) && ingressCpu > 0 && ingressCpu <= 0.5;
  const isIngressMemSafe = !isNaN(ingressMemoryMb) && ingressMemoryMb >= 64 && ingressMemoryMb <= 256;

  recordCheck(
    'INGRESS_RESOURCE_LIMITS',
    isIngressCpuSafe && isIngressMemSafe,
    isIngressCpuSafe && isIngressMemSafe
      ? `Ingress limits verified (${ingressCpu} CPU, ${ingressMemoryMb} MB RAM).`
      : `Ingress resource limits exceed policy ceiling (max 0.5 CPU, 256 MB RAM; got ${ingressCpu} CPU, ${ingressMemoryMb} MB).`
  );

  // 3. Combined Budget Calculation
  const combinedCpu = (candidateBudget ? candidateBudget.cpuLimit : 1.0) + (isIngressCpuSafe ? ingressCpu : 0.5);
  const combinedMemoryMb = (candidateBudget ? candidateBudget.memoryLimitMb : 1024) + (isIngressMemSafe ? ingressMemoryMb : 256);
  recordCheck(
    'COMBINED_STAGING_BUDGET',
    combinedCpu <= 2.5 && combinedMemoryMb <= 4352,
    `Combined staging budget: ${combinedCpu} CPU, ${combinedMemoryMb} MB RAM.`,
    { combinedCpu, combinedMemoryMb }
  );

  // 4. Host Available Memory & Headroom Protection (8 GB reserved for OS + 45 existing workloads)
  const availableMemBytes = hostMetrics.availableMemoryBytes !== undefined ? Number(hostMetrics.availableMemoryBytes) : hostMetrics.availableMemory;
  const reservedSystemMemoryMb = options.reservedSystemMemoryMb || DEFAULT_RESOURCE_BUDGET.reservedSystemMemoryMb;
  const requiredTotalMemMb = reservedSystemMemoryMb + combinedMemoryMb;
  const requiredTotalMemBytes = requiredTotalMemMb * 1024 * 1024;

  if (availableMemBytes !== undefined && !isNaN(availableMemBytes)) {
    const availableMemMb = Math.round(availableMemBytes / (1024 * 1024));
    const hasMemHeadroom = availableMemBytes >= requiredTotalMemBytes;
    recordCheck(
      'MEMORY_HEADROOM_PROTECTION',
      hasMemHeadroom,
      hasMemHeadroom
        ? `Sufficient host memory available (${availableMemMb} MB free >= ${requiredTotalMemMb} MB required [${reservedSystemMemoryMb} MB reserved + ${combinedMemoryMb} MB staging]).`
        : `Insufficient host memory: ${availableMemMb} MB available is below safety floor of ${requiredTotalMemMb} MB (${reservedSystemMemoryMb} MB reserved for OS/workloads + ${combinedMemoryMb} MB staging).`,
      { availableMemMb, requiredTotalMemMb, reservedSystemMemoryMb }
    );
  } else {
    warnings.push({
      code: 'MEMORY_METRICS_UNAVAILABLE',
      message: 'Host available memory metrics not provided in preflight check.'
    });
  }

  // 5. Host Available Root Disk Space
  const availableDiskBytes = hostMetrics.availableDiskBytes !== undefined ? Number(hostMetrics.availableDiskBytes) : hostMetrics.freeDiskBytes;
  const purpose = options.purpose || 'stage';
  if (availableDiskBytes !== undefined && !isNaN(availableDiskBytes)) {
    try {
      const diskReport = evaluateDiskHeadroom(availableDiskBytes, purpose, options);
      recordCheck(
        'DISK_HEADROOM_PROTECTION',
        diskReport.safe,
        `Host disk headroom safe for ${purpose} (${diskReport.availableMb} MB free >= ${diskReport.requiredMb} MB floor).`,
        diskReport
      );
    } catch (diskErr) {
      recordCheck('DISK_HEADROOM_PROTECTION', false, diskErr.message, { code: diskErr.code });
      if (options.throwOnError) throw diskErr;
    }
  } else {
    warnings.push({
      code: 'DISK_METRICS_UNAVAILABLE',
      message: 'Host available disk metrics not provided in preflight check.'
    });
  }

  // 6. Host Load Assessment (4-OCPU host)
  const ocpuCount = hostMetrics.ocpuCount || OBSERVED_HOST_CAPACITY.ocpuCount;
  const loadAverage = hostMetrics.loadAverage;
  if (loadAverage) {
    const load1m = Array.isArray(loadAverage) ? Number(loadAverage[0]) : Number(loadAverage);
    const maxSafeLoad = ocpuCount * 2.0; // 8.0 on 4-OCPU
    if (!isNaN(load1m)) {
      if (load1m > maxSafeLoad) {
        warnings.push({
          code: 'HIGH_HOST_LOAD',
          message: `Current host 1-minute load average (${load1m.toFixed(2)}) exceeds recommended threshold (${maxSafeLoad.toFixed(2)}) on ${ocpuCount}-OCPU system.`
        });
      }
      recordCheck(
        'HOST_LOAD_SAFE',
        load1m <= maxSafeLoad,
        `Host 1m load average is ${load1m.toFixed(2)} (ceiling: ${maxSafeLoad.toFixed(2)} for ${ocpuCount} OCPU).`,
        { load1m, ocpuCount, maxSafeLoad }
      );
    }
  }

  // 7. Loopback Port Availability & Prohibited Port Check
  const loopbackPort = options.loopbackPort !== undefined ? Number(options.loopbackPort) : undefined;
  if (loopbackPort !== undefined) {
    if (isNaN(loopbackPort) || loopbackPort < 1024 || loopbackPort > 65535) {
      recordCheck(
        'LOOPBACK_PORT_VALIDITY',
        false,
        `Loopback port ${loopbackPort} is invalid. High port between 1024 and 65535 required.`
      );
    } else if (PROHIBITED_HOST_PORTS.includes(loopbackPort)) {
      recordCheck(
        'LOOPBACK_PORT_NOT_PROHIBITED',
        false,
        `Port ${loopbackPort} is a reserved system or known service port. Staging ingress must use an unreserved high port.`
      );
    } else {
      const occupied = Array.isArray(hostMetrics.occupiedPorts) ? hostMetrics.occupiedPorts : [];
      const isOccupied = occupied.includes(loopbackPort);
      recordCheck(
        'LOOPBACK_PORT_FREE',
        !isOccupied,
        !isOccupied
          ? `Loopback port ${loopbackPort} is free and unreserved.`
          : `Loopback port ${loopbackPort} is already occupied by another service on the host.`
      );
    }
  } else {
    warnings.push({
      code: 'LOOPBACK_PORT_UNSPECIFIED',
      message: 'Operator must specify and verify an unreserved loopback port (e.g. 18080) before execution.'
    });
  }

  // 8. Docker Daemon Availability
  if (hostMetrics.dockerAvailable !== undefined) {
    recordCheck(
      'DOCKER_DAEMON_AVAILABLE',
      Boolean(hostMetrics.dockerAvailable),
      hostMetrics.dockerAvailable ? 'Docker daemon is active and responsive.' : 'Docker daemon is unavailable or unresponsive.'
    );
  }

  // 9. Docker Compose Availability
  if (hostMetrics.composeAvailable !== undefined) {
    recordCheck(
      'DOCKER_COMPOSE_AVAILABLE',
      Boolean(hostMetrics.composeAvailable),
      hostMetrics.composeAvailable ? 'Docker Compose plugin/CLI is available.' : 'Docker Compose is not installed or unavailable.'
    );
  }

  // 10. Architecture Compatibility (ARM64 / aarch64)
  const hostArch = (hostMetrics.hostArch || hostMetrics.arch || 'arm64').toLowerCase();
  const imageArch = (options.imageArch || options.candidateArch || hostArch).toLowerCase();
  const isArm64Host = hostArch === 'arm64' || hostArch === 'aarch64';
  const isImageArm64Compatible = imageArch === 'arm64' || imageArch === 'aarch64' || imageArch === 'multi-arch';

  recordCheck(
    'ARM64_COMPATIBILITY',
    isImageArm64Compatible,
    isImageArm64Compatible
      ? `Image architecture "${imageArch}" is compatible with target host "${hostArch}".`
      : `Image architecture "${imageArch}" is incompatible with target ARM64 host "${hostArch}".`,
    { hostArch, imageArch }
  );

  // 11. Global Pruning Prohibition Invariant
  recordCheck(
    'GLOBAL_PRUNING_PROHIBITED',
    true,
    'Automated global Docker pruning (system/volume/builder prune) is strictly prohibited on shared host.'
  );

  const passed = blockers.length === 0;
  if (!passed && options.throwOnError) {
    throw new ResourceBudgetError(
      `Resource preflight failed: ${blockers.map((b) => b.message).join('; ')}`,
      blockers[0]?.code || 'RESOURCE_PREFLIGHT_FAILED',
      { blockers, warnings }
    );
  }

  return {
    passed,
    decision: passed ? 'RESOURCE_PREFLIGHT_PASSED' : 'RESOURCE_PREFLIGHT_BLOCKED',
    checks,
    blockers,
    warnings,
    combinedBudget: {
      cpuLimit: combinedCpu,
      memoryLimitMb: combinedMemoryMb,
      candidate: candidateBudget,
      ingress: { cpu: ingressCpu, memoryMb: ingressMemoryMb }
    },
    hostCapacity: OBSERVED_HOST_CAPACITY
  };
}

module.exports = {
  OBSERVED_HOST_CAPACITY,
  DEFAULT_RESOURCE_BUDGET,
  PROHIBITED_HOST_PORTS,
  validateCandidateResourceBudget,
  evaluateDiskHeadroom,
  enforceBuildConcurrency,
  validatePruneCommandSafety,
  validateSmokeCleanupPlan,
  validateRunMetadataContract,
  createPreMutationRunJournal,
  updateRunJournalStatus,
  validateServiceContainerDiscovery,
  comparePreExistingContainerState,
  evaluateStagingResourcePreflight,
  ResourceBudgetError
};
