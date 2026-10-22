const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Structured service error class for Traefik Topology operations.
 */
class TraefikTopologyError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TraefikTopologyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Extracts provider namespace from a Traefik object name (e.g. "my-router@docker" -> { rawName: "my-router", provider: "docker" }).
 *
 * @param {string} fullName - Full Traefik object name
 * @returns {Object} { rawName, provider }
 */
function parseProviderNamespace(fullName) {
  if (!fullName || typeof fullName !== 'string') {
    return { rawName: '', provider: 'unknown' };
  }
  const clean = fullName.trim();
  const atIdx = clean.lastIndexOf('@');
  if (atIdx > 0 && atIdx < clean.length - 1) {
    return {
      rawName: clean.slice(0, atIdx),
      provider: clean.slice(atIdx + 1).toLowerCase()
    };
  }
  return {
    rawName: clean,
    provider: 'unknown'
  };
}

/**
 * Safely parses hostnames from a Traefik rule string (Host and HostRegexp).
 *
 * @param {string} rule - Traefik rule string
 * @returns {Object} { hostnames: string[], regexPatterns: string[], isWildcard: boolean, isComplex: boolean }
 */
function parseRuleHostnames(rule) {
  if (!rule || typeof rule !== 'string') {
    return { hostnames: [], regexPatterns: [], isWildcard: false, isComplex: false };
  }

  const cleanRule = rule.trim();
  const hostnames = [];
  const regexPatterns = [];
  let isWildcard = false;
  let isComplex = false;

  // 1. Match Host(`...`) or Host('...') or Host("...")
  // Traefik supports multiple comma-separated arguments: Host(`a.com`, `b.com`)
  const hostCallMatches = cleanRule.matchAll(/Host\(([^)]+)\)/g);
  for (const match of hostCallMatches) {
    const argsContent = match[1];
    const hostArgs = argsContent.matchAll(/[`'"]([^`'"]+)[`'"]/g);
    let matchedArg = false;
    for (const h of hostArgs) {
      matchedArg = true;
      const host = h[1].trim().toLowerCase();
      if (host.includes('*')) {
        isWildcard = true;
      }
      hostnames.push(host);
    }
    if (!matchedArg) {
      isComplex = true;
    }
  }

  // 2. Match HostRegexp(`...`)
  const regexpMatches = cleanRule.matchAll(/HostRegexp\(([^)]+)\)/g);
  for (const match of regexpMatches) {
    const argsContent = match[1];
    const regexArgs = argsContent.matchAll(/[`'"]([^`'"]+)[`'"]/g);
    let matchedArg = false;
    for (const r of regexArgs) {
      matchedArg = true;
      const pattern = r[1].trim();
      regexPatterns.push(pattern);
    }
    if (!matchedArg) {
      isComplex = true;
    }
  }

  // 3. Detect unparseable or complex boolean logic
  // Unbalanced parens or unhandled top-level negations
  const openParens = (cleanRule.match(/\(/g) || []).length;
  const closeParens = (cleanRule.match(/\)/g) || []).length;
  if (openParens !== closeParens) {
    isComplex = true;
  }

  return {
    hostnames,
    regexPatterns,
    isWildcard,
    isComplex
  };
}

/**
 * Computes a deterministic SHA-256 fingerprint for a canonical list of normalized routers.
 *
 * @param {Array<Object>} routers - Normalized router objects
 * @returns {string} Hex SHA-256 digest
 */
function computeTopologyFingerprint(routers) {
  const canonical = (routers || []).map((r) => ({
    name: r.name,
    provider: r.provider,
    rule: r.rule,
    entryPoints: (r.entryPoints || []).slice().sort(),
    service: r.service,
    status: r.status
  })).sort((a, b) => a.name.localeCompare(b.name));

  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/**
 * Inspects the current Traefik routing topology in pure read-only mode.
 * Supports injected snapshots, read-only snapshot JSON files, and mock clients.
 * Never mutates Traefik, never exposes dashboards, and fails closed when topology is unavailable.
 *
 * @param {Object} [options] - Options ({ snapshot, snapshotJson, snapshotPath, ... })
 * @returns {Object} Structured topology status report
 */
function inspectRoutingTopology(options = {}) {
  let rawData = null;

  // 1. Direct snapshot object injection (Offline tests / cached adapter)
  if (options.snapshot && typeof options.snapshot === 'object') {
    rawData = options.snapshot;
  } else if (options.snapshotJson && typeof options.snapshotJson === 'string') {
    try {
      if (options.snapshotJson.length > 5 * 1024 * 1024) {
        throw new TraefikTopologyError('Snapshot exceeds maximum allowed size of 5 MB.', 'PAYLOAD_TOO_LARGE');
      }
      rawData = JSON.parse(options.snapshotJson);
    } catch (parseErr) {
      return {
        status: 'UNAVAILABLE',
        source: 'json-string',
        routers: [],
        services: [],
        providers: [],
        snapshotFingerprint: null,
        checkedAt: new Date().toISOString(),
        reason: 'TOPOLOGY_PARSE_ERROR',
        message: `Failed to parse topology snapshot JSON: ${parseErr.message}`
      };
    }
  } else if (options.snapshotPath && typeof options.snapshotPath === 'string') {
    const rawPath = options.snapshotPath.trim();
    // Path traversal and null byte rejection
    if (rawPath.includes('\0') || rawPath.includes('..')) {
      return {
        status: 'UNAVAILABLE',
        source: 'file',
        routers: [],
        services: [],
        providers: [],
        snapshotFingerprint: null,
        checkedAt: new Date().toISOString(),
        reason: 'UNAUTHORIZED_SNAPSHOT_PATH',
        message: 'Snapshot path contains invalid traversal characters or null bytes.'
      };
    }

    const resolvedPath = path.resolve(rawPath);
    const forbiddenPrefixes = ['/etc', '/proc', '/sys', '/dev', '/var/run', '/root', '/boot'];
    if (forbiddenPrefixes.some((p) => resolvedPath === p || resolvedPath.startsWith(p + path.sep))) {
      return {
        status: 'UNAVAILABLE',
        source: 'file',
        routers: [],
        services: [],
        providers: [],
        snapshotFingerprint: null,
        checkedAt: new Date().toISOString(),
        reason: 'UNAUTHORIZED_SNAPSHOT_PATH',
        message: `Snapshot path "${resolvedPath}" is within an unauthorized system directory.`
      };
    }

    if (options.allowedDirectory) {
      const allowedRoot = path.resolve(options.allowedDirectory);
      if (resolvedPath !== allowedRoot && !resolvedPath.startsWith(allowedRoot + path.sep)) {
        return {
          status: 'UNAVAILABLE',
          source: 'file',
          routers: [],
          services: [],
          providers: [],
          snapshotFingerprint: null,
          checkedAt: new Date().toISOString(),
          reason: 'UNAUTHORIZED_SNAPSHOT_PATH',
          message: `Snapshot path "${resolvedPath}" is outside the authorized directory.`
        };
      }
    }

    try {
      if (!fs.existsSync(resolvedPath)) {
        return {
          status: 'UNAVAILABLE',
          source: 'file',
          routers: [],
          services: [],
          providers: [],
          snapshotFingerprint: null,
          checkedAt: new Date().toISOString(),
          reason: 'SNAPSHOT_FILE_NOT_FOUND',
          message: `Snapshot file not found at path "${resolvedPath}".`
        };
      }
      const fileContent = fs.readFileSync(resolvedPath, 'utf8');
      rawData = JSON.parse(fileContent);
    } catch (fileErr) {
      return {
        status: 'UNAVAILABLE',
        source: 'file',
        routers: [],
        services: [],
        providers: [],
        snapshotFingerprint: null,
        checkedAt: new Date().toISOString(),
        reason: 'SNAPSHOT_READ_FAILED',
        message: `Failed to read snapshot file: ${fileErr.message}`
      };
    }
  }

  // If no snapshot or configuration was provided
  if (!rawData) {
    return {
      status: 'UNAVAILABLE',
      source: 'none',
      routers: [],
      services: [],
      providers: [],
      snapshotFingerprint: null,
      checkedAt: new Date().toISOString(),
      reason: 'TOPOLOGY_UNAVAILABLE',
      message: 'Traefik routing topology is unavailable or unconfigured.'
    };
  }

  // 2. Normalize Routers
  const normalizedRouters = [];
  const providersSet = new Set();

  if (Array.isArray(rawData.providers)) {
    for (const p of rawData.providers) {
      if (typeof p === 'string' && p.trim()) {
        providersSet.add(p.trim().toLowerCase());
      }
    }
  }
  if (Array.isArray(options.providers)) {
    for (const p of options.providers) {
      if (typeof p === 'string' && p.trim()) {
        providersSet.add(p.trim().toLowerCase());
      }
    }
  }

  // Support both Traefik API map format ({ [routerName]: routerObj }) and array format
  const rawRouters = rawData.routers || rawData.http?.routers || [];
  const routerEntries = Array.isArray(rawRouters)
    ? rawRouters.map((r) => [r.name, r])
    : Object.entries(rawRouters);

  for (const [key, obj] of routerEntries) {
    if (!obj || typeof obj !== 'object') continue;

    const fullName = String(obj.name || key || '').trim();
    if (!fullName) continue;

    const { rawName, provider: detectedProvider } = parseProviderNamespace(fullName);
    const finalProvider = (obj.provider || detectedProvider || 'unknown').toLowerCase();
    providersSet.add(finalProvider);

    const rule = String(obj.rule || '').trim();
    const { hostnames, regexPatterns, isWildcard, isComplex } = parseRuleHostnames(rule);

    const entryPoints = Array.isArray(obj.entryPoints)
      ? obj.entryPoints.map((ep) => String(ep).trim().toLowerCase())
      : (obj.entryPoints ? [String(obj.entryPoints).trim().toLowerCase()] : ['websecure']);

    const service = String(obj.service || '').trim();
    const priority = Number.isInteger(obj.priority) ? obj.priority : null;
    const status = String(obj.status || 'enabled').toLowerCase();

    const tls = {
      enabled: Boolean(obj.tls),
      certResolver: (typeof obj.tls === 'object' && obj.tls?.certResolver) ? String(obj.tls.certResolver) : null
    };

    const middlewares = Array.isArray(obj.middlewares)
      ? obj.middlewares.map((m) => String(m).trim())
      : [];

    normalizedRouters.push({
      name: fullName,
      rawName,
      provider: finalProvider,
      rule,
      entryPoints,
      service,
      priority,
      status,
      tls,
      middlewares,
      hostnames,
      regexPatterns,
      isWildcard,
      isComplex
    });
  }

  // 3. Normalize Services
  const normalizedServices = [];
  const rawServices = rawData.services || rawData.http?.services || [];
  const serviceEntries = Array.isArray(rawServices)
    ? rawServices.map((s) => [s.name, s])
    : Object.entries(rawServices);

  for (const [key, obj] of serviceEntries) {
    if (!obj || typeof obj !== 'object') continue;
    const fullName = String(obj.name || key || '').trim();
    if (!fullName) continue;

    const { rawName, provider } = parseProviderNamespace(fullName);
    const servers = [];
    if (obj.loadBalancer?.servers && Array.isArray(obj.loadBalancer.servers)) {
      for (const s of obj.loadBalancer.servers) {
        if (s && s.url) {
          servers.push({ url: String(s.url).trim() });
        }
      }
    }

    normalizedServices.push({
      name: fullName,
      rawName,
      provider,
      type: obj.type || 'loadbalancer',
      servers,
      passHostHeader: Boolean(obj.loadBalancer?.passHostHeader)
    });
  }

  const snapshotFingerprint = computeTopologyFingerprint(normalizedRouters);
  const capturedAt = options.capturedAt || rawData.capturedAt || rawData.checkedAt || new Date().toISOString();

  let freshnessStatus = options.freshnessStatus;
  if (!freshnessStatus) {
    if (options.expired === true) {
      freshnessStatus = 'expired';
    } else {
      const maxAgeMs = options.maxAgeMs !== undefined ? options.maxAgeMs : (rawData.maxAgeMs || 60000);
      const snapTime = Date.parse(capturedAt);
      const isExpired = isNaN(snapTime) || (Date.now() - snapTime > maxAgeMs);
      freshnessStatus = isExpired ? 'expired' : 'fresh';
    }
  }

  const sourceType = options.sourceType || (options.snapshot ? 'memory' : (options.snapshotPath ? 'file' : 'json-string'));
  // Security: A JSON payload field claiming `originVerified: true` must NOT itself establish trust.
  // Provenance is determined strictly by the server-side adapter and configured source.
  // Injected memory snapshots in server tests are trusted; unverified files and JSON strings are not.
  const originVerified = Boolean(
    options.originVerified !== undefined
      ? options.originVerified
      : (options.trustedAdapter === true || (Boolean(options.snapshot) && !options.snapshotPath && !options.untrustedSnapshot))
  );
  const traefikInstanceId = rawData.traefikInstanceId || rawData.instanceId || options.traefikInstanceId || null;
  const configurationVersion = rawData.configurationVersion || rawData.version || null;
  const providerMetadata = rawData.providerMetadata || options.providerMetadata || {
    active: Array.from(providersSet),
    file: { directoryConfigured: providersSet.has('file') }
  };

  return {
    status: 'AVAILABLE',
    source: sourceType,
    sourceType,
    capturedAt,
    freshnessStatus,
    originVerified,
    traefikInstanceId,
    configurationVersion,
    providerMetadata,
    routers: normalizedRouters,
    services: normalizedServices,
    providers: Array.from(providersSet),
    snapshotFingerprint,
    checkedAt: new Date().toISOString(),
    reason: null,
    message: `Topology successfully inspected with ${normalizedRouters.length} routers across ${providersSet.size} providers.`
  };
}

module.exports = {
  inspectRoutingTopology,
  parseProviderNamespace,
  parseRuleHostnames,
  computeTopologyFingerprint,
  TraefikTopologyError
};
