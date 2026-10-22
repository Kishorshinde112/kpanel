const crypto = require('crypto');
const path = require('path');

/**
 * Maximum allowed size for an ingested inventory payload in bytes (5 MB).
 */
const MAX_INVENTORY_PAYLOAD_SIZE = 5 * 1024 * 1024;

/**
 * Default maximum age for inventory freshness (24 hours).
 */
const DEFAULT_MAX_INVENTORY_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Stricter freshness limits distinguishing Planning vs Live Activation.
 */
const MAX_PLANNING_INVENTORY_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours (suitable for architecture review)
const MAX_ACTIVATION_INVENTORY_AGE_MS = 60 * 1000; // 60 seconds (strict fresh preflight before traffic switch)

/**
 * Forbidden system directories for snapshot paths.
 */
const FORBIDDEN_SNAPSHOT_PATHS = [
  '/etc',
  '/proc',
  '/sys',
  '/dev',
  '/var/run',
  '/root',
  '/boot',
  '/usr'
];

/**
 * Structured service error class for Host Inventory operations.
 */
class HostInventoryError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'HostInventoryError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates an ISO 8601 timestamp string.
 *
 * @param {string} timestampStr - Timestamp string
 * @returns {boolean} True if valid ISO date string
 */
function isValidIsoTimestamp(timestampStr) {
  if (!timestampStr || typeof timestampStr !== 'string') return false;
  const parsed = Date.parse(timestampStr);
  if (isNaN(parsed)) return false;
  // Ensure it follows standard ISO-like formatting
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(timestampStr);
}

/**
 * Validates a Docker network ID (12 to 64 hex characters).
 *
 * @param {string} networkId - Network ID to validate
 * @returns {boolean} True if valid
 */
function isValidNetworkId(networkId) {
  if (!networkId || typeof networkId !== 'string') return false;
  return /^[a-f0-9]{12,64}$/i.test(networkId.trim());
}

/**
 * Classifies a resource into K-Panel owned, foreign owned, or unverifiable.
 *
 * @param {string} name - Resource identifier
 * @param {Object} [details] - Additional resource context
 * @returns {string} 'KPANEL_OWNED' | 'FOREIGN_DOKPLOY' | 'FOREIGN_N8N' | 'FOREIGN_GENERIC' | 'UNVERIFIABLE'
 */
function classifyResourceOwnership(name, details = {}) {
  if (!name || typeof name !== 'string') return 'UNVERIFIABLE';
  const clean = name.trim().toLowerCase();
  const rawRule = String(details.rule || '').toLowerCase();
  const rawService = String(details.service || '').toLowerCase();

  if (clean.startsWith('kpanel-') || rawService.startsWith('kpanel-')) {
    return 'KPANEL_OWNED';
  }
  if (clean.includes('dokploy') || rawRule.includes('dokploy') || rawService.includes('dokploy')) {
    return 'FOREIGN_DOKPLOY';
  }
  if (clean.includes('n8n') || rawRule.includes('n8n') || rawService.includes('n8n')) {
    return 'FOREIGN_N8N';
  }
  if (clean.startsWith('traefik') || clean.includes('dashboard')) {
    return 'FOREIGN_GENERIC';
  }
  return 'FOREIGN_GENERIC';
}

/**
 * Validates and ingests a host infrastructure inventory object or JSON string.
 * Pure inspection; zero mutation and zero external side effects.
 *
 * @param {Object|string} rawInput - Inventory object or raw JSON string
 * @param {Object} [options] - Ingestion options ({ maxAgeMs, trustedAdapter, allowedRootPath })
 * @returns {Object} Structured, validated inventory report
 */
function ingestHostInventory(rawInput, options = {}) {
  if (!rawInput) {
    throw new HostInventoryError('Host inventory payload is required.', 'MISSING_INVENTORY');
  }

  let rawObj;
  let rawJsonString;

  if (typeof rawInput === 'string') {
    rawJsonString = rawInput;
    if (Buffer.byteLength(rawJsonString, 'utf8') > MAX_INVENTORY_PAYLOAD_SIZE) {
      throw new HostInventoryError('Inventory payload exceeds maximum allowed size (5 MB).', 'PAYLOAD_TOO_LARGE');
    }
    try {
      rawObj = JSON.parse(rawJsonString);
    } catch (parseErr) {
      throw new HostInventoryError(`Malformed JSON in inventory payload: ${parseErr.message}`, 'MALFORMED_JSON');
    }
  } else if (typeof rawInput === 'object') {
    rawObj = rawInput;
    try {
      rawJsonString = JSON.stringify(rawObj);
      if (Buffer.byteLength(rawJsonString, 'utf8') > MAX_INVENTORY_PAYLOAD_SIZE) {
        throw new HostInventoryError('Inventory payload exceeds maximum allowed size (5 MB).', 'PAYLOAD_TOO_LARGE');
      }
    } catch (strErr) {
      throw new HostInventoryError(`Failed to serialize inventory object: ${strErr.message}`, 'MALFORMED_PAYLOAD');
    }
  } else {
    throw new HostInventoryError('Inventory payload must be an object or JSON string.', 'INVALID_PAYLOAD_TYPE');
  }

  // 1. Schema Version Check
  const rawVersion = rawObj.version || rawObj.inventoryVersion;
  if (!rawVersion || typeof rawVersion !== 'string' || !rawVersion.trim()) {
    throw new HostInventoryError('Inventory version is required.', 'INVALID_SCHEMA_VERSION');
  }
  const version = rawVersion.trim();

  // 2. Timestamp & Freshness Validation
  const captureTimestamp = rawObj.captureTimestamp || rawObj.capturedAt || rawObj.timestamp;
  if (!captureTimestamp || !isValidIsoTimestamp(captureTimestamp)) {
    throw new HostInventoryError(
      `Capture timestamp is missing or not a valid ISO 8601 string: "${captureTimestamp}".`,
      'INVALID_TIMESTAMP'
    );
  }

  const captureTimeMs = Date.parse(captureTimestamp);
  const purpose = options.purpose || 'planning'; // 'planning' | 'activation'
  const maxAgeMs = options.maxAgeMs !== undefined
    ? options.maxAgeMs
    : (purpose === 'activation' ? MAX_ACTIVATION_INVENTORY_AGE_MS : (rawObj.maxAgeMs || DEFAULT_MAX_INVENTORY_AGE_MS));

  const ageMs = Date.now() - captureTimeMs;
  const isStale = ageMs < 0 || ageMs > maxAgeMs;
  const isFreshForPlanning = ageMs >= 0 && ageMs <= MAX_PLANNING_INVENTORY_AGE_MS;
  const isFreshForActivation = ageMs >= 0 && ageMs <= MAX_ACTIVATION_INVENTORY_AGE_MS;

  // 3. Provenance & Capture Source
  const captureSource = String(rawObj.captureSource || options.captureSource || 'operator-script').trim();
  // Provenance must NEVER be established by a field inside untrusted JSON!
  const isTrustedProvenance = Boolean(
    options.trustedAdapter === true ||
    options.originVerified === true
  );

  // 4. Host & Traefik Identity
  const hostIdentity = rawObj.hostIdentity && typeof rawObj.hostIdentity === 'object'
    ? {
        hostname: String(rawObj.hostIdentity.hostname || '').trim(),
        operatingSystem: String(rawObj.hostIdentity.operatingSystem || rawObj.hostIdentity.os || '').trim(),
        architecture: String(rawObj.hostIdentity.architecture || rawObj.hostIdentity.arch || '').trim(),
        dockerVersion: String(rawObj.hostIdentity.dockerVersion || '').trim(),
        dockerStatus: String(rawObj.hostIdentity.dockerStatus || 'available').trim()
      }
    : null;

  const traefikRaw = rawObj.traefik || rawObj.traefikInstance || {};
  const traefikMounts = Array.isArray(traefikRaw.mounts)
    ? traefikRaw.mounts.map((m) => ({
        type: String(m.type || 'bind').toLowerCase(),
        source: String(m.source || '').trim(),
        destination: String(m.destination || '').trim(),
        mode: String(m.mode || '').trim(),
        rw: Boolean(m.rw)
      }))
    : [];

  const traefikIdentity = {
    instanceId: String(traefikRaw.instanceId || traefikRaw.instance_id || traefikRaw.containerId || '').trim() || null,
    version: String(traefikRaw.version || '').trim() || null,
    containerName: String(traefikRaw.containerName || traefikRaw.name || '').trim() || null,
    configFile: String(traefikRaw.configFile || '').trim() || null,
    status: String(traefikRaw.status || '').trim() || null,
    apiStatus: String(traefikRaw.apiStatus || '').trim() || null,
    instancesDetected: typeof traefikRaw.instancesDetected === 'number' ? traefikRaw.instancesDetected : 1,
    mounts: traefikMounts
  };

  // 5. Providers Validation
  const providersRaw = rawObj.providers || {};
  const fileProviderRaw = providersRaw.file || {};
  const dockerProviderRaw = providersRaw.docker || {};

  let discoveredHostPath = fileProviderRaw.hostPath ? String(fileProviderRaw.hostPath).trim() : null;
  let discoveredMountLocation = fileProviderRaw.mountLocation ? String(fileProviderRaw.mountLocation).trim() : null;

  // Auto-discover bind mount correspondence if Traefik mounts are provided in inventory
  if (fileProviderRaw.directory && traefikMounts.length > 0) {
    const dir = String(fileProviderRaw.directory).trim();
    const matchedMount = traefikMounts.find((m) => m && (m.destination === dir || dir.startsWith(m.destination)));
    if (matchedMount) {
      discoveredHostPath = matchedMount.source;
      discoveredMountLocation = matchedMount.destination;
    }
  }

  const fileProvider = {
    enabled: Boolean(fileProviderRaw.enabled),
    directory: fileProviderRaw.directory ? String(fileProviderRaw.directory).trim() : null,
    filename: fileProviderRaw.filename ? String(fileProviderRaw.filename).trim() : null,
    watch: Boolean(fileProviderRaw.watch),
    mountLocation: discoveredMountLocation,
    hostPath: discoveredHostPath,
    isShared: Boolean(fileProviderRaw.isShared),
    dedicatedNamespace: fileProviderRaw.dedicatedNamespace ? String(fileProviderRaw.dedicatedNamespace).trim() : null,
    dokployCoexistence: Boolean(fileProviderRaw.dokployCoexistence)
  };

  // Reject file provider path traversal or null bytes
  if (fileProvider.directory) {
    if (fileProvider.directory.includes('\0') || fileProvider.directory.includes('..')) {
      throw new HostInventoryError('File provider directory path contains traversal characters or null bytes.', 'PATH_TRAVERSAL_DETECTED');
    }
  }

  const dockerProvider = {
    enabled: Boolean(dockerProviderRaw.enabled),
    endpoint: dockerProviderRaw.endpoint ? String(dockerProviderRaw.endpoint).trim() : null,
    network: dockerProviderRaw.network ? String(dockerProviderRaw.network).trim() : null,
    exposedByDefault: Boolean(dockerProviderRaw.exposedByDefault)
  };

  // 6. Docker Networks Validation
  const rawNetworks = Array.isArray(rawObj.networks) ? rawObj.networks : [];
  if (rawNetworks.length > 500) {
    throw new HostInventoryError('Inventory exceeds maximum network limit (500).', 'EXCESSIVE_NETWORKS');
  }

  const validatedNetworks = [];
  const networkIdsSeen = new Set();

  for (const net of rawNetworks) {
    if (!net || typeof net !== 'object') continue;
    const netId = String(net.id || net.Id || '').trim();
    const netName = String(net.name || net.Name || '').trim();

    if (!isValidNetworkId(netId)) {
      throw new HostInventoryError(`Invalid Docker network ID format: "${netId}". Must be 12-64 hex characters.`, 'INVALID_NETWORK_ID');
    }

    if (networkIdsSeen.has(netId)) {
      throw new HostInventoryError(`Duplicate network ID "${netId}" detected in inventory.`, 'DUPLICATE_NETWORK_ID');
    }
    networkIdsSeen.add(netId);

    const driver = String(net.driver || net.Driver || 'bridge').trim().toLowerCase();
    const scope = String(net.scope || net.Scope || 'local').trim().toLowerCase();
    const isInternal = Boolean(net.internal !== undefined ? net.internal : net.Internal);
    const isAttachable = Boolean(net.attachable !== undefined ? net.attachable : net.Attachable);

    // Containers in network (sanitized, no environment variables or credentials!)
    const containers = [];
    const rawContainers = net.containers || net.Containers || {};
    const containerEntries = Array.isArray(rawContainers)
      ? rawContainers
      : Object.values(rawContainers);

    for (const c of containerEntries) {
      if (!c || typeof c !== 'object') continue;
      containers.push({
        containerId: String(c.id || c.Id || c.containerId || '').trim().slice(0, 12),
        name: String(c.name || c.Name || '').trim().replace(/^\//, ''),
        ipv4Address: String(c.ipv4Address || c.IPv4Address || '').trim() || null
      });
    }

    validatedNetworks.push({
      id: netId,
      name: netName,
      driver,
      scope,
      internal: isInternal,
      attachable: isAttachable,
      containers,
      ownership: classifyResourceOwnership(netName)
    });
  }

  // 7. HTTP Routers Validation
  const rawRouters = Array.isArray(rawObj.routers)
    ? rawObj.routers
    : (rawObj.http?.routers ? (Array.isArray(rawObj.http.routers) ? rawObj.http.routers : Object.entries(rawObj.http.routers).map(([k, v]) => ({ name: k, ...v }))) : []);

  if (rawRouters.length > 2000) {
    throw new HostInventoryError('Inventory exceeds maximum router limit (2000).', 'EXCESSIVE_ROUTERS');
  }

  const validatedRouters = [];
  const kpanelOwnedRouters = [];
  const foreignRouters = [];

  for (const r of rawRouters) {
    if (!r || typeof r !== 'object') continue;
    const name = String(r.name || '').trim();
    const rule = String(r.rule || '').trim();

    if (!name || !rule) {
      throw new HostInventoryError(`Malformed router definition in inventory: missing name or rule.`, 'MALFORMED_ROUTER');
    }

    const provider = String(r.provider || 'unknown').trim().toLowerCase();
    const entryPoints = Array.isArray(r.entryPoints)
      ? r.entryPoints.map((ep) => String(ep).trim().toLowerCase())
      : (r.entryPoints ? [String(r.entryPoints).trim().toLowerCase()] : ['websecure']);
    const service = String(r.service || '').trim();
    const ownership = classifyResourceOwnership(name, { rule, service });

    const routerObj = {
      name,
      provider,
      rule,
      entryPoints,
      service,
      status: String(r.status || 'enabled').trim().toLowerCase(),
      ownership
    };

    validatedRouters.push(routerObj);
    if (ownership === 'KPANEL_OWNED') {
      kpanelOwnedRouters.push(routerObj);
    } else {
      foreignRouters.push(routerObj);
    }
  }

  // 8. HTTP Services Validation
  const rawServices = Array.isArray(rawObj.services)
    ? rawObj.services
    : (rawObj.http?.services ? (Array.isArray(rawObj.http.services) ? rawObj.http.services : Object.entries(rawObj.http.services).map(([k, v]) => ({ name: k, ...v }))) : []);

  if (rawServices.length > 2000) {
    throw new HostInventoryError('Inventory exceeds maximum service limit (2000).', 'EXCESSIVE_SERVICES');
  }

  const validatedServices = [];
  for (const s of rawServices) {
    if (!s || typeof s !== 'object') continue;
    const name = String(s.name || '').trim();
    if (!name) continue;
    validatedServices.push({
      name,
      provider: String(s.provider || 'unknown').trim().toLowerCase(),
      status: String(s.status || 'enabled').trim().toLowerCase(),
      ownership: classifyResourceOwnership(name)
    });
  }

  // 9. EntryPoints & TLS Resolvers
  const entryPoints = Array.isArray(rawObj.entryPoints)
    ? rawObj.entryPoints.map((ep) => (typeof ep === 'string' ? { name: ep.trim() } : { name: String(ep.name || '').trim(), address: ep.address }))
    : [];

  const tlsResolvers = Array.isArray(rawObj.tlsResolvers)
    ? rawObj.tlsResolvers.map((tr) => (typeof tr === 'string' ? { name: tr.trim() } : { name: String(tr.name || '').trim(), type: tr.type }))
    : [];

  // 10. Missing / Incomplete Information Detection
  const missingOrUnverifiable = [];
  if (!traefikIdentity.instanceId) {
    missingOrUnverifiable.push('TRAEFIK_INSTANCE_ID_MISSING');
  }
  if (!fileProvider.enabled && !dockerProvider.enabled) {
    missingOrUnverifiable.push('NO_ACTIVE_PROVIDERS_DETECTED');
  }
  if (fileProvider.enabled && !fileProvider.directory && !fileProvider.filename) {
    missingOrUnverifiable.push('FILE_PROVIDER_PATH_UNSPECIFIED');
  }
  if (fileProvider.enabled && !fileProvider.watch) {
    missingOrUnverifiable.push('FILE_PROVIDER_WATCH_DISABLED');
  }
  if (validatedRouters.length === 0) {
    missingOrUnverifiable.push('ROUTER_INVENTORY_EMPTY');
  }
  if (validatedNetworks.length === 0) {
    missingOrUnverifiable.push('DOCKER_NETWORKS_EMPTY');
  }

  // Compute canonical inventory fingerprint
  const fingerprint = crypto.createHash('sha256')
    .update(JSON.stringify({
      version,
      captureTimestamp,
      traefikIdentity,
      fileProvider,
      dockerProvider,
      networksCount: validatedNetworks.length,
      routersCount: validatedRouters.length
    }))
    .digest('hex');

  return {
    valid: true,
    version,
    captureTimestamp,
    ageMs,
    isStale,
    isFreshForPlanning,
    isFreshForActivation,
    isActivationAuthorized: false, // Invariant: Saved inventory alone never authorizes live production route changes
    activationBlockReason: !isFreshForActivation ? 'EXCEEDS_60S_ACTIVATION_FRESHNESS_LIMIT' : 'LIVE_ACTIVATION_NOT_AUTHORIZED',
    freshnessStatus: isStale ? 'stale' : 'fresh',
    activationFreshness: isFreshForActivation ? 'fresh' : 'stale',
    planningFreshness: isFreshForPlanning ? 'fresh' : 'stale',
    captureSource,
    originVerified: isTrustedProvenance,
    provenanceStatus: isTrustedProvenance ? 'verified' : 'unverified-operator-observation',
    fingerprint,
    hostIdentity,
    traefik: traefikIdentity,
    providers: {
      file: fileProvider,
      docker: dockerProvider
    },
    networks: validatedNetworks,
    routers: validatedRouters,
    services: validatedServices,
    entryPoints,
    tlsResolvers,
    ownershipSummary: {
      kpanelOwnedCount: kpanelOwnedRouters.length,
      foreignOwnedCount: foreignRouters.length,
      totalRouters: validatedRouters.length
    },
    kpanelOwnedResources: {
      routers: kpanelOwnedRouters
    },
    foreignOwnedResources: {
      routers: foreignRouters
    },
    missingOrUnverifiable,
    isComplete: missingOrUnverifiable.length === 0
  };
}

/**
 * Sanitizes and redacts sensitive infrastructure details from a host inventory
 * for secure architectural review and operator sharing.
 *
 * Requirements:
 * - Masks hostnames and internal container IP addresses.
 * - Explicitly marks redacted fields with [REDACTED].
 * - Preserves structural network topology and router rules necessary for conflict analysis.
 * - Explains limitations if domain masking is requested.
 *
 * @param {Object} inventory - Validated host inventory report or raw inventory object
 * @param {Object} [options] - Redaction options ({ redactDomains })
 * @returns {Object} Redacted inventory report safe for architecture review
 */
function redactInventoryForReview(inventory, options = {}) {
  if (!inventory || typeof inventory !== 'object') {
    throw new HostInventoryError('Valid inventory object required for redaction.', 'INVALID_INVENTORY');
  }

  const redacted = JSON.parse(JSON.stringify(inventory));
  const redactedFields = [];

  // Redact hostname
  if (redacted.hostIdentity && redacted.hostIdentity.hostname) {
    redacted.hostIdentity.hostname = '[REDACTED-HOST]';
    redactedFields.push('hostIdentity.hostname');
  }

  // Redact container IPv4 addresses in networks
  if (Array.isArray(redacted.networks)) {
    for (const net of redacted.networks) {
      if (Array.isArray(net.containers)) {
        for (const c of net.containers) {
          if (c.ipv4Address) {
            c.ipv4Address = c.ipv4Address.replace(/^(\d+\.\d+)\.\d+\.\d+/, '$1.x.x');
          }
        }
      }
    }
    redactedFields.push('networks[].containers[].ipv4Address');
  }

  // Redact confidential domain names if requested
  if (options.redactDomains === true && Array.isArray(redacted.routers)) {
    for (const r of redacted.routers) {
      if (r.rule) {
        r.rule = r.rule.replace(/Host\(`([^`]+)`\)/g, (match, domain) => {
          const hash = crypto.createHash('sha256').update(domain).digest('hex').slice(0, 8);
          return `Host(\`[REDACTED-DOMAIN-${hash}]\`)`;
        });
      }
    }
    redactedFields.push('routers[].rule.domains');
  }

  redacted.isRedacted = true;
  redacted.redactedAt = new Date().toISOString();
  redacted.redactedFields = redactedFields;
  redacted.sharingGuidance = {
    safetySummary: 'Internal hostnames and container IPs have been masked. Suitable for architecture review.',
    routingLimitation: options.redactDomains
      ? 'Domain names were masked; offline domain collision detection requires unredacted domain names or matching hashed tokens.'
      : 'Domain names preserved for accurate routing conflict analysis.'
  };

  return redacted;
}

/**
 * Classifies host integration topology into defined scenarios (A, B, C, D)
 * as required by the Phase 4C3D1 architecture review.
 *
 * @param {Object} inventory - Validated host inventory
 * @param {Object} [options] - Options ({ approvedNetworkId })
 * @returns {Object} Scenario classification report
 */
function classifyHostIntegrationScenario(inventory, options = {}) {
  if (!inventory || typeof inventory !== 'object' || !inventory.valid) {
    return {
      scenario: 'SCENARIO_C',
      status: 'STAGING_UNVERIFIED',
      decision: 'UNVERIFIABLE_TOPOLOGY',
      description: 'Host inventory is missing or malformed; routing topology cannot be determined.',
      requiresOperatorAction: true
    };
  }

  const traefik = inventory.traefik || {};
  const providers = inventory.providers || {};
  const fileProvider = providers.file || {};
  const networks = inventory.networks || [];

  // Scenario C: Traefik instance or proxy ownership cannot be verified
  if (!traefik.instanceId || traefik.status === 'not-found') {
    return {
      scenario: 'SCENARIO_C',
      status: 'STAGING_UNVERIFIED',
      decision: 'TRAEFIK_NOT_FOUND',
      description: 'Traefik proxy container could not be identified on this host. Routing ownership unverified.',
      risks: ['Blind deployment could interfere with unmanaged reverse proxies or host web servers.'],
      recommendation: 'Operator must identify proxy container name or install supported proxy.',
      requiresOperatorAction: true
    };
  }

  // Scenario B: Existing Traefik has no File provider
  if (!fileProvider.enabled) {
    return {
      scenario: 'SCENARIO_B',
      status: 'BLOCKED_PROVIDER',
      decision: 'FILE_PROVIDER_NOT_CONFIGURED',
      description: 'Traefik is running but does not have dynamic File provider enabled (--providers.file).',
      risks: [
        'Enabling File provider requires editing Traefik startup args and restarting the container.',
        'Restarting Traefik creates a service interruption for existing Dokploy and n8n workloads.',
        'Misconfiguration during Traefik restart could cause downtime across all hosted domains.'
      ],
      alternatives: [
        'Option 1: Operator manually configures a dedicated dynamic configuration directory for Traefik and enables watch mode.',
        'Option 2: Deploy a dedicated, isolated K-Panel reverse proxy container instead of modifying shared Traefik.'
      ],
      recommendation: 'Assess whether dedicated K-Panel reverse proxy is safer than mutating shared Dokploy Traefik.',
      requiresOperatorAction: true
    };
  }

  // Scenario D: Candidate cannot safely join existing proxy network
  const approvedNetId = options.approvedNetworkId || process.env.KPANEL_PROXY_NETWORK_ID;
  const candidateBridgeNet = networks.find((n) =>
    (approvedNetId && (n.id === approvedNetId || n.name === approvedNetId)) ||
    (n.containers && n.containers.some((c) => c.name.includes('traefik')) && n.driver === 'bridge' && !n.name.includes('dokploy') && !n.name.includes('n8n'))
  );

  if (!candidateBridgeNet) {
    return {
      scenario: 'SCENARIO_D',
      status: 'BLOCKED_NETWORK',
      decision: 'NO_APPROVED_PROXY_NETWORK',
      description: 'No approved, isolated bridge proxy network is available for candidate container attachment.',
      risks: [
        'Attaching candidate to foreign Dokploy/n8n network breaks tenant isolation.',
        'Using default bridge or host network leaks container ports and breaks routing guarantees.'
      ],
      recommendation: 'Operator must designate or create a dedicated bridge network attached to Traefik (e.g. kpanel-proxy-net).',
      requiresOperatorAction: true
    };
  }

  // Scenario A: Existing Traefik supports File provider & approved network
  return {
    scenario: 'SCENARIO_A',
    status: 'COMPATIBLE_TOPOLOGY',
    decision: 'DEDICATED_FILE_PROVIDER_AVAILABLE',
    description: 'Existing Traefik supports dynamic File provider with watch mode on an approved bridge network.',
    fileProviderDetails: {
      directory: fileProvider.directory,
      watch: fileProvider.watch,
      dedicatedNamespace: fileProvider.dedicatedNamespace || 'kpanel-routes',
      mountLocation: fileProvider.mountLocation || null,
      hostPath: fileProvider.hostPath || null
    },
    prerequisites: [
      'Verified write access to host directory mapped to Traefik file provider directory.',
      'Active candidate container healthy and isolated in staging network.',
      'Approved proxy network ID confirmed by operator.',
      'Zero routing or domain collisions with existing Dokploy or n8n routes.'
    ],
    activationSafeguards: [
      'Atomic file write using rename to prevent partial configuration reads.',
      'Fresh topology verification (≤ 60 seconds) immediately before traffic switch.',
      'Durable rollback plan to restore previous route file or cleanly remove first release.'
    ],
    requiresOperatorAction: false
  };
}

module.exports = {
  ingestHostInventory,
  classifyResourceOwnership,
  classifyHostIntegrationScenario,
  redactInventoryForReview,
  isValidIsoTimestamp,
  isValidNetworkId,
  HostInventoryError,
  MAX_INVENTORY_PAYLOAD_SIZE,
  DEFAULT_MAX_INVENTORY_AGE_MS,
  MAX_PLANNING_INVENTORY_AGE_MS,
  MAX_ACTIVATION_INVENTORY_AGE_MS
};
