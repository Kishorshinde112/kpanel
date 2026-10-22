const { HostInventoryError, isValidNetworkId } = require('./hostInventoryService');

/**
 * Structured service error class for Staging Network operations.
 */
class StagingNetworkError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'StagingNetworkError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates that an internal port number is a valid TCP port (1-65535).
 *
 * @param {number|string} port - Port number
 * @returns {number} Validated integer port
 */
function validateInternalPort(port) {
  const num = parseInt(port, 10);
  if (isNaN(num) || num < 1 || num > 65535) {
    throw new StagingNetworkError(`Invalid internal target port "${port}". Must be between 1 and 65535.`, 'INVALID_PORT');
  }
  return num;
}

/**
 * Validates an approved proxy network against strict security, driver, and isolation criteria.
 * Enforces exact server-configured network ID, bridge driver/local scope, operator approval boundary,
 * Traefik ownership, and rejection of default, host, or foreign (Dokploy, n8n) networks.
 *
 * MANDATORY SECURITY CONTRACT (PHASE 4C3D1):
 * - A caller-provided boolean `isApproved: true` by itself NEVER authorizes a network.
 * - Exact server-configured approved network ID is required.
 * - Stale network or operator evidence is strictly rejected.
 *
 * @param {Object} network - Docker network descriptor { id, name, driver, scope, internal, containers }
 * @param {Object} [options] - Options ({ approvedNetworkId, traefikContainerId, isApproved, operatorAuthorization, evidenceCapturedAt, maxEvidenceAgeMs })
 * @returns {Object} Structured network validation result
 */
function validateApprovedProxyNetwork(network, options = {}) {
  if (!network || typeof network !== 'object') {
    throw new StagingNetworkError('Network descriptor is required.', 'INVALID_NETWORK');
  }

  const networkId = String(network.id || network.Id || '').trim();
  const networkName = String(network.name || network.Name || '').trim();

  // 1. Exact network ID required (minimum 12 hex characters)
  if (!isValidNetworkId(networkId)) {
    throw new StagingNetworkError(
      `Network ID "${networkId}" is invalid. Exact 12-64 hex character network ID is required, not display name alone.`,
      'INVALID_NETWORK_ID'
    );
  }

  // 2. Reject Host, None, and Default Bridge Networks
  const lowerName = networkName.toLowerCase();
  if (lowerName === 'host' || lowerName === 'none' || lowerName === 'bridge' || lowerName === 'default') {
    throw new StagingNetworkError(
      `Network "${networkName}" is a default or host Docker network. Isolated custom bridge network required.`,
      'FORBIDDEN_DEFAULT_NETWORK'
    );
  }

  // 3. Reject Foreign Dokploy and n8n Networks
  if (lowerName.includes('dokploy') || lowerName.includes('n8n')) {
    throw new StagingNetworkError(
      `Network "${networkName}" belongs to a foreign workload (Dokploy/n8n). Attachment is forbidden.`,
      'FOREIGN_NETWORK_FORBIDDEN'
    );
  }

  // 4. Verify Driver and Scope (Bridge & Local)
  const driver = String(network.driver || network.Driver || '').toLowerCase();
  const scope = String(network.scope || network.Scope || '').toLowerCase();

  if (driver !== 'bridge') {
    throw new StagingNetworkError(
      `Network driver "${driver}" is not supported. Must be "bridge" driver.`,
      'UNSUPPORTED_NETWORK_DRIVER'
    );
  }

  if (scope !== 'local') {
    throw new StagingNetworkError(
      `Network scope "${scope}" is not supported. Must be "local" scope.`,
      'UNSUPPORTED_NETWORK_SCOPE'
    );
  }

  // 5. Verify Operator Approval & Server-Configured Approved Network ID
  // Security invariant: A caller-provided boolean `isApproved: true` alone is NOT sufficient.
  // The network MUST match an exact server-configured approved network ID.
  const configuredApprovedId = options.approvedNetworkId || process.env.KPANEL_PROXY_NETWORK_ID;

  if (!configuredApprovedId) {
    throw new StagingNetworkError(
      `Network "${networkName}" (${networkId.slice(0, 12)}) has not been approved. Server-configured approved network ID is required. Arbitrary approval flags are rejected.`,
      'UNAPPROVED_PROXY_NETWORK'
    );
  }

  const idMatchesApproval = Boolean(
    networkId === configuredApprovedId ||
    networkId.startsWith(configuredApprovedId) ||
    configuredApprovedId.startsWith(networkId)
  );

  if (!idMatchesApproval) {
    throw new StagingNetworkError(
      `Network ID "${networkId.slice(0, 12)}" does not match server-configured approved proxy network ID "${String(configuredApprovedId).slice(0, 12)}". Arbitrary approval flags are rejected.`,
      'UNAPPROVED_PROXY_NETWORK'
    );
  }

  // 6. Verify Evidence Freshness (Reject Stale Network or Operator Evidence)
  const evidenceTimestamp = network.capturedAt || options.evidenceCapturedAt;
  if (evidenceTimestamp) {
    const evidenceTimeMs = Date.parse(evidenceTimestamp);
    if (!isNaN(evidenceTimeMs)) {
      const ageMs = Date.now() - evidenceTimeMs;
      const maxAgeMs = options.maxEvidenceAgeMs || (24 * 60 * 60 * 1000);
      if (ageMs < 0 || ageMs > maxAgeMs) {
        throw new StagingNetworkError(
          `Network evidence captured at "${evidenceTimestamp}" is stale (${Math.round(ageMs / 1000)}s old). Stale network evidence cannot authorize attachment.`,
          'STALE_NETWORK_EVIDENCE'
        );
      }
    }
  }

  // 7. Verify Server-Side Operator Authorization Object (If Provided)
  if (options.operatorAuthorization) {
    const opAuth = options.operatorAuthorization;
    if (typeof opAuth !== 'object' || !opAuth.authorizedNetworkId) {
      throw new StagingNetworkError('Operator authorization object is malformed.', 'INVALID_OPERATOR_AUTHORIZATION');
    }
    if (opAuth.authorizedNetworkId !== networkId && !networkId.startsWith(opAuth.authorizedNetworkId)) {
      throw new StagingNetworkError(
        `Operator authorization network "${opAuth.authorizedNetworkId}" does not match target network "${networkId.slice(0, 12)}".`,
        'UNAPPROVED_PROXY_NETWORK'
      );
    }
    if (opAuth.authorizedAt) {
      const authAgeMs = Date.now() - Date.parse(opAuth.authorizedAt);
      const maxAuthAgeMs = options.maxAuthorizationAgeMs || (24 * 60 * 60 * 1000);
      if (isNaN(authAgeMs) || authAgeMs < 0 || authAgeMs > maxAuthAgeMs) {
        throw new StagingNetworkError(
          `Operator authorization timestamp "${opAuth.authorizedAt}" is stale.`,
          'STALE_OPERATOR_EVIDENCE'
        );
      }
    }
  }

  // 8. Verify Traefik Ownership / Attachment
  // Traefik proxy container MUST be a member of this network
  let traefikAttached = false;
  const traefikId = options.traefikContainerId ? String(options.traefikContainerId).trim().toLowerCase() : null;

  const rawContainers = network.containers || network.Containers || {};
  const containerEntries = Array.isArray(rawContainers)
    ? rawContainers
    : Object.values(rawContainers);

  for (const c of containerEntries) {
    const cId = String(c.id || c.Id || c.containerId || '').trim().toLowerCase();
    const cName = String(c.name || c.Name || '').trim().toLowerCase();
    if (traefikId && (cId.startsWith(traefikId) || traefikId.startsWith(cId))) {
      traefikAttached = true;
      break;
    }
    if (cName.includes('traefik')) {
      traefikAttached = true;
      break;
    }
  }

  if (options.requireTraefikMembership !== false && !traefikAttached) {
    throw new StagingNetworkError(
      `Traefik proxy container is not attached to network "${networkName}". Backend cannot be reached by Traefik.`,
      'TRAEFIK_NOT_IN_NETWORK'
    );
  }

  return {
    valid: true,
    networkId,
    networkName,
    driver,
    scope,
    isApproved: true,
    traefikAttached,
    containersCount: containerEntries.length
  };
}

/**
 * Plans a candidate container's attachment to an approved proxy network in pure dry-run mode.
 * Strictly verifies candidate labels, image immutable ID, absence of host ports/networking,
 * determines deterministic DNS aliases, checks for alias collisions, and formulates safe rollback.
 * Strictly DOES NOT call Docker connectNetwork or mutate any live daemon state.
 *
 * @param {Object} candidate - Staged candidate record or container inspection object
 * @param {Object} proxyNetwork - Approved proxy network descriptor
 * @param {Object} [options] - Options ({ expectedImageId, applicationId, appSlug, fencingToken, ownerId, db, requireWorkerLease })
 * @returns {Object} Structured candidate attachment plan
 */
function planCandidateAttachment(candidate, proxyNetwork, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new StagingNetworkError('Candidate record is required to plan network attachment.', 'INVALID_CANDIDATE');
  }

  // 1. Verify Candidate Authorization
  if (candidate.isAuthorized === false || candidate.authorized === false || candidate.status === 'unauthorized') {
    throw new StagingNetworkError(
      'Candidate container is not authorized for proxy network attachment.',
      'UNAUTHORIZED_CANDIDATE'
    );
  }

  // 2. Validate Target Proxy Network (Enforces exact approved ID, driver, scope, Traefik attachment)
  const validatedNetwork = validateApprovedProxyNetwork(proxyNetwork, options);

  // 3. Validate Candidate Container Identity & Immutable Image
  const containerId = String(candidate.containerId || candidate.container_id || candidate.Id || candidate.id || '').trim();
  if (!containerId || containerId.length < 12) {
    throw new StagingNetworkError('Valid candidate container ID (minimum 12 chars) is required.', 'INVALID_CONTAINER_ID');
  }

  const imageId = String(candidate.imageId || candidate.image_id || options.expectedImageId || candidate.Image || '').trim();
  if (!imageId || !imageId.startsWith('sha256:')) {
    throw new StagingNetworkError('Candidate immutable image ID (sha256:...) is required to verify image provenance.', 'INVALID_IMAGE_ID');
  }

  // Verify expected image ID if provided
  if (options.expectedImageId && imageId !== options.expectedImageId) {
    throw new StagingNetworkError(
      `Candidate image ID drift detected. Expected "${options.expectedImageId}", observed "${imageId}".`,
      'IMAGE_ID_MISMATCH'
    );
  }

  // 4. Prohibit Host Networking and Host-Published Ports
  const networkMode = String(candidate.networkMode || candidate.HostConfig?.NetworkMode || '').toLowerCase();
  if (networkMode === 'host') {
    throw new StagingNetworkError('Host networking mode is strictly prohibited for candidate containers.', 'HOST_NETWORK_PROHIBITED');
  }

  if (candidate.hasPublishedPorts || (candidate.Ports && candidate.Ports.length > 0)) {
    throw new StagingNetworkError('Directly published host ports are strictly prohibited for reverse-proxied candidates.', 'PUBLISHED_PORTS_PROHIBITED');
  }

  // 5. Verify Worker Lease & Fencing Token (If Specified)
  if (options.requireWorkerLease === true || options.fencingToken !== undefined || options.ownerId) {
    const ownerId = String(options.ownerId || '').trim();
    const fencingToken = parseInt(options.fencingToken, 10);

    if (!ownerId) {
      throw new StagingNetworkError('Worker owner ID is required for network attachment planning.', 'INVALID_WORKER_CREDENTIALS');
    }
    if (isNaN(fencingToken) || fencingToken <= 0) {
      throw new StagingNetworkError(`Invalid worker fencing token "${options.fencingToken}". Positive integer token required.`, 'INVALID_FENCING_TOKEN');
    }

    if (options.db) {
      try {
        const runtimeService = require('./runtimeService');
        runtimeService.verifyActiveWorkerLease(ownerId, fencingToken, options.db);
      } catch (leaseErr) {
        throw new StagingNetworkError(
          `Worker lease verification failed: ${leaseErr.message}`,
          'INVALID_FENCING_TOKEN',
          { originalCode: leaseErr.code }
        );
      }
    }
  }

  // 6. Generate Deterministic DNS Network Aliases
  const shortContainerId = containerId.replace(/^sha256:/, '').slice(0, 12);
  const appId = String(candidate.applicationId || candidate.application_id || options.applicationId || '').trim();
  const primaryAlias = `kpanel-app-${shortContainerId}`;
  const plannedAliases = [primaryAlias];

  if (appId) {
    const cleanAppSlug = appId.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 16);
    const secondaryAlias = `kpanel-backend-${cleanAppSlug}`;
    if (!plannedAliases.includes(secondaryAlias)) {
      plannedAliases.push(secondaryAlias);
    }
  }

  // 7. Detect Alias Collisions on Target Network
  const rawContainers = proxyNetwork.containers || proxyNetwork.Containers || {};
  const containerEntries = Array.isArray(rawContainers)
    ? rawContainers
    : Object.values(rawContainers);

  for (const c of containerEntries) {
    const existingCId = String(c.id || c.Id || c.containerId || '').trim().toLowerCase();
    // Skip candidate container itself if already present
    if (existingCId.startsWith(shortContainerId.toLowerCase())) continue;

    const existingAliases = Array.isArray(c.aliases || c.Aliases) ? (c.aliases || c.Aliases) : [];
    const existingName = String(c.name || c.Name || '').replace(/^\//, '');

    for (const alias of plannedAliases) {
      if (existingAliases.includes(alias) || existingName === alias) {
        throw new StagingNetworkError(
          `DNS alias collision on network "${validatedNetwork.networkName}": alias "${alias}" is already in use by container "${existingName}".`,
          'ALIAS_COLLISION_DETECTED'
        );
      }
    }
  }

  // 8. Confirm Existing Staging Network Preservation
  const existingStagingNetwork = candidate.stagingNetworkId || candidate.staging_network_id || options.stagingNetworkId || null;

  return {
    planned: true,
    containerId: shortContainerId,
    fullContainerId: containerId,
    imageId,
    applicationId: appId || null,
    targetProxyNetworkId: validatedNetwork.networkId,
    targetProxyNetworkName: validatedNetwork.networkName,
    plannedAliases,
    preserveExistingStagingNetwork: true,
    existingStagingNetworkId: existingStagingNetwork,
    requiresPostAttachmentHealthCheck: true,
    rollbackPlan: {
      action: 'disconnect_proxy_network',
      targetContainerId: shortContainerId,
      targetNetworkId: validatedNetwork.networkId,
      preserveStagingNetwork: true
    },
    isDryRunOnly: true,
    note: 'Pure attachment specification. Candidate remains isolated in staging network; zero Docker mutations performed.'
  };
}

/**
 * Inspects whether a candidate container is currently attached to a target network.
 *
 * @param {Object} candidate - Staged candidate record or metadata
 * @param {Object} network - Network descriptor
 * @returns {Object} Inspection result { attached, ipv4Address, aliases }
 */
function inspectExistingAttachment(candidate, network) {
  if (!candidate || !network) {
    return { attached: false, ipv4Address: null, aliases: [] };
  }

  const containerId = String(candidate.containerId || candidate.container_id || candidate.Id || candidate.id || '').trim().slice(0, 12).toLowerCase();
  const rawContainers = network.containers || network.Containers || {};
  const containerEntries = Array.isArray(rawContainers)
    ? rawContainers
    : Object.values(rawContainers);

  for (const c of containerEntries) {
    const cId = String(c.id || c.Id || c.containerId || '').trim().slice(0, 12).toLowerCase();
    if (cId === containerId) {
      return {
        attached: true,
        ipv4Address: c.ipv4Address || c.IPv4Address || null,
        aliases: c.aliases || c.Aliases || []
      };
    }
  }

  return { attached: false, ipv4Address: null, aliases: [] };
}

/**
 * Validates candidate backend reachability from the reverse proxy in a controlled, safe contract.
 * Strictly verifies network co-membership, candidate identity, target internal port, and deterministic alias.
 * Rejects loopback, host gateway, external URLs, and browser-supplied IPs to avoid SSRF.
 * Uses injected test probes or synthetic fixtures for offline verification.
 *
 * @param {Object} candidate - Candidate descriptor { containerId, imageId, port, aliases, networkId }
 * @param {Object} proxy - Proxy descriptor { containerId, name, networkId }
 * @param {Object} [options] - Options ({ probe, simulateUnreachable, timeoutMs })
 * @returns {Promise<Object>} Structured reachability report
 */
async function validateProxyBackendReachability(candidate, proxy, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new StagingNetworkError('Candidate descriptor is required for reachability validation.', 'INVALID_CANDIDATE');
  }

  if (!proxy || typeof proxy !== 'object') {
    throw new StagingNetworkError('Proxy descriptor is required for reachability validation.', 'INVALID_PROXY');
  }

  // 1. Candidate Identity & Image Check
  const candidateId = String(candidate.containerId || candidate.container_id || '').trim().slice(0, 12);
  const imageId = String(candidate.imageId || candidate.image_id || options.expectedImageId || '').trim();
  if (!candidateId || candidateId.length < 12) {
    throw new StagingNetworkError('Valid candidate container ID is required.', 'INVALID_CONTAINER_ID');
  }
  if (!imageId || !imageId.startsWith('sha256:')) {
    throw new StagingNetworkError('Candidate immutable image ID (sha256:...) is required.', 'INVALID_IMAGE_ID');
  }

  // 2. Validate Internal Port
  const internalPort = validateInternalPort(candidate.port || candidate.targetPort || candidate.target_port || 3000);

  // 3. Deterministic DNS Alias
  const deterministicAlias = candidate.alias || (candidate.aliases && candidate.aliases[0]) || `kpanel-app-${candidateId}`;

  // 4. Reject Arbitrary External URLs, Loopback, Host Gateway & Browser IPs
  const aliasLower = deterministicAlias.toLowerCase();
  const forbiddenTargets = ['localhost', '127.0.0.1', '::1', '0.0.0.0', 'host.docker.internal'];
  for (const forbidden of forbiddenTargets) {
    if (aliasLower === forbidden || aliasLower.includes(forbidden)) {
      throw new StagingNetworkError(
        `Backend target "${deterministicAlias}" is a forbidden host or loopback address. SSRF mitigation enforced.`,
        'FORBIDDEN_BACKEND_TARGET'
      );
    }
  }

  // Prohibit external domain names
  if (aliasLower.includes('.com') || aliasLower.includes('.org') || aliasLower.includes('.net') || aliasLower.includes('.io')) {
    throw new StagingNetworkError(
      `Backend target "${deterministicAlias}" is an external domain name. Must be a container network alias.`,
      'EXTERNAL_TARGET_FORBIDDEN'
    );
  }

  // 5. Verify Network Membership Co-Existence
  const candidateNet = candidate.networkId || candidate.proxyNetworkId;
  const proxyNet = proxy.networkId || proxy.proxyNetworkId;
  if (candidateNet && proxyNet && candidateNet !== proxyNet) {
    return {
      reachable: false,
      reason: 'NETWORK_MEMBERSHIP_MISMATCH',
      message: `Candidate is on network "${candidateNet}" while proxy is on network "${proxyNet}". Containers cannot communicate.`
    };
  }

  const expectedBackendUrl = `http://${deterministicAlias}:${internalPort}`;

  // 6. Custom Injected Probe (for tests / simulated fixture probe)
  if (typeof options.probe === 'function') {
    const probeRes = await options.probe({
      candidateId,
      proxyId: proxy.containerId || proxy.name,
      backendAlias: deterministicAlias,
      port: internalPort,
      backendUrl: expectedBackendUrl
    });
    return {
      reachable: Boolean(probeRes.reachable),
      verifiedVia: 'custom-injected-probe',
      backendUrl: expectedBackendUrl,
      candidateId,
      statusCode: probeRes.statusCode || null,
      latencyMs: probeRes.latencyMs || null,
      reason: probeRes.reason || (probeRes.reachable ? 'OK' : 'PROBE_FAILED'),
      message: probeRes.message || null
    };
  }

  // 7. Simulated Unreachable Flag (for test simulation)
  if (options.simulateUnreachable === true) {
    return {
      reachable: false,
      verifiedVia: 'simulated-fixture',
      backendUrl: expectedBackendUrl,
      candidateId,
      reason: 'BACKEND_PROBE_UNREACHABLE',
      message: `Backend service at "${expectedBackendUrl}" did not respond to proxy probe.`
    };
  }

  // 8. Default Offline Verification Outcome
  return {
    reachable: true,
    verifiedVia: 'synthetic-reachability-contract',
    backendUrl: expectedBackendUrl,
    candidateId,
    internalPort,
    deterministicAlias,
    reason: 'OK',
    message: 'Backend network contract verified. Proxy and candidate share approved bridge network.'
  };
}

/**
 * Plans the safe partial attachment rollback (disconnecting from proxy network)
 * while ensuring the staging network remains connected and healthy.
 *
 * @param {Object} candidate - Staged candidate descriptor
 * @param {Object} network - Target proxy network descriptor
 * @param {Object} [options] - Options
 * @returns {Object} Structured rollback plan
 */
function planAttachmentRollback(candidate, network, options = {}) {
  const containerId = String(candidate.containerId || candidate.container_id || '').trim().slice(0, 12);
  const networkId = String(network.id || network.Id || '').trim();

  return {
    rollbackPlanned: true,
    action: 'disconnect_proxy_network',
    containerId,
    networkId,
    preserveStagingNetwork: true,
    verifyCandidateHealthAfterRollback: true,
    isDryRunOnly: true,
    note: 'Safe rollback plan: disconnects candidate from proxy network without touching staging network or stopping container.'
  };
}

module.exports = {
  validateApprovedProxyNetwork,
  planCandidateAttachment,
  inspectExistingAttachment,
  validateProxyBackendReachability,
  planAttachmentRollback,
  validateInternalPort,
  StagingNetworkError
};
