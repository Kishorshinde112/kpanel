const http = require('http');
const https = require('https');
const path = require('path');
const fs = require('fs');
const traefikTopologyService = require('./traefikTopologyService');
const hostInventoryService = require('./hostInventoryService');

/**
 * Structured service error class for Traefik Read-Only Adapter operations.
 */
class TraefikReadOnlyAdapterError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TraefikReadOnlyAdapterError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates whether an HTTP URL points strictly to a preconfigured local or internal loopback address.
 * Rejects arbitrary external domains, public IPs, and non-HTTP protocols.
 *
 * @param {string} urlStr - Target API URL
 * @returns {URL} Parsed and validated URL object
 */
function validateTrustedInternalApiUrl(urlStr) {
  if (!urlStr || typeof urlStr !== 'string') {
    throw new TraefikReadOnlyAdapterError('Internal Traefik API URL must be a non-empty string.', 'INVALID_API_URL');
  }

  let parsed;
  try {
    parsed = new URL(urlStr.trim());
  } catch (err) {
    throw new TraefikReadOnlyAdapterError(`Malformed API URL: ${err.message}`, 'MALFORMED_API_URL');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TraefikReadOnlyAdapterError(`Unsupported protocol "${parsed.protocol}". Must be http or https.`, 'UNSUPPORTED_PROTOCOL');
  }

  // Reject embedded credentials in URL to avoid credential leakage or auth bypass
  if (parsed.username || parsed.password) {
    throw new TraefikReadOnlyAdapterError('Embedded credentials in API URL are strictly prohibited.', 'CREDENTIALS_PROHIBITED');
  }

  const hostname = parsed.hostname.toLowerCase();
  const allowedInternalHosts = ['127.0.0.1', 'localhost', '::1'];
  const configuredHost = process.env.KPANEL_TRAEFIK_INTERNAL_API_HOST
    ? process.env.KPANEL_TRAEFIK_INTERNAL_API_HOST.trim().toLowerCase()
    : null;

  // Prohibit arbitrary internet hostnames, remote cloud destinations, and broad suffixes (.internal, .local)
  if (!allowedInternalHosts.includes(hostname) && (!configuredHost || hostname !== configuredHost)) {
    throw new TraefikReadOnlyAdapterError(
      `API target "${hostname}" is not an authorized local loopback host. External URLs and broad domain suffixes (.internal, .local) are strictly prohibited for SSRF safety.`,
      'UNAUTHORIZED_API_TARGET'
    );
  }

  // Validate port range if specified
  if (parsed.port) {
    const portNum = parseInt(parsed.port, 10);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
      throw new TraefikReadOnlyAdapterError(`Invalid port number "${parsed.port}". Must be between 1 and 65535.`, 'INVALID_PORT');
    }
  }

  return parsed;
}

/**
 * Assesses whether a Traefik File provider configuration satisfies K-Panel's
 * dedicated, non-interfering dynamic route management requirements.
 *
 * Evaluates:
 * 1. Provider actually enabled
 * 2. Dedicated directory vs shared directory
 * 3. Filesystem watch enabled
 * 4. Container mount location / host correspondence
 * 5. Coexistence with Dokploy (namespace collision check)
 * 6. Atomic replacement suitability
 *
 * @param {Object} fileProvider - File provider configuration descriptor
 * @param {Object} [options] - Options
 * @returns {Object} Structured file provider compatibility report
 */
function assessFileProviderCompatibility(fileProvider, options = {}) {
  if (!fileProvider || typeof fileProvider !== 'object') {
    return {
      compatible: false,
      status: 'PROVIDER_MISSING',
      decision: 'FILE_PROVIDER_NOT_CONFIGURED',
      blockedReasons: ['File provider configuration is missing or null.'],
      details: null
    };
  }

  const blockedReasons = [];
  const warnings = [];

  // 1. Is provider enabled?
  if (!fileProvider.enabled) {
    blockedReasons.push('Traefik File provider is not enabled.');
  }

  // 2. Is directory or filename configured?
  const directory = fileProvider.directory ? String(fileProvider.directory).trim() : null;
  const filename = fileProvider.filename ? String(fileProvider.filename).trim() : null;

  if (!directory && !filename) {
    blockedReasons.push('Neither a dynamic directory nor a dynamic filename is configured for the File provider.');
  }

  // 3. Is watch enabled?
  const watchEnabled = Boolean(fileProvider.watch);
  if (!watchEnabled) {
    blockedReasons.push('File provider watch is disabled (--providers.file.watch=false). Route updates would require Traefik restarts.');
  }

  // 4. Directory Security and Host/Container Correspondence
  let pathMismatch = false;
  if (directory) {
    if (directory.includes('..') || directory.includes('\0')) {
      blockedReasons.push('File provider directory contains traversal characters or null bytes.');
    }

    if (fileProvider.hostPath && fileProvider.mountLocation) {
      if (fileProvider.hostPath === fileProvider.mountLocation) {
        warnings.push('Host path and container mount path are identical; verify bind-mount mapping.');
      }
    }

    if (options.expectedHostPath && fileProvider.hostPath && options.expectedHostPath !== fileProvider.hostPath) {
      blockedReasons.push(`File provider host path mismatch: expected "${options.expectedHostPath}", observed "${fileProvider.hostPath}".`);
      pathMismatch = true;
    }

    // Check mount correspondence and read-only mount restriction
    const mounts = options.mounts || fileProvider.mounts;
    if (Array.isArray(mounts)) {
      const matchedMount = mounts.find((m) => m && (m.destination === directory || directory.startsWith(m.destination)));
      if (matchedMount) {
        if (matchedMount.rw === false) {
          blockedReasons.push(`File provider mount at "${matchedMount.destination}" is read-only (rw: false); K-Panel route updates would fail.`);
        }
        if (!fileProvider.hostPath && matchedMount.source) {
          fileProvider.hostPath = matchedMount.source;
        }
      }
    }
  }

  // 5. Dokploy Coexistence & Namespace Separation
  let dokployConflict = false;
  if (fileProvider.dokployCoexistence === true || fileProvider.isShared === true) {
    // If directory is shared with Dokploy, K-Panel MUST have a dedicated namespace or dedicated subdirectory
    const hasDedicatedNamespace = Boolean(fileProvider.dedicatedNamespace || options.dedicatedNamespace);
    if (!hasDedicatedNamespace) {
      blockedReasons.push(
        'File provider directory is shared with Dokploy or other workloads without a verified dedicated subdirectory or file namespace. Collision risk high.'
      );
      dokployConflict = true;
    } else {
      warnings.push('File provider directory is shared with Dokploy under dedicated namespace isolation.');
    }
  }

  // 6. Shared across replicas check
  if (fileProvider.isSharedAcrossReplicas === false && fileProvider.replicaCount > 1) {
    blockedReasons.push('File provider directory is not shared across Traefik replicas; routes would not propagate to all instances.');
  }

  const isCompatible = blockedReasons.length === 0;

  return {
    compatible: isCompatible,
    status: isCompatible ? 'COMPATIBLE' : 'BLOCKED',
    decision: isCompatible
      ? 'FILE_PROVIDER_COMPATIBLE'
      : (dokployConflict ? 'BLOCKED_DOKPLOY_CONFLICT' : (pathMismatch ? 'BLOCKED_PATH_MISMATCH' : 'BLOCKED_PROVIDER_CONFIG')),
    watchEnabled,
    directory,
    filename,
    hasDedicatedNamespace: Boolean(fileProvider.dedicatedNamespace),
    dokployCoexistence: Boolean(fileProvider.dokployCoexistence),
    blockedReasons,
    warnings,
    details: {
      enabled: Boolean(fileProvider.enabled),
      watch: watchEnabled,
      directory,
      mountLocation: fileProvider.mountLocation || null,
      hostPath: fileProvider.hostPath || null
    }
  };
}

/**
 * Fetches read-only data from an explicitly preconfigured local Traefik HTTP API endpoint.
 * Strictly bounds timeouts, disallows redirects, and handles disabled/inaccessible states gracefully.
 *
 * @param {string} pathSuffix - API path (e.g. '/api/http/routers')
 * @param {Object} [options] - Options ({ endpointUrl, timeoutMs })
 * @returns {Promise<Object>} API response payload or structured unavailable outcome
 */
async function queryInternalTraefikApi(pathSuffix, options = {}) {
  // Prohibit user-supplied URLs from untrusted requests; URL must come from server configuration
  const endpointUrl = options.endpointUrl || process.env.KPANEL_TRAEFIK_INTERNAL_API_URL;
  if (!endpointUrl) {
    return {
      status: 'API_DISABLED',
      available: false,
      reason: 'No internal Traefik API endpoint is configured on this host.',
      data: null
    };
  }

  const parsedUrl = validateTrustedInternalApiUrl(endpointUrl);
  const targetUrl = new URL(pathSuffix, parsedUrl);
  const timeoutMs = options.timeoutMs || 2500;

  return new Promise((resolve) => {
    const isHttps = targetUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    const req = client.get(targetUrl, {
      timeout: timeoutMs,
      headers: {
        'Accept': 'application/json',
        'User-Agent': 'KPanel-ReadOnlyAdapter/1.0'
      }
    }, (res) => {
      // Strictly prohibit redirects to prevent SSRF redirection
      if (res.statusCode >= 300 && res.statusCode < 400) {
        req.destroy();
        return resolve({
          status: 'API_INACCESSIBLE',
          available: false,
          statusCode: res.statusCode,
          reason: 'Traefik API attempted HTTP redirect; redirects are strictly prohibited.',
          data: null
        });
      }

      if (res.statusCode !== 200) {
        res.resume();
        return resolve({
          status: res.statusCode === 404 ? 'API_DISABLED' : 'API_INACCESSIBLE',
          available: false,
          statusCode: res.statusCode,
          reason: `Traefik API returned status ${res.statusCode}.`,
          data: null
        });
      }

      let rawData = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        rawData += chunk;
        if (rawData.length > 5 * 1024 * 1024) {
          req.destroy();
          resolve({
            status: 'API_INACCESSIBLE',
            available: false,
            reason: 'Traefik API response exceeded maximum size limit (5 MB).',
            data: null
          });
        }
      });

      res.on('end', () => {
        try {
          const parsedData = JSON.parse(rawData);
          resolve({
            status: 'API_AVAILABLE',
            available: true,
            statusCode: 200,
            data: parsedData
          });
        } catch (parseErr) {
          resolve({
            status: 'API_INACCESSIBLE',
            available: false,
            reason: `Failed to parse Traefik API JSON: ${parseErr.message}`,
            data: null
          });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({
        status: 'API_INACCESSIBLE',
        available: false,
        reason: `Traefik API request timed out after ${timeoutMs}ms.`,
        data: null
      });
    });

    req.on('error', (err) => {
      resolve({
        status: 'API_INACCESSIBLE',
        available: false,
        reason: `Connection to Traefik API failed: ${err.message}`,
        data: null
      });
    });
  });
}

/**
 * Retrieves a normalized Traefik topology snapshot through the appropriate read-only source.
 * Mode A: Injected synthetic snapshot (for tests)
 * Mode B: Operator-provided host inventory
 * Mode C: Optional preconfigured internal HTTP API
 *
 * @param {Object} options - Options ({ mode, snapshot, inventory, inventoryPath, endpointUrl })
 * @returns {Promise<Object>} Topology inspection report
 */
async function fetchReadOnlyTopology(options = {}) {
  const mode = options.mode || (options.snapshot ? 'synthetic' : (options.inventory || options.inventoryPath ? 'inventory' : 'api'));

  // Mode A: Synthetic injected snapshot (offline unit & integration tests)
  if (mode === 'synthetic' || options.snapshot) {
    return traefikTopologyService.inspectRoutingTopology({
      snapshot: options.snapshot,
      sourceType: 'synthetic-snapshot',
      trustedAdapter: true,
      originVerified: true,
      freshnessStatus: options.freshnessStatus || 'fresh',
      traefikInstanceId: options.traefikInstanceId || 'synthetic-traefik-01'
    });
  }

  // Mode B: Operator-Provided Inventory JSON
  if (mode === 'inventory' || options.inventory || options.inventoryPath) {
    let rawInventory = options.inventory;
    if (!rawInventory && options.inventoryPath) {
      if (!fs.existsSync(options.inventoryPath)) {
        return {
          status: 'UNAVAILABLE',
          reason: 'INVENTORY_FILE_NOT_FOUND',
          message: `Inventory file not found at "${options.inventoryPath}".`
        };
      }
      rawInventory = fs.readFileSync(options.inventoryPath, 'utf8');
    }

    const ingested = hostInventoryService.ingestHostInventory(rawInventory, {
      maxAgeMs: options.maxAgeMs,
      trustedAdapter: options.trustedAdapter,
      originVerified: options.originVerified
    });

    return traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: ingested.routers,
        services: ingested.services,
        providers: [
          ingested.providers.file.enabled ? 'file' : null,
          ingested.providers.docker.enabled ? 'docker' : null
        ].filter(Boolean),
        providerMetadata: {
          file: {
            directoryConfigured: Boolean(ingested.providers.file.directory || ingested.providers.file.filename),
            watchEnabled: ingested.providers.file.watch
          }
        }
      },
      sourceType: 'operator-inventory',
      capturedAt: ingested.captureTimestamp,
      freshnessStatus: ingested.freshnessStatus,
      originVerified: ingested.originVerified,
      traefikInstanceId: ingested.traefik.instanceId
    });
  }

  // Mode C: Optional Preconfigured Internal HTTP API
  const apiRes = await queryInternalTraefikApi('/api/http/routers', options);
  if (!apiRes.available) {
    return {
      status: 'UNAVAILABLE',
      reason: apiRes.status,
      message: apiRes.reason,
      routers: [],
      services: [],
      providers: [],
      originVerified: false,
      freshnessStatus: 'unavailable'
    };
  }

  return traefikTopologyService.inspectRoutingTopology({
    snapshot: {
      routers: apiRes.data
    },
    sourceType: 'internal-http-api',
    trustedAdapter: true,
    originVerified: true,
    freshnessStatus: 'fresh'
  });
}

module.exports = {
  fetchReadOnlyTopology,
  assessFileProviderCompatibility,
  queryInternalTraefikApi,
  validateTrustedInternalApiUrl,
  TraefikReadOnlyAdapterError
};
