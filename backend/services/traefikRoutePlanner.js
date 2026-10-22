const crypto = require('crypto');

/**
 * Structured error class for Traefik route planning operations.
 */
class TraefikRoutePlannerError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TraefikRoutePlannerError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Generates a deterministic, sanitized Traefik router or service identifier.
 * Guarantees RFC 1123 / Traefik-compliant alphanumeric and hyphen characters.
 *
 * @param {string} prefix - Identifier prefix (e.g. 'router', 'service')
 * @param {string} applicationId - Unique application UUID
 * @returns {string} Sanitized deterministic identifier
 */
function getDeterministicIdentifier(prefix, applicationId) {
  if (!applicationId || typeof applicationId !== 'string') {
    throw new TraefikRoutePlannerError('Valid application ID is required to generate route identifiers.', 'INVALID_APPLICATION_ID');
  }

  // Sanitize UUID / application ID to strictly alphanumeric and hyphen
  const cleanAppId = applicationId.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!cleanAppId) {
    throw new TraefikRoutePlannerError('Application ID produced empty sanitized identifier.', 'INVALID_APPLICATION_ID');
  }

  // Create deterministic short hash to guarantee uniqueness and length boundary
  const shortHash = crypto.createHash('sha256').update(applicationId.trim()).digest('hex').slice(0, 8);
  return `kpanel-${prefix}-${cleanAppId.slice(0, 16)}-${shortHash}`;
}

/**
 * Constructs an exact hostname matching rule for Traefik.
 * Strictly prohibits wildcard, regex, or catch-all rules.
 *
 * @param {string} domain - Normalized domain hostname
 * @returns {string} Traefik Host() rule
 */
function buildHostRule(domain) {
  if (!domain || typeof domain !== 'string') {
    throw new TraefikRoutePlannerError('Domain must be a non-empty string.', 'INVALID_DOMAIN');
  }

  const cleanDomain = domain.trim().toLowerCase();
  if (cleanDomain.includes('*') || cleanDomain.startsWith('.')) {
    throw new TraefikRoutePlannerError('Wildcard or catch-all routing rules are strictly prohibited.', 'WILDCARD_ROUTING_PROHIBITED');
  }

  return `Host(\`${cleanDomain}\`)`;
}

/**
 * Plans a structured, pure Traefik routing proposal for a verified release candidate.
 * Strictly generates configuration data without writing files, touching Traefik,
 * or attaching containers to production networks.
 *
 * @param {Object} input - Planning input { applicationId, deploymentId, targetDomain, targetPort, candidateContainerId, targetNetwork }
 * @param {Object} [options] - Optional planner options
 * @returns {Object} Structured proposed route plan
 */
function planTraefikRoute(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new TraefikRoutePlannerError('Route planning input object is required.', 'INVALID_INPUT');
  }

  const {
    applicationId,
    deploymentId,
    targetDomain,
    targetPort,
    candidateContainerId,
    targetNetwork
  } = input;

  if (!applicationId || typeof applicationId !== 'string') {
    throw new TraefikRoutePlannerError('Valid application ID is required.', 'INVALID_APPLICATION_ID');
  }

  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new TraefikRoutePlannerError('Valid deployment ID is required.', 'INVALID_DEPLOYMENT_ID');
  }

  if (!targetDomain || typeof targetDomain !== 'string') {
    throw new TraefikRoutePlannerError('Target domain is required for Traefik route planning.', 'INVALID_DOMAIN');
  }

  const portNum = parseInt(targetPort, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new TraefikRoutePlannerError(`Target internal port must be an integer between 1 and 65535 (received: ${targetPort}).`, 'INVALID_PORT');
  }

  if (!candidateContainerId || typeof candidateContainerId !== 'string') {
    throw new TraefikRoutePlannerError('Candidate container ID is required.', 'INVALID_CONTAINER_ID');
  }

  const routerName = getDeterministicIdentifier('router', applicationId);
  const serviceName = getDeterministicIdentifier('svc', applicationId);
  const hostRule = buildHostRule(targetDomain);

  // Strategy Analysis:
  // Traefik Docker provider labels cannot be dynamically modified without recreating or restarting containers.
  // Recreating containers or relying on label injection causes downtime and cannot do zero-downtime blue/green switches.
  // Dynamic File Provider (or stable upstream proxy routing) is the safe, non-destructive routing strategy.
  const recommendedStrategy = 'dynamic-file-provider';

  // Assess conflict diagnostics and prerequisites for future activation
  const conflictDiagnostics = [];

  // Diagnostic 1: Staging Network Isolation
  conflictDiagnostics.push({
    code: 'STAGING_ISOLATION_ACTIVE',
    severity: 'info',
    message: 'Candidate container remains in isolated staging network. Production proxy network attachment is deferred until activation.'
  });

  // Diagnostic 2: Docker Provider Immutability
  conflictDiagnostics.push({
    code: 'DOCKER_LABELS_IMMUTABLE',
    severity: 'info',
    message: 'Container labels cannot be modified in place. Zero-downtime traffic switching requires dynamic file provider or upstream router.'
  });

  // Diagnostic 3: Foreign Router Collision Risk
  conflictDiagnostics.push({
    code: 'FOREIGN_ROUTER_AUDIT_REQUIRED',
    severity: 'warning',
    message: 'Host may run Dokploy, Coolify, or existing Traefik routers. SQLite validation alone does not prove domain is free on the host proxy.'
  });

  // Diagnostic 4: TLS Certificate Resolver Selection
  conflictDiagnostics.push({
    code: 'TLS_RESOLVER_UNSPECIFIED',
    severity: 'info',
    message: 'No automatic TLS resolver selected. Certificate issuance must be explicitly configured with operator proxy settings.'
  });

  // Structured Proposed Route Specification (Pure Data Model)
  const proposedConfig = {
    http: {
      routers: {
        [routerName]: {
          rule: hostRule,
          service: serviceName,
          entryPoints: ['websecure'],
          tls: {
            certResolver: options.certResolver || null
          }
        }
      },
      services: {
        [serviceName]: {
          loadBalancer: {
            servers: [
              {
                // In future activation, container IP on proxy network will be populated
                url: `http://${candidateContainerId.slice(0, 12)}:${portNum}`
              }
            ],
            passHostHeader: true
          }
        }
      }
    }
  };

  return {
    routeProvider: 'traefik',
    routingStrategy: recommendedStrategy,
    plannedRouterName: routerName,
    plannedServiceName: serviceName,
    hostRule,
    targetDomain: targetDomain.trim().toLowerCase(),
    internalPort: portNum,
    candidateContainerId: candidateContainerId.trim(),
    targetNetwork: targetNetwork || null,
    proposedConfig,
    conflictDiagnostics,
    readinessStatus: 'prepared'
  };
}

module.exports = {
  planTraefikRoute,
  getDeterministicIdentifier,
  buildHostRule,
  TraefikRoutePlannerError
};
