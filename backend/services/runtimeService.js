const Docker = require('dockerode');
const { getDatabase } = require('../config/database');
const deploymentLeaseService = require('./deploymentLeaseService');

/**
 * Structured service error class for Runtime Candidate operations.
 */
class RuntimeServiceError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'RuntimeServiceError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Resolves or injects the Dockerode client instance.
 * Allows dependency injection for offline tests without accessing /var/run/docker.sock.
 */
function getDockerClient(options = {}) {
  if (options.docker) {
    return options.docker;
  }
  const socketPath = options.socketPath || process.env.DOCKER_SOCKET_PATH || '/var/run/docker.sock';
  return new Docker({ socketPath });
}

/**
 * Returns true if server-side runtime container execution is enabled via environment variable.
 */
function isRuntimeExecutionEnabled() {
  return process.env.KPANEL_RUNTIME_EXECUTION_ENABLED === 'true';
}

/**
 * Formats deterministic K-Panel candidate container name.
 */
function getDeterministicContainerName(deploymentId) {
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new RuntimeServiceError('Valid deployment ID is required to determine container name.', 'INVALID_DEPLOYMENT_ID');
  }
  return `kpanel-candidate-${deploymentId.trim()}`;
}

/**
 * Verifies active global worker execution lease and fencing token in SQLite.
 * Fails closed if the caller does not hold the active lease.
 */
function verifyActiveWorkerLease(ownerId, fencingToken, db) {
  const cleanOwner = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);

  if (!cleanOwner || isNaN(tokenNum)) {
    throw new RuntimeServiceError('Owner ID and numeric fencing token are required.', 'LEASE_LOST');
  }

  const lockRow = db.prepare(`
    SELECT owner_id, fencing_token,
           CAST(strftime('%s', 'now') AS INTEGER) as now_epoch,
           CAST(strftime('%s', lease_expires_at) AS INTEGER) as exp_epoch
    FROM deployment_worker_lock
    WHERE lock_name = ?
  `).get(deploymentLeaseService.GLOBAL_LOCK_NAME);

  if (
    !lockRow ||
    lockRow.owner_id !== cleanOwner ||
    Number(lockRow.fencing_token) !== tokenNum ||
    lockRow.now_epoch >= lockRow.exp_epoch
  ) {
    throw new RuntimeServiceError(
      'Worker lost global execution lease or fencing token is invalid/expired.',
      'LEASE_LOST'
    );
  }

  return lockRow;
}

/**
 * Validates and sanitizes runtime environment variables.
 * Strictly prevents forwarding backend process secrets, keys, or sensitive credentials.
 */
function buildSanitizedRuntimeEnvironment(appEnv = {}, options = {}) {
  const forbiddenPatterns = [
    /token/i,
    /secret/i,
    /key/i,
    /password/i,
    /auth/i,
    /database_url/i,
    /kpanel_/i,
    /github_/i
  ];

  const envList = [];

  // Default container environment
  const defaults = {
    NODE_ENV: 'production',
    PORT: String(options.port || 3000)
  };

  const combined = { ...defaults, ...(appEnv || {}) };

  for (const [key, val] of Object.entries(combined)) {
    if (!key || typeof key !== 'string') continue;
    const cleanKey = key.trim();
    if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(cleanKey)) {
      throw new RuntimeServiceError(`Invalid environment variable name "${cleanKey}".`, 'INVALID_ENVIRONMENT_VARIABLE');
    }

    // Check for leak of backend infrastructure credentials
    const isForbiddenSystemSecret = forbiddenPatterns.some((pattern) => pattern.test(cleanKey));
    if (isForbiddenSystemSecret && !options.allowExplicitSecrets) {
      // Skip system-forbidden credential variables
      continue;
    }

    const cleanVal = String(val !== undefined && val !== null ? val : '');
    if (cleanVal.length > 8192) {
      throw new RuntimeServiceError(`Environment variable "${cleanKey}" exceeds maximum length of 8192 characters.`, 'INVALID_ENVIRONMENT_VARIABLE');
    }

    envList.push(`${cleanKey}=${cleanVal}`);
  }

  return envList;
}

/**
 * Validates the runtime configuration prerequisites for a built deployment.
 * Validates deployment status, immutable build artifact, image identity, staging network, and resources.
 *
 * @param {Object} input - { deploymentId, applicationId, stagingNetworkId }
 * @param {Object} [options] - Options ({ db, docker, ... })
 * @returns {Promise<Object>} Validated runtime configuration
 */
async function validateRuntimeConfiguration(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new RuntimeServiceError('Runtime configuration input object is required.', 'INVALID_INPUT');
  }

  const { deploymentId, applicationId } = input;
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new RuntimeServiceError('Valid deployment ID is required.', 'INVALID_DEPLOYMENT_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanDeploymentId = deploymentId.trim();

  // 1. Verify Deployment Record exists and is strictly in 'built' status
  const deployment = db.prepare(`
    SELECT id, application_id, commit_sha, status, image_tag, image_id
    FROM deployments
    WHERE id = ?
  `).get(cleanDeploymentId);

  if (!deployment) {
    throw new RuntimeServiceError(`Deployment "${cleanDeploymentId}" not found.`, 'DEPLOYMENT_NOT_FOUND');
  }

  if (deployment.status !== 'built') {
    throw new RuntimeServiceError(
      `Deployment "${cleanDeploymentId}" is in status "${deployment.status}". Only "built" deployments are eligible for candidate execution.`,
      'INVALID_DEPLOYMENT_STATUS'
    );
  }

  if (applicationId && deployment.application_id !== applicationId) {
    throw new RuntimeServiceError(
      `Deployment applicationId "${deployment.application_id}" does not match requested applicationId "${applicationId}".`,
      'APPLICATION_ID_MISMATCH'
    );
  }

  // 2. Verify Application Record exists
  const application = db.prepare(`
    SELECT id, name, slug, port, cpu_limit, memory_limit_mb
    FROM applications
    WHERE id = ?
  `).get(deployment.application_id);

  if (!application) {
    throw new RuntimeServiceError(`Application "${deployment.application_id}" not found.`, 'APPLICATION_NOT_FOUND');
  }

  // 3. Verify Durable Build Artifact exists
  const artifact = deploymentLeaseService.getDeploymentArtifact(cleanDeploymentId, { db });
  if (!artifact) {
    throw new RuntimeServiceError(
      `No durable build artifact record found for deployment "${cleanDeploymentId}".`,
      'ARTIFACT_NOT_FOUND'
    );
  }

  if (artifact.application_id !== deployment.application_id) {
    throw new RuntimeServiceError('Artifact application_id does not match deployment.', 'ARTIFACT_INTEGRITY_MISMATCH');
  }

  if (artifact.commit_sha.toLowerCase() !== (deployment.commit_sha || '').toLowerCase()) {
    throw new RuntimeServiceError('Artifact commit_sha does not match deployment.', 'ARTIFACT_INTEGRITY_MISMATCH');
  }

  const cleanImageId = String(artifact.image_id || '').trim().toLowerCase();
  if (!/^sha256:[a-f0-9]{64}$/i.test(cleanImageId)) {
    throw new RuntimeServiceError('Artifact image_id must be a valid sha256 hex digest.', 'INVALID_IMAGE_ID');
  }

  // 4. Staging Network Resolution and Verification (Fail-Closed)
  const stagingNetworkId = String(
    input.stagingNetworkId || options.stagingNetworkId || process.env.KPANEL_STAGING_NETWORK_ID || ''
  ).trim();

  if (!stagingNetworkId) {
    throw new RuntimeServiceError(
      'Dedicated staging network ID is not configured (KPANEL_STAGING_NETWORK_ID is required).',
      'STAGING_NETWORK_NOT_CONFIGURED'
    );
  }

  // Verify staging network via Docker client
  const docker = getDockerClient(options);
  let networkInspect;
  try {
    const network = docker.getNetwork(stagingNetworkId);
    networkInspect = await network.inspect();
  } catch (netErr) {
    throw new RuntimeServiceError(
      `Dedicated staging network "${stagingNetworkId}" verification failed: ${netErr.message}`,
      'STAGING_NETWORK_INVALID'
    );
  }

  if (!networkInspect || (networkInspect.Driver !== 'bridge' && networkInspect.Driver !== 'internal')) {
    throw new RuntimeServiceError(
      `Dedicated staging network must use a bridge or internal driver (found driver: "${networkInspect?.Driver}").`,
      'STAGING_NETWORK_UNSAFE'
    );
  }

  const netName = String(networkInspect.Name || '').toLowerCase().trim();
  const netId = String(networkInspect.Id || '').toLowerCase().trim();
  const prohibitedNames = ['coolify', 'traefik', 'traefik-public', 'dokploy', 'dokploy-network', 'n8n', 'proxy', 'web', 'host', 'none', 'bridge'];
  const isDefaultBridge = netName === 'bridge' || netId === 'bridge' || Boolean(networkInspect.Options?.['com.docker.network.bridge.default_bridge'] === 'true');
  const isForeignWorkload = prohibitedNames.includes(netName) ||
    netName.includes('coolify') ||
    netName.includes('dokploy') ||
    netName.includes('traefik') ||
    netName.includes('n8n');

  if (isDefaultBridge || isForeignWorkload || networkInspect.Driver === 'host') {
    throw new RuntimeServiceError(
      `Staging network "${stagingNetworkId}" violates staging isolation policy: attachment to default bridge, host network, or foreign/production proxy networks is strictly prohibited.`,
      'STAGING_NETWORK_UNSAFE'
    );
  }

  // Operator-approved network identity check
  const envStagingNet = (process.env.KPANEL_STAGING_NETWORK_ID || '').trim();
  if (envStagingNet && stagingNetworkId !== envStagingNet && netName !== envStagingNet.toLowerCase()) {
    throw new RuntimeServiceError(
      `Staging network "${stagingNetworkId}" does not match operator-approved KPANEL_STAGING_NETWORK_ID ("${envStagingNet}").`,
      'STAGING_NETWORK_UNSAFE'
    );
  }

  // Explicit assessment of Internal property
  const isInternal = Boolean(networkInspect.Internal);
  if (options.requireInternalNetwork === true && !isInternal) {
    throw new RuntimeServiceError(
      `Dedicated staging network "${stagingNetworkId}" is not internal (Internal: false).`,
      'STAGING_NETWORK_POLICY_VIOLATION'
    );
  }

  // 5. Image Inspection & Identity Validation via Docker
  let imageInspect;
  try {
    const image = docker.getImage(cleanImageId);
    imageInspect = await image.inspect();
  } catch (imgErr) {
    throw new RuntimeServiceError(
      `Docker image inspection failed for image ID "${cleanImageId}": ${imgErr.message}`,
      'IMAGE_INSPECT_FAILED'
    );
  }

  const inspectedImageId = String(imageInspect.Id || '').trim().toLowerCase();
  if (inspectedImageId !== cleanImageId && !inspectedImageId.includes(cleanImageId.replace('sha256:', ''))) {
    throw new RuntimeServiceError(
      `Inspected Docker image ID "${inspectedImageId}" does not match trusted build artifact ID "${cleanImageId}".`,
      'IMAGE_ID_MISMATCH'
    );
  }

  // Verify non-root user policy: check image Config.User
  // Frontend/input cannot bypass non-root policy (input.allowRootUser is strictly ignored).
  // Root execution requires explicit trusted operator authorization via options.trustedOperatorAllowRoot or options.allowRootUser.
  const imageUser = imageInspect.Config?.User || '';
  const isRootUser = !imageUser || imageUser === '0' || imageUser === 'root';
  const operatorAllowRoot = options.trustedOperatorAllowRoot === true || options.allowRootUser === true;
  if (isRootUser && !operatorAllowRoot) {
    throw new RuntimeServiceError(
      'Image specifies root user execution without explicit trusted operator authorization.',
      'ROOT_USER_PROHIBITED'
    );
  }

  // 6. Safe Bounded Resource Calculations with Operator Budget Governance
  // Target host has 4 OCPU / 24 GB RAM. Conservative operator budget applies.
  const maxCpuBudget = Number(options.operatorMaxCpu || process.env.KPANEL_MAX_CPU_LIMIT || 2.0);
  const maxMemBudget = Number(options.operatorMaxMemoryMb || process.env.KPANEL_MAX_MEMORY_LIMIT_MB || 4096);

  const rawCpu = application.cpu_limit !== undefined && application.cpu_limit !== null ? application.cpu_limit : 1.0;
  if (Number(rawCpu) > maxCpuBudget) {
    throw new RuntimeServiceError(
      `Application CPU limit (${rawCpu} cores) exceeds operator-configured maximum CPU budget (${maxCpuBudget} cores) on 4-OCPU host.`,
      'RESOURCE_LIMIT_EXCEEDED',
      { requested: rawCpu, maxBudget: maxCpuBudget }
    );
  }
  const clampedCpu = Math.max(0.1, Math.min(maxCpuBudget, Number(rawCpu)));
  const nanoCpus = Math.round(clampedCpu * 1e9);

  const rawMem = application.memory_limit_mb || 1024;
  if (Number(rawMem) > maxMemBudget) {
    throw new RuntimeServiceError(
      `Application memory limit (${rawMem} MB) exceeds operator-configured maximum memory budget (${maxMemBudget} MB).`,
      'RESOURCE_LIMIT_EXCEEDED',
      { requested: rawMem, maxBudget: maxMemBudget }
    );
  }
  const clampedMemMb = Math.max(64, Math.min(maxMemBudget, Number(rawMem)));
  const memoryBytes = clampedMemMb * 1024 * 1024;

  const containerPort = application.port || 3000;

  return {
    deploymentId: cleanDeploymentId,
    applicationId: deployment.application_id,
    applicationName: application.name,
    commitSha: artifact.commit_sha,
    imageId: cleanImageId,
    imageTag: artifact.image_tag,
    containerName: getDeterministicContainerName(cleanDeploymentId),
    stagingNetworkId,
    stagingNetworkInternal: isInternal,
    stagingNetworkDriver: networkInspect.Driver,
    containerPort,
    nanoCpus,
    memoryBytes,
    operatorMaxCpu: maxCpuBudget,
    operatorMaxMemoryMb: maxMemBudget,
    imageInspect,
    hasHealthcheck: Boolean(imageInspect.Config?.Healthcheck)
  };
}

/**
 * Creates and stages an isolated candidate container for a verified built deployment.
 * Strictly gated by KPANEL_RUNTIME_EXECUTION_ENABLED and options.executeRuntime.
 *
 * @param {Object} input - { deploymentId, applicationId, stagingNetworkId, ownerId, fencingToken, ... }
 * @param {Object} [options] - Options ({ db, docker, executeRuntime, ... })
 * @returns {Promise<Object>} Candidate creation details
 */
async function prepareCandidateContainer(input, options = {}) {
  // 1. Mandatory Dual Execution Gate Check
  const isEnvEnabled = isRuntimeExecutionEnabled();
  const isCallerEnabled = options.executeRuntime === true;
  const canExecute = isEnvEnabled && isCallerEnabled;

  if (!canExecute) {
    throw new RuntimeServiceError(
      'Runtime candidate execution is disabled. Requires BOTH process.env.KPANEL_RUNTIME_EXECUTION_ENABLED=true AND options.executeRuntime=true.',
      'RUNTIME_DISABLED',
      {
        isEnvEnabled,
        isCallerEnabled
      }
    );
  }

  const db = options.db || getDatabase(options);
  const cleanOwnerId = String(input.ownerId || options.ownerId || '').trim();
  const tokenNum = parseInt(input.fencingToken !== undefined ? input.fencingToken : options.fencingToken, 10);

  // 2. Fencing Token & Worker Lease Verification
  verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // Early candidate labels verification: strictly prohibit Traefik exposure or routing rules
  const candidateLabels = options.labels || input.labels;
  if (candidateLabels && typeof candidateLabels === 'object') {
    for (const [k, v] of Object.entries(candidateLabels)) {
      if (k.toLowerCase().startsWith('traefik.') || (k.toLowerCase() === 'traefik.enable' && String(v).toLowerCase() === 'true')) {
        throw new RuntimeServiceError(
          'Staging candidate labels cannot request Traefik exposure or routing rules.',
          'TRAEFIK_EXPOSURE_PROHIBITED'
        );
      }
    }
  }

  // 3. Validate Runtime Configuration
  const config = await validateRuntimeConfiguration(input, options);
  const docker = getDockerClient(options);

  // 4. Check for existing container with the deterministic candidate name
  let existingContainerInspect = null;
  try {
    const existing = docker.getContainer(config.containerName);
    existingContainerInspect = await existing.inspect();
  } catch (err) {
    // Container does not exist - creation may proceed
    existingContainerInspect = null;
  }

  if (existingContainerInspect) {
    const existingLabels = existingContainerInspect.Config?.Labels || {};
    const existingDeploymentId = existingLabels['io.kpanel.deployment-id'];
    const existingAppId = existingLabels['io.kpanel.application-id'];
    const existingImageId = String(existingContainerInspect.Image || '').toLowerCase();

    const isMatchingCandidate =
      existingLabels['io.kpanel.managed'] === 'true' &&
      existingLabels['io.kpanel.role'] === 'candidate' &&
      existingDeploymentId === config.deploymentId &&
      existingAppId === config.applicationId;

    if (!isMatchingCandidate) {
      throw new RuntimeServiceError(
        `Conflicting Docker container "${config.containerName}" already exists but belongs to a different deployment or application. Cannot overwrite or adopt unrelated container.`,
        'CONTAINER_NAME_CONFLICT',
        { existingContainerId: existingContainerInspect.Id }
      );
    }

    // Reconcile existing matching candidate container (crash recovery / idempotency)
    verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

    db.prepare(`
      INSERT INTO deployment_runtime_candidates (
        deployment_id, application_id, image_id, container_id, container_name,
        staging_network_id, candidate_state, health_status, last_checked_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(deployment_id) DO UPDATE SET
        container_id = excluded.container_id,
        candidate_state = excluded.candidate_state,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      config.deploymentId,
      config.applicationId,
      config.imageId,
      existingContainerInspect.Id,
      config.containerName,
      config.stagingNetworkId,
      existingContainerInspect.State?.Running ? 'starting' : 'created',
      'unknown'
    );

    return {
      reconciled: true,
      created: false,
      deploymentId: config.deploymentId,
      applicationId: config.applicationId,
      containerId: existingContainerInspect.Id,
      containerName: config.containerName,
      stagingNetworkId: config.stagingNetworkId,
      candidateState: existingContainerInspect.State?.Running ? 'starting' : 'created',
      hasHealthcheck: config.hasHealthcheck
    };
  }

  // 5. Construct Conservative, Isolated Docker Create Options
  const sanitizedEnv = buildSanitizedRuntimeEnvironment(options.env || {}, {
    port: config.containerPort,
    allowExplicitSecrets: options.allowExplicitSecrets
  });

  const createOptions = {
    name: config.containerName,
    Image: config.imageId,
    ExposedPorts: {
      [`${config.containerPort}/tcp`]: {}
    },
    Env: sanitizedEnv,
    Labels: {
      'traefik.enable': 'false', // STRICT: Explicit opt-out from Traefik exposure
      'io.kpanel.managed': 'true',
      'io.kpanel.role': 'candidate',
      'io.kpanel.application-id': config.applicationId,
      'io.kpanel.deployment-id': config.deploymentId,
      'io.kpanel.commit-sha': config.commitSha,
      'io.kpanel.image-id': config.imageId
    },
    HostConfig: {
      NetworkMode: config.stagingNetworkId,
      PortBindings: {}, // STRICT: Zero published host ports
      PublishAllPorts: false, // STRICT: No automatic port exposure
      Privileged: false, // STRICT: No privileged execution
      CapDrop: ['ALL'], // Drop all kernel capabilities
      SecurityOpt: ['no-new-privileges:true'], // Prevent privilege escalation
      Memory: config.memoryBytes,
      NanoCpus: config.nanoCpus,
      PidsLimit: 256,
      RestartPolicy: { Name: 'no' }, // No auto-restart for staging candidates
      Binds: [], // STRICT: No host volume or Docker socket mounts
      LogConfig: {
        Type: 'json-file',
        Config: {
          'max-size': '10m',
          'max-file': '3'
        }
      },
      ReadonlyRootfs: Boolean(options.readOnlyRootfs),
      Tmpfs: {
        '/tmp': 'rw,noexec,nosuid,size=64m'
      }
    }
  };

  // 6. Create the Container in Docker
  let container;
  try {
    container = await docker.createContainer(createOptions);
  } catch (err) {
    throw new RuntimeServiceError(`Failed to create candidate Docker container: ${err.message}`, 'CONTAINER_CREATE_FAILED');
  }

  // 7. Verify Worker Lease one final time before persisting state to database
  try {
    verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
  } catch (leaseErr) {
    // Worker lost lease after create; do not persist state
    throw leaseErr;
  }

  // 8. Persist Candidate Metadata to SQLite
  db.prepare(`
    INSERT INTO deployment_runtime_candidates (
      deployment_id, application_id, image_id, container_id, container_name,
      staging_network_id, candidate_state, health_status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, 'created', 'unknown', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
    ON CONFLICT(deployment_id) DO UPDATE SET
      container_id = excluded.container_id,
      container_name = excluded.container_name,
      staging_network_id = excluded.staging_network_id,
      candidate_state = 'created',
      updated_at = CURRENT_TIMESTAMP
  `).run(
    config.deploymentId,
    config.applicationId,
    config.imageId,
    container.id,
    config.containerName,
    config.stagingNetworkId
  );

  return {
    created: true,
    reconciled: false,
    deploymentId: config.deploymentId,
    applicationId: config.applicationId,
    containerId: container.id,
    containerName: config.containerName,
    stagingNetworkId: config.stagingNetworkId,
    candidateState: 'created',
    hasHealthcheck: config.hasHealthcheck
  };
}

/**
 * Starts an isolated candidate container.
 * Strictly gated by execution controls and worker lease fencing.
 *
 * @param {string} deploymentId - Deployment UUID
 * @param {Object} [options] - Options ({ db, docker, ownerId, fencingToken, executeRuntime, ... })
 * @returns {Promise<Object>} Start result
 */
async function startCandidateContainer(deploymentId, options = {}) {
  // 1. Mandatory Dual Execution Gate Check
  if (!isRuntimeExecutionEnabled() || options.executeRuntime !== true) {
    throw new RuntimeServiceError(
      'Runtime candidate execution is disabled. Requires BOTH process.env.KPANEL_RUNTIME_EXECUTION_ENABLED=true AND options.executeRuntime=true.',
      'RUNTIME_DISABLED'
    );
  }

  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new RuntimeServiceError('Valid deployment ID is required to start candidate.', 'INVALID_DEPLOYMENT_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanDeploymentId = deploymentId.trim();
  const cleanOwnerId = String(options.ownerId || '').trim();
  const tokenNum = parseInt(options.fencingToken, 10);

  // 2. Fencing Token & Worker Lease Verification
  verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // 3. Retrieve Candidate Record
  const candidate = db.prepare(`
    SELECT * FROM deployment_runtime_candidates WHERE deployment_id = ?
  `).get(cleanDeploymentId);

  if (!candidate || !candidate.container_id) {
    throw new RuntimeServiceError(
      `No staged runtime candidate container found for deployment "${cleanDeploymentId}". Prepare container first.`,
      'CANDIDATE_NOT_FOUND'
    );
  }

  const docker = getDockerClient(options);
  const container = docker.getContainer(candidate.container_id);

  // 4. Inspect container before start to verify labels and ownership
  let inspectData;
  try {
    inspectData = await container.inspect();
  } catch (err) {
    throw new RuntimeServiceError(
      `Failed to inspect candidate container "${candidate.container_id}": ${err.message}`,
      'CONTAINER_INSPECT_FAILED'
    );
  }

  const labels = inspectData.Config?.Labels || {};
  if (
    labels['io.kpanel.managed'] !== 'true' ||
    labels['io.kpanel.role'] !== 'candidate' ||
    labels['io.kpanel.deployment-id'] !== cleanDeploymentId
  ) {
    throw new RuntimeServiceError(
      `Container "${candidate.container_id}" failed K-Panel ownership verification. Cannot start unverified container.`,
      'CONTAINER_OWNERSHIP_INVALID'
    );
  }

  // 5. Start Container (Idempotent: if already running, treat as started)
  if (!inspectData.State?.Running) {
    try {
      await container.start();
    } catch (err) {
      throw new RuntimeServiceError(`Failed to start candidate container: ${err.message}`, 'CONTAINER_START_FAILED');
    }
  }

  // 6. Verify Worker Lease before updating state in database
  verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // 7. Update candidate state in database
  db.prepare(`
    UPDATE deployment_runtime_candidates
    SET candidate_state = 'starting',
        started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
        last_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE deployment_id = ?
  `).run(cleanDeploymentId);

  return {
    started: true,
    deploymentId: cleanDeploymentId,
    containerId: candidate.container_id,
    containerName: candidate.container_name,
    candidateState: 'starting'
  };
}

/**
 * Inspects candidate container state from Docker without side effects.
 *
 * @param {string} containerId - Docker Container ID
 * @param {Object} [options] - Options ({ docker, ... })
 * @returns {Promise<Object>} Formatted container state
 */
async function inspectCandidateContainer(containerId, options = {}) {
  if (!containerId || typeof containerId !== 'string') {
    throw new RuntimeServiceError('Valid container ID is required for inspection.', 'INVALID_CONTAINER_ID');
  }

  const docker = getDockerClient(options);
  const container = docker.getContainer(containerId.trim());

  let inspectData;
  try {
    inspectData = await container.inspect();
  } catch (err) {
    throw new RuntimeServiceError(
      `Failed to inspect container "${containerId}": ${err.message}`,
      'CONTAINER_INSPECT_FAILED'
    );
  }

  const state = inspectData.State || {};
  const health = state.Health || null;
  const config = inspectData.Config || {};

  return {
    containerId: inspectData.Id,
    containerName: inspectData.Name?.replace(/^\//, ''),
    running: Boolean(state.Running),
    status: state.Status || 'unknown',
    exitCode: state.ExitCode,
    startedAt: state.StartedAt,
    finishedAt: state.FinishedAt,
    hasHealthcheck: Boolean(config.Healthcheck),
    healthStatus: health?.Status || (config.Healthcheck ? 'starting' : 'missing'),
    healthLog: health?.Log || [],
    labels: config.Labels || {}
  };
}

/**
 * Evaluates candidate container health readiness using Docker inspection.
 * Supports polling, bounded timeouts, and cancellation.
 * A running container is NOT automatically healthy.
 *
 * @param {string} containerId - Docker Container ID
 * @param {Object} [options] - Options ({ timeoutMs, intervalMs, signal, db, deploymentId, docker })
 * @returns {Promise<Object>} Health determination result
 */
async function checkCandidateHealth(containerId, options = {}) {
  if (!containerId || typeof containerId !== 'string') {
    throw new RuntimeServiceError('Valid container ID is required for health check.', 'INVALID_CONTAINER_ID');
  }

  const timeoutMs = options.timeoutMs || 30000;
  const intervalMs = options.intervalMs || 500;
  const signal = options.signal;
  const startTime = Date.now();
  const db = options.db;
  const deploymentId = options.deploymentId;

  while (Date.now() - startTime < timeoutMs) {
    if (signal && signal.aborted) {
      throw new RuntimeServiceError('Health check evaluation was cancelled by caller.', 'OPERATION_CANCELLED');
    }

    const inspection = await inspectCandidateContainer(containerId, options);

    // If image has NO healthcheck defined
    if (!inspection.hasHealthcheck) {
      if (db && deploymentId) {
        db.prepare(`
          UPDATE deployment_runtime_candidates
          SET candidate_state = 'unknown',
              health_status = 'missing',
              health_reason = 'HEALTHCHECK_MISSING',
              last_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?
        `).run(deploymentId);
      }

      return {
        healthy: false,
        promotionReady: false,
        containerId: inspection.containerId,
        candidateState: 'unknown',
        healthStatus: 'missing',
        reason: 'HEALTHCHECK_MISSING',
        message: 'Image has no defined HEALTHCHECK instruction. Cannot determine candidate readiness without health check.'
      };
    }

    // If container exited or died
    if (!inspection.running) {
      if (db && deploymentId) {
        db.prepare(`
          UPDATE deployment_runtime_candidates
          SET candidate_state = 'exited',
              health_status = 'failed',
              health_reason = 'CONTAINER_EXITED',
              last_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?
        `).run(deploymentId);
      }

      return {
        healthy: false,
        promotionReady: false,
        containerId: inspection.containerId,
        candidateState: 'exited',
        healthStatus: 'failed',
        exitCode: inspection.exitCode,
        reason: 'CONTAINER_EXITED',
        message: `Candidate container exited unexpectedly with code ${inspection.exitCode}.`
      };
    }

    // Inspect Docker Health Status
    if (inspection.healthStatus === 'healthy') {
      if (db && deploymentId) {
        db.prepare(`
          UPDATE deployment_runtime_candidates
          SET candidate_state = 'healthy',
              health_status = 'healthy',
              health_reason = NULL,
              last_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?
        `).run(deploymentId);
      }

      return {
        healthy: true,
        promotionReady: true,
        containerId: inspection.containerId,
        candidateState: 'healthy',
        healthStatus: 'healthy',
        reason: null,
        message: 'Candidate container is verified healthy.'
      };
    }

    if (inspection.healthStatus === 'unhealthy') {
      if (db && deploymentId) {
        db.prepare(`
          UPDATE deployment_runtime_candidates
          SET candidate_state = 'unhealthy',
              health_status = 'unhealthy',
              health_reason = 'HEALTHCHECK_UNHEALTHY',
              last_checked_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE deployment_id = ?
        `).run(deploymentId);
      }

      return {
        healthy: false,
        promotionReady: false,
        containerId: inspection.containerId,
        candidateState: 'unhealthy',
        healthStatus: 'unhealthy',
        reason: 'HEALTHCHECK_UNHEALTHY',
        message: 'Candidate container reported unhealthy by Docker healthcheck.'
      };
    }

    // Health is 'starting' - wait for next interval
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  // Timeout reached without becoming healthy
  if (db && deploymentId) {
    db.prepare(`
      UPDATE deployment_runtime_candidates
      SET candidate_state = 'unhealthy',
          health_status = 'starting',
          health_reason = 'HEALTHCHECK_TIMEOUT',
          last_checked_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE deployment_id = ?
    `).run(deploymentId);
  }

  return {
    healthy: false,
    promotionReady: false,
    containerId,
    candidateState: 'unhealthy',
    healthStatus: 'starting',
    reason: 'HEALTHCHECK_TIMEOUT',
    message: `Candidate health check timed out after ${timeoutMs}ms while still in starting grace period.`
  };
}

/**
 * Returns candidate runtime status record from SQLite and live inspection.
 * Never leaks sensitive environment variables or secrets.
 *
 * @param {string} deploymentId - Deployment UUID
 * @param {Object} [options] - Options ({ db, docker })
 * @returns {Object|null} Candidate status
 */
function getCandidateRuntimeStatus(deploymentId, options = {}) {
  if (!deploymentId || typeof deploymentId !== 'string') return null;
  const db = options.db || getDatabase(options);

  const row = db.prepare(`
    SELECT deployment_id, application_id, image_id, container_id, container_name,
           staging_network_id, candidate_state, health_status, health_reason,
           created_at, started_at, last_checked_at, updated_at
    FROM deployment_runtime_candidates
    WHERE deployment_id = ?
  `).get(deploymentId.trim());

  if (!row) return null;

  return {
    deploymentId: row.deployment_id,
    applicationId: row.application_id,
    imageId: row.image_id,
    containerId: row.container_id,
    containerName: row.container_name,
    stagingNetworkId: row.staging_network_id,
    candidateState: row.candidate_state,
    healthStatus: row.health_status,
    healthReason: row.health_reason,
    createdAt: row.created_at,
    startedAt: row.started_at,
    lastCheckedAt: row.last_checked_at,
    updatedAt: row.updated_at
  };
}

/**
 * Safely stops an explicitly owned candidate container.
 * Strictly verifies ownership labels and fencing before stopping.
 * Never touches unrelated containers, production networks, or data volumes.
 *
 * @param {string} deploymentId - Deployment UUID
 * @param {string} ownerId - Worker process UUID
 * @param {number} fencingToken - Fencing token
 * @param {Object} [options] - Options ({ db, docker, stopTimeoutSec })
 * @returns {Promise<Object>} Stop result
 */
async function stopOwnedCandidate(deploymentId, ownerId, fencingToken, options = {}) {
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new RuntimeServiceError('Valid deployment ID is required to stop candidate.', 'INVALID_DEPLOYMENT_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanDeploymentId = deploymentId.trim();
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);

  // 1. Verify Active Worker Lease
  verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // 2. Query Candidate Record
  const candidate = db.prepare(`
    SELECT * FROM deployment_runtime_candidates WHERE deployment_id = ?
  `).get(cleanDeploymentId);

  if (!candidate || !candidate.container_id) {
    return { stopped: false, reason: 'NO_CANDIDATE_CONTAINER' };
  }

  const docker = getDockerClient(options);
  const container = docker.getContainer(candidate.container_id);

  // 3. Inspect Container to strictly verify K-Panel candidate ownership
  let inspectData;
  try {
    inspectData = await container.inspect();
  } catch (err) {
    // If container no longer exists in Docker, update SQLite state
    db.prepare(`
      UPDATE deployment_runtime_candidates
      SET candidate_state = 'stopped',
          updated_at = CURRENT_TIMESTAMP
      WHERE deployment_id = ?
    `).run(cleanDeploymentId);

    return { stopped: true, containerId: candidate.container_id, alreadyExited: true };
  }

  const labels = inspectData.Config?.Labels || {};
  if (
    labels['io.kpanel.managed'] !== 'true' ||
    labels['io.kpanel.role'] !== 'candidate' ||
    labels['io.kpanel.deployment-id'] !== cleanDeploymentId
  ) {
    throw new RuntimeServiceError(
      `Container "${candidate.container_id}" does not match candidate ownership labels. Refusing to stop unverified container.`,
      'CONTAINER_OWNERSHIP_INVALID'
    );
  }

  // 4. Safely Stop the Container if running
  if (inspectData.State?.Running) {
    try {
      await container.stop({ t: options.stopTimeoutSec || 10 });
    } catch (err) {
      throw new RuntimeServiceError(`Failed to stop candidate container: ${err.message}`, 'CONTAINER_STOP_FAILED');
    }
  }

  // 5. Update Database Record
  db.prepare(`
    UPDATE deployment_runtime_candidates
    SET candidate_state = 'stopped',
        updated_at = CURRENT_TIMESTAMP
    WHERE deployment_id = ?
  `).run(cleanDeploymentId);

  return {
    stopped: true,
    deploymentId: cleanDeploymentId,
    containerId: candidate.container_id,
    candidateState: 'stopped'
  };
}

module.exports = {
  isRuntimeExecutionEnabled,
  getDeterministicContainerName,
  verifyActiveWorkerLease,
  buildSanitizedRuntimeEnvironment,
  validateRuntimeConfiguration,
  prepareCandidateContainer,
  startCandidateContainer,
  inspectCandidateContainer,
  checkCandidateHealth,
  getCandidateRuntimeStatus,
  stopOwnedCandidate,
  RuntimeServiceError
};
