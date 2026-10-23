/**
 * Docker Socket Security & Privilege Boundary Service
 *
 * Provides architectural definitions, privilege audit models, and endpoint
 * permission matrices for segregating Docker daemon access in K-Panel.
 */

class DockerSecurityError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'DockerSecurityError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Architectural Components and their intended Docker Privilege Tier
 */
const PRIVILEGE_TIERS = Object.freeze({
  DASHBOARD_API: 'dashboard-api',
  READ_ONLY_INVENTORY: 'read-only-inventory',
  DEPLOYMENT_EXECUTOR: 'deployment-executor',
  BUILD_EXECUTOR: 'build-executor'
});

/**
 * Docker API Endpoint Permissions Matrix across the 4 Architectural Tiers
 */
const ENDPOINT_PERMISSIONS = Object.freeze({
  [PRIVILEGE_TIERS.DASHBOARD_API]: {
    allowedMethods: [],
    allowedEndpoints: [],
    dockerSocketMounted: false,
    description: 'Public-facing Web UI and user REST API. Strictly zero Docker socket mount or daemon access.'
  },
  [PRIVILEGE_TIERS.READ_ONLY_INVENTORY]: {
    allowedMethods: ['GET'],
    allowedEndpoints: [
      '/version',
      '/info',
      '/_ping',
      '/containers/json',
      '/containers/*/json',
      '/networks',
      '/networks/*',
      '/images/json',
      '/images/*/json'
    ],
    dockerSocketMounted: false, // Accesses via restricted local unix socket proxy or dedicated micro-service
    prohibitedMethods: ['POST', 'DELETE', 'PUT', 'PATCH'],
    prohibitedEndpoints: [
      '/containers/create',
      '/containers/*/start',
      '/containers/*/stop',
      '/containers/*/restart',
      '/containers/*/kill',
      '/containers/*/exec',
      '/build',
      '/networks/create',
      '/networks/*/connect',
      '/networks/*/disconnect',
      '/volumes/create',
      '/volumes/*',
      '/system/prune'
    ],
    description: 'Read-only inspection adapter for host container and network state.'
  },
  [PRIVILEGE_TIERS.DEPLOYMENT_EXECUTOR]: {
    allowedMethods: ['GET', 'POST', 'DELETE'],
    allowedEndpoints: [
      '/containers/create',
      '/containers/*/start',
      '/containers/*/stop',
      '/containers/*/json',
      '/networks/*/connect',
      '/networks/*/disconnect'
    ],
    enforcedConstraints: [
      'io.kpanel.managed=true label required on all created containers',
      'no-new-privileges:true required',
      'CapDrop: ALL required',
      'Zero published host ports for candidate containers',
      'Attachment permitted only to dedicated kpanel-staging-net',
      'Zero attachment to dokploy-network Swarm overlay or foreign networks',
      'Zero host volume bind mounts permitted'
    ],
    prohibitedEndpoints: [
      '/system/prune',
      '/volumes/prune',
      '/containers/prune',
      '/build'
    ],
    description: 'Background worker holding active SQLite lease and monotonic fencing token for candidate staging.'
  },
  [PRIVILEGE_TIERS.BUILD_EXECUTOR]: {
    allowedMethods: ['POST', 'GET'],
    allowedEndpoints: [
      '/build',
      '/images/json',
      '/images/*/json'
    ],
    enforcedConstraints: [
      'Concurrency clamped to 1 (MAX_BUILD_CONCURRENCY = 1)',
      'Isolated BuildKit instance or rootless containerized builder',
      'Zero global builder prune (docker builder prune -a prohibited)',
      '10 GB host disk headroom guard before build dispatch'
    ],
    description: 'Isolated image build worker decoupled from API and dashboard.'
  }
});

/**
 * Audits why a read-only bind mount (/var/run/docker.sock:ro) is insufficient.
 */
function auditSocketMountSecurity() {
  return {
    mountOption: '/var/run/docker.sock:ro',
    isApiReadOnly: false,
    securityFinding: 'CRITICAL_ARCHITECTURAL_MISCONCEPTION',
    explanation: [
      'Mounting /var/run/docker.sock with ":ro" in Docker Compose sets filesystem mount permissions on the socket inode, but does NOT make the Docker API read-only.',
      'The Docker daemon evaluates standard HTTP requests received over the Unix domain socket connection.',
      'Any process with write access to the Unix socket stream can issue HTTP POST, DELETE, and PUT operations to create, mutate, or destroy containers, images, and volumes.',
      'Therefore, exposing /var/run/docker.sock (even labeled :ro) gives complete root-equivalent control of the host Docker engine.'
    ],
    mitigation: 'Segregate Docker access into restricted adapters; never mount docker.sock directly into public web frontends.'
  };
}

/**
 * Evaluates whether a generic Docker socket proxy can safely protect a shared host.
 */
function evaluateSocketProxyEffectiveness() {
  return {
    proxyType: 'generic-docker-socket-proxy (e.g. tecnativa/docker-socket-proxy)',
    effectiveForReadOnly: true,
    effectiveForMutations: false,
    analysis: [
      'A generic socket proxy filtering HTTP methods (e.g. ALLOW_GET=1, ALLOW_POST=0) effectively creates a true read-only adapter.',
      'However, for mutating operations (ALLOW_POST=1 on /containers/create), a generic proxy alone is INSUFFICIENT.',
      'A generic proxy does not validate JSON request bodies. An attacker or bug could POST /containers/create with Binds: ["/:/host:rw"] and Privileged: true, achieving full host root takeover.',
      'Conclusion: Safe privilege separation requires either a dedicated domain-aware K-Panel executor with request-body validation, or rootless/containerized BuildKit isolation.'
    ]
  };
}

/**
 * Evaluates the blast radius of running K-Panel beside 45 existing workloads on Oracle VPS.
 */
function evaluateMultiTenantBlastRadius() {
  return {
    hostWorkloadsObserved: 45,
    criticalNeighbors: [
      'Dokploy core engine and Swarm manager',
      'Traefik v3.6.7 (owns ingress 80/443)',
      'n8n workflow engine (production automations)',
      'Caddy / Nginx reverse proxies',
      'Cloudflare Tunnel daemon'
    ],
    risksOfBroadDockerAccess: [
      'Accidental container deletion or stop (impacting Dokploy, n8n, Traefik).',
      'Global prune commands (docker system prune, docker builder prune) destroying image layers and cache belonging to existing apps.',
      'Network IP address pool exhaustion on the host Docker daemon.',
      'Port binding collision on host interfaces (80, 443, 3000, 5001, 5678, 8080).',
      'Memory / CPU exhaustion triggering Linux OOM killer on critical neighbor containers.'
    ],
    requiredProtections: [
      'Strict label fencing: K-Panel mutates ONLY containers with io.kpanel.managed=true.',
      'Zero global prune: automated system prune is strictly prohibited in code and design.',
      'Isolated bridge network: candidate containers never join dokploy-network or host network.',
      'Conservative resource limits (1 OCPU, 1 GB RAM default per candidate).'
    ]
  };
}

module.exports = {
  PRIVILEGE_TIERS,
  ENDPOINT_PERMISSIONS,
  auditSocketMountSecurity,
  evaluateSocketProxyEffectiveness,
  evaluateMultiTenantBlastRadius,
  DockerSecurityError
};
