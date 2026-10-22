const crypto = require('crypto');
const traefikRoutePlanner = require('./traefikRoutePlanner');

/**
 * Decision codes for route conflict evaluation.
 */
const CONFLICT_DECISIONS = {
  AVAILABLE_VERIFIED: 'AVAILABLE_VERIFIED',
  OWNED_BY_KPANEL: 'OWNED_BY_KPANEL',
  FOREIGN_ROUTE_CONFLICT: 'FOREIGN_ROUTE_CONFLICT',
  ROUTE_CONFLICT_UNDETERMINED: 'ROUTE_CONFLICT_UNDETERMINED',
  TOPOLOGY_UNAVAILABLE: 'TOPOLOGY_UNAVAILABLE',
  ROUTING_PROVIDER_NOT_CONFIGURED: 'ROUTING_PROVIDER_NOT_CONFIGURED'
};

/**
 * Structured service error class for Route Conflict operations.
 */
class RouteConflictError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'RouteConflictError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Checks whether a router's entrypoints overlap with the target entrypoints.
 */
function entryPointsOverlap(routerEntryPoints = [], targetEntryPoints = ['websecure']) {
  if (!routerEntryPoints.length || !targetEntryPoints.length) return true;
  const routerSet = new Set(routerEntryPoints.map((ep) => ep.toLowerCase()));
  return targetEntryPoints.some((ep) => routerSet.has(ep.toLowerCase()));
}

/**
 * Evaluates whether a domain matches a wildcard pattern (e.g. "*.example.com").
 */
function matchesWildcard(targetDomain, wildcardDomain) {
  if (!wildcardDomain || !wildcardDomain.startsWith('*.')) return false;
  const suffix = wildcardDomain.slice(1); // e.g. ".example.com"
  return targetDomain.endsWith(suffix) && targetDomain !== suffix.slice(1);
}

/**
 * Evaluates a proposed K-Panel routing plan against a complete Traefik topology snapshot.
 * Detects exact host collisions, regex patterns, wildcards, provider namespaces,
 * and foreign workloads (Dokploy, n8n, other applications).
 *
 * @param {Object} input - { targetDomain, applicationId, entryPoints, tlsRequired }
 * @param {Object} topology - Normalized topology report from inspectRoutingTopology
 * @param {Object} [options] - Options ({ requiredProvider, allowedKpanelRouterNames })
 * @returns {Object} Structured route conflict assessment report
 */
function evaluateRouteConflicts(input, topology, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new RouteConflictError('Route conflict input object is required.', 'INVALID_INPUT');
  }

  const { targetDomain, applicationId } = input;
  if (!targetDomain || typeof targetDomain !== 'string') {
    throw new RouteConflictError('Valid target domain is required to evaluate route conflicts.', 'INVALID_DOMAIN');
  }

  const cleanTargetDomain = targetDomain.trim().toLowerCase();
  const cleanAppId = applicationId ? applicationId.trim().toLowerCase() : '';
  const targetEntryPoints = Array.isArray(input.entryPoints) && input.entryPoints.length
    ? input.entryPoints.map((ep) => ep.toLowerCase())
    : ['websecure'];

  // 1. Check if Topology is Available
  if (!topology || topology.status !== 'AVAILABLE') {
    return {
      decision: CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE,
      targetDomain: cleanTargetDomain,
      applicationId: cleanAppId,
      conflicts: [],
      matchingRouters: [],
      reason: topology?.reason || 'TOPOLOGY_UNAVAILABLE',
      message: 'Traefik routing topology is unavailable or unconfigured. Cannot verify domain availability.'
    };
  }

  // 2. Check if Required Provider is Configured
  if (options.requiredProvider) {
    const requiredProv = String(options.requiredProvider).toLowerCase().trim();
    const activeProviders = (topology.providers || []).map((p) => p.toLowerCase());
    if (!activeProviders.includes(requiredProv)) {
      return {
        decision: CONFLICT_DECISIONS.ROUTING_PROVIDER_NOT_CONFIGURED,
        targetDomain: cleanTargetDomain,
        applicationId: cleanAppId,
        conflicts: [],
        matchingRouters: [],
        reason: 'ROUTING_PROVIDER_NOT_CONFIGURED',
        message: `Required routing provider "${requiredProv}" is not active or configured in the Traefik topology.`
      };
    }
  }

  const conflicts = [];
  const matchingRouters = [];
  let hasUndetermined = false;

  // Expected K-Panel router identifier pattern for this application
  const expectedRouterPrefix = cleanAppId
    ? `kpanel-router-${cleanAppId.replace(/[^a-z0-9-]/g, '').slice(0, 16)}`
    : '';

  // 3. Scan all routers in the topology snapshot
  for (const router of (topology.routers || [])) {
    // Only compare if entrypoints overlap
    if (!entryPointsOverlap(router.entryPoints, targetEntryPoints)) {
      continue;
    }

    let isMatch = false;
    let matchType = null;
    let matchPattern = null;

    // Check A: Exact Hostname Match
    if (router.hostnames && router.hostnames.includes(cleanTargetDomain)) {
      isMatch = true;
      matchType = 'exact-host';
      matchPattern = cleanTargetDomain;
    }

    // Check B: Wildcard Match
    if (!isMatch && router.isWildcard && router.hostnames) {
      for (const h of router.hostnames) {
        if (matchesWildcard(cleanTargetDomain, h)) {
          isMatch = true;
          matchType = 'wildcard-host';
          matchPattern = h;
          break;
        }
      }
    }

    // Check C: HostRegexp Match
    if (!isMatch && router.regexPatterns && router.regexPatterns.length > 0) {
      for (const pattern of router.regexPatterns) {
        try {
          // Traefik HostRegexp can use named capture syntax: {subdomain:[a-z0-9-]+}.example.com
          // Convert Traefik capture syntax to standard JS regex for evaluation
          const jsPattern = pattern.replace(/\{[a-zA-Z0-9_-]+:([^}]+)\}/g, '($1)');
          const regex = new RegExp(`^${jsPattern}$`, 'i');
          if (regex.test(cleanTargetDomain)) {
            isMatch = true;
            matchType = 'regexp-host';
            matchPattern = pattern;
            break;
          }
        } catch {
          // If regex is unparseable or complex, flag as undetermined
          hasUndetermined = true;
          conflicts.push({
            routerName: router.name,
            provider: router.provider,
            rule: router.rule,
            conflictType: 'UNDETERMINED_REGEX',
            message: `Router "${router.name}" has a HostRegexp rule that could not be deterministically evaluated.`
          });
        }
      }
    }

    // Check D: Complex or Unparseable Rule mentioning the domain
    if (!isMatch && router.isComplex && router.rule.toLowerCase().includes(cleanTargetDomain)) {
      hasUndetermined = true;
      conflicts.push({
        routerName: router.name,
        provider: router.provider,
        rule: router.rule,
        conflictType: 'UNDETERMINED_COMPLEX_RULE',
        message: `Router "${router.name}" contains complex rule syntax matching target domain that cannot be reliably analyzed.`
      });
      continue;
    }

    if (isMatch) {
      // 4. Classify Router Ownership
      const lowerName = router.name.toLowerCase();
      const lowerRawName = (router.rawName || '').toLowerCase();
      const lowerService = (router.service || '').toLowerCase();

      let ownerCategory;
      let isCurrentAppOwned = false;

      if (
        (expectedRouterPrefix && (lowerName.startsWith(expectedRouterPrefix) || lowerRawName.startsWith(expectedRouterPrefix))) ||
        (options.allowedKpanelRouterNames && options.allowedKpanelRouterNames.includes(router.name))
      ) {
        ownerCategory = 'KPANEL_CURRENT_APP';
        isCurrentAppOwned = true;
      } else if (lowerName.includes('dokploy') || lowerService.includes('dokploy')) {
        ownerCategory = 'FOREIGN_DOKPLOY';
      } else if (lowerName.includes('n8n') || lowerService.includes('n8n')) {
        ownerCategory = 'FOREIGN_N8N';
      } else if (lowerName.startsWith('kpanel-router-')) {
        ownerCategory = 'FOREIGN_KPANEL_APP';
      } else {
        ownerCategory = 'FOREIGN_GENERIC';
      }

      const matchDetails = {
        routerName: router.name,
        rawName: router.rawName,
        provider: router.provider,
        rule: router.rule,
        service: router.service,
        priority: router.priority,
        entryPoints: router.entryPoints,
        tls: router.tls,
        matchType,
        matchPattern,
        ownerCategory,
        isCurrentAppOwned
      };

      matchingRouters.push(matchDetails);

      if (!isCurrentAppOwned) {
        conflicts.push({
          routerName: router.name,
          provider: router.provider,
          rule: router.rule,
          service: router.service,
          ownerCategory,
          conflictType: matchType === 'exact-host' ? 'EXACT_HOST_COLLISION' : 'PATTERN_HOST_COLLISION',
          message: `Host collision with ${ownerCategory} router "${router.name}" via rule "${router.rule}".`
        });
      }
    }
  }

  // 5. Synthesize Final Conflict Decision
  let decision;
  let reason = null;

  if (hasUndetermined) {
    decision = CONFLICT_DECISIONS.ROUTE_CONFLICT_UNDETERMINED;
    reason = 'One or more router rules could not be safely or deterministically evaluated.';
  } else if (conflicts.length > 0) {
    decision = CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT;
    reason = `Domain "${cleanTargetDomain}" collides with ${conflicts.length} foreign router(s).`;
  } else if (matchingRouters.length > 0 && matchingRouters.every((r) => r.isCurrentAppOwned)) {
    decision = CONFLICT_DECISIONS.OWNED_BY_KPANEL;
    reason = `Domain "${cleanTargetDomain}" is currently served by an existing K-Panel route for this application.`;
  } else {
    decision = CONFLICT_DECISIONS.AVAILABLE_VERIFIED;
    reason = `Domain "${cleanTargetDomain}" has no active router conflicts in the verified topology.`;
  }

  return {
    decision,
    targetDomain: cleanTargetDomain,
    applicationId: cleanAppId,
    conflicts,
    matchingRouters,
    topologyFingerprint: topology.snapshotFingerprint,
    reason,
    message: reason
  };
}

module.exports = {
  evaluateRouteConflicts,
  matchesWildcard,
  entryPointsOverlap,
  CONFLICT_DECISIONS,
  RouteConflictError
};
