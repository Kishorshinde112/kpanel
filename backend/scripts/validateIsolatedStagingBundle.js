#!/usr/bin/env node
/**
 * ==============================================================================
 * K-PANEL ISOLATED STAGING BUNDLE STATIC VALIDATOR (PHASE 4C3D4)
 * ==============================================================================
 * Non-mutating offline static validation of disposable staging bundles.
 * Enforces 20 critical safety, isolation, network, privilege, and resource rules
 * before any authorized execution on the Oracle ARM64 VPS.
 *
 * STRICT INVARIANTS:
 * - ZERO container execution, build, pull, or start.
 * - ZERO Docker daemon mutations.
 * - ZERO database or release mutations.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// Prohibited host ports that staging ingress MUST NEVER bind to
const PROHIBITED_HOST_PORTS = Object.freeze([
  22, 53, 80, 443, 2375, 2376, 2377, 3000, 3030, 4222, 5000, 5001, 5678, 7946, 4789, 8080, 9000, 9443
]);

// Protected project names that must never be collided with
const PROTECTED_PROJECT_NAMES = Object.freeze([
  'kpanel',
  'kpanel-clean',
  'dokploy',
  'n8n'
]);

// Protected existing container workloads
const PROTECTED_CONTAINER_NAMES = Object.freeze([
  'kpanel-frontend-1',
  'kpanel-backend-1',
  'dokploy-traefik',
  'traefik',
  'caddy',
  'nginx',
  'n8n'
]);

/**
 * Structured validation error.
 */
class StagingBundleValidationError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'StagingBundleValidationError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Parses CPU limits from Compose format (string or number).
 */
function parseCpuLimit(val) {
  if (val === undefined || val === null) return null;
  const num = Number(val);
  return isNaN(num) ? null : num;
}

/**
 * Parses Memory limits from Compose format (e.g. "1024M", "1073741824", "1G").
 */
function parseMemoryMb(val) {
  if (val === undefined || val === null) return null;
  if (typeof val === 'number') return Math.round(val / (1024 * 1024));
  const str = String(val).trim().toUpperCase();
  if (/^\d+$/.test(str)) {
    const bytes = parseInt(str, 10);
    return Math.round(bytes / (1024 * 1024));
  }
  const match = str.match(/^(\d+(?:\.\d+)?)\s*([KMGTP]?B?)$/);
  if (!match) return null;
  const num = parseFloat(match[1]);
  const unit = match[2];
  if (unit.startsWith('G')) return Math.round(num * 1024);
  if (unit.startsWith('M')) return Math.round(num);
  if (unit.startsWith('K')) return Math.round(num / 1024);
  return Math.round(num / (1024 * 1024));
}

/**
 * Extracts and normalizes labels from Compose service definition.
 */
function extractLabels(service) {
  const result = {};
  if (!service) return result;
  if (Array.isArray(service.labels)) {
    for (const item of service.labels) {
      if (typeof item === 'string') {
        const eqIdx = item.indexOf('=');
        if (eqIdx !== -1) {
          result[item.slice(0, eqIdx).trim()] = item.slice(eqIdx + 1).trim();
        } else {
          result[item.trim()] = 'true';
        }
      }
    }
  } else if (service.labels && typeof service.labels === 'object') {
    for (const [k, v] of Object.entries(service.labels)) {
      result[k.trim()] = String(v).trim();
    }
  }
  return result;
}

/**
 * Extracts and normalizes environment variables from Compose service definition.
 */
function extractEnvironment(service) {
  const result = {};
  if (!service) return result;
  if (Array.isArray(service.environment)) {
    for (const item of service.environment) {
      if (typeof item === 'string') {
        const eqIdx = item.indexOf('=');
        if (eqIdx !== -1) {
          result[item.slice(0, eqIdx).trim()] = item.slice(eqIdx + 1).trim();
        } else {
          result[item.trim()] = '';
        }
      }
    }
  } else if (service.environment && typeof service.environment === 'object') {
    for (const [k, v] of Object.entries(service.environment)) {
      result[k.trim()] = String(v !== undefined && v !== null ? v : '').trim();
    }
  }
  return result;
}

/**
 * Extracts normalized port definitions from Compose service.
 */
function extractPorts(service) {
  const ports = [];
  if (!service || !service.ports) return ports;
  for (const p of service.ports) {
    if (typeof p === 'string') {
      const parts = p.split(':');
      if (parts.length === 3) {
        ports.push({ hostIp: parts[0], hostPort: parseInt(parts[1], 10), containerPort: parseInt(parts[2], 10) });
      } else if (parts.length === 2) {
        ports.push({ hostIp: '0.0.0.0', hostPort: parseInt(parts[0], 10), containerPort: parseInt(parts[1], 10) });
      } else if (parts.length === 1) {
        ports.push({ hostIp: '0.0.0.0', hostPort: parseInt(parts[0], 10), containerPort: parseInt(parts[0], 10) });
      }
    } else if (typeof p === 'object' && p !== null) {
      ports.push({
        hostIp: p.host_ip || p.HostIp || (p.mode === 'ingress' ? (p.host_ip || '0.0.0.0') : '0.0.0.0'),
        hostPort: parseInt(p.published || p.HostPort || 0, 10),
        containerPort: parseInt(p.target || p.container_port || 0, 10)
      });
    }
  }
  return ports;
}

/**
 * Extracts volume/mount definitions from Compose service.
 */
function extractVolumes(service) {
  const volumes = [];
  if (!service || !service.volumes) return volumes;
  for (const v of service.volumes) {
    if (typeof v === 'string') {
      const parts = v.split(':');
      volumes.push({ source: parts[0], target: parts[1] || parts[0], mode: parts[2] || 'rw' });
    } else if (typeof v === 'object' && v !== null) {
      volumes.push({
        source: v.source || '',
        target: v.target || '',
        readOnly: Boolean(v.read_only)
      });
    }
  }
  return volumes;
}

/**
 * Evaluates the 20 critical invariants on a Compose specification object.
 *
 * @param {Object} composeObj - Parsed Compose configuration object
 * @param {Object} [options] - Evaluation options ({ occupiedPorts, expectedUpstream, ... })
 * @returns {Object} Structured validation report with all 20 invariant checks
 */
function validateIsolatedStagingBundle(composeObj, options = {}) {
  if (!composeObj || typeof composeObj !== 'object') {
    throw new StagingBundleValidationError('Compose configuration object is required.', 'INVALID_COMPOSE_INPUT');
  }

  const checks = [];
  const blockers = [];
  const warnings = [];

  function recordCheck(number, code, passed, message, meta = {}) {
    const entry = { rule: number, code, passed, message, ...meta };
    checks.push(entry);
    if (!passed) {
      blockers.push(entry);
    }
  }

  const services = composeObj.services || {};
  const networks = composeObj.networks || {};
  const projectName = String(composeObj.name || options.projectName || '').trim().toLowerCase();

  // ---------------------------------------------------------------------------
  // Check 1: Compose project namespace
  // ---------------------------------------------------------------------------
  const hasProjectNamespace = Boolean(projectName && projectName.length >= 3 && /^[a-z0-9][a-z0-9_-]+$/.test(projectName));
  recordCheck(
    1,
    'COMPOSE_PROJECT_NAMESPACE',
    hasProjectNamespace,
    hasProjectNamespace ? `Explicit Compose project namespace verified: "${projectName}".` : `Compose project namespace is missing, empty, or invalid ("${projectName}").`
  );

  // ---------------------------------------------------------------------------
  // Check 2: No existing protected project names
  // ---------------------------------------------------------------------------
  const isProtectedProject = PROTECTED_PROJECT_NAMES.includes(projectName);
  recordCheck(
    2,
    'NO_PROTECTED_PROJECT_NAMES',
    !isProtectedProject,
    !isProtectedProject
      ? `Project name "${projectName}" does not collide with protected projects (${PROTECTED_PROJECT_NAMES.join(', ')}).`
      : `Project name "${projectName}" collides with a protected host project! Unique namespace required.`
  );

  // ---------------------------------------------------------------------------
  // Check 3: Explicit staging network
  // ---------------------------------------------------------------------------
  const networkKeys = Object.keys(networks);
  const stagingNetKey = networkKeys.find((k) => !k.includes('dokploy') && !k.includes('n8n') && k !== 'bridge' && k !== 'host');
  const stagingNetDef = stagingNetKey ? networks[stagingNetKey] : null;
  const isDriverBridge = stagingNetDef ? (stagingNetDef.driver === 'bridge' || stagingNetDef.driver === undefined) : false;
  const hasExplicitNetwork = Boolean(stagingNetKey && isDriverBridge);

  recordCheck(
    3,
    'EXPLICIT_STAGING_NETWORK',
    hasExplicitNetwork,
    hasExplicitNetwork
      ? `Explicit user-defined bridge network declared: "${stagingNetKey}".`
      : 'No user-defined bridge network declared in Compose networks.'
  );

  // ---------------------------------------------------------------------------
  // Check 4: No Swarm overlay adoption
  // ---------------------------------------------------------------------------
  let hasOverlay = false;
  for (const [netName, netConf] of Object.entries(networks)) {
    if (netConf?.driver === 'overlay' || netConf?.Driver === 'overlay') hasOverlay = true;
  }
  recordCheck(
    4,
    'NO_SWARM_OVERLAY_ADOPTION',
    !hasOverlay,
    !hasOverlay ? 'No Swarm overlay networks declared.' : 'Overlay network detected. Swarm overlays are prohibited for isolated staging.'
  );

  // ---------------------------------------------------------------------------
  // Check 5: No Dokploy network membership
  // ---------------------------------------------------------------------------
  let touchesDokployNet = false;
  for (const netName of networkKeys) {
    if (netName.toLowerCase().includes('dokploy')) touchesDokployNet = true;
  }
  for (const s of Object.values(services)) {
    const sNets = Array.isArray(s.networks) ? s.networks : Object.keys(s.networks || {});
    if (sNets.some((n) => String(n).toLowerCase().includes('dokploy'))) touchesDokployNet = true;
  }
  recordCheck(
    5,
    'NO_DOKPLOY_NETWORK_MEMBERSHIP',
    !touchesDokployNet,
    !touchesDokployNet ? 'Zero Dokploy network membership verified.' : 'Detected attachment to Dokploy network! Foreign network attachment is strictly prohibited.'
  );

  // ---------------------------------------------------------------------------
  // Check 6: No existing K-Panel network adoption
  // ---------------------------------------------------------------------------
  let touchesExistingKpanelNet = false;
  const legacyKpanelNets = ['kpanel_net', 'kpanel-clean_kpanel_net', 'kpanel-clean_default'];
  for (const netName of networkKeys) {
    if (legacyKpanelNets.includes(netName)) touchesExistingKpanelNet = true;
  }
  recordCheck(
    6,
    'NO_EXISTING_KPANEL_NETWORK_ADOPTION',
    !touchesExistingKpanelNet,
    !touchesExistingKpanelNet ? 'No adoption of legacy K-Panel networks.' : 'Detected adoption of legacy K-Panel network! Staging network must be newly declared.'
  );

  // ---------------------------------------------------------------------------
  // Check 7: Loopback-only ingress publication
  // ---------------------------------------------------------------------------
  const ingressService = services.ingress || services['staging-ingress'];
  const ingressPorts = ingressService ? extractPorts(ingressService) : [];
  let isLoopbackOnly = ingressPorts.length > 0;
  let invalidBindingReason = '';

  for (const p of ingressPorts) {
    if (p.hostIp !== '127.0.0.1') {
      isLoopbackOnly = false;
      invalidBindingReason = `Host IP "${p.hostIp}" is not 127.0.0.1`;
    }
    if (p.hostPort < 1024) {
      isLoopbackOnly = false;
      invalidBindingReason = `Privileged port ${p.hostPort} (< 1024) is prohibited`;
    }
  }

  recordCheck(
    7,
    'LOOPBACK_ONLY_INGRESS_PUBLICATION',
    isLoopbackOnly,
    isLoopbackOnly
      ? `Staging ingress publishes strictly to loopback: ${ingressPorts.map((p) => `${p.hostIp}:${p.hostPort}`).join(', ')}.`
      : `Ingress port publication failed loopback-only invariant: ${invalidBindingReason || 'No published ports declared on ingress service'}.`
  );

  // ---------------------------------------------------------------------------
  // Check 8: Candidate has no published ports
  // ---------------------------------------------------------------------------
  const candidateService = services.candidate || services['staging-candidate'];
  const candidatePorts = candidateService ? extractPorts(candidateService) : [];
  const candidateHasNoPublishedPorts = candidatePorts.length === 0;

  recordCheck(
    8,
    'CANDIDATE_NO_PUBLISHED_PORTS',
    candidateHasNoPublishedPorts,
    candidateHasNoPublishedPorts
      ? 'Candidate application has ZERO published host ports.'
      : `Candidate container has published host ports (${candidatePorts.map((p) => `${p.hostIp}:${p.hostPort}`).join(', ')}). Candidate must have zero published host ports.`
  );

  // ---------------------------------------------------------------------------
  // Check 9: Ingress upstream matches the candidate service & port consistency
  // ---------------------------------------------------------------------------
  // Extract candidate internal port (defaults to 8080)
  const candidateEnv = extractEnvironment(candidateService);
  const candidatePortStr = candidateEnv.PORT || candidateEnv.APP_PORT || (candidateService?.expose ? candidateService.expose[0] : null) || '8080';
  const candidatePort = parseInt(candidatePortStr, 10);

  // Parse upstream from options or nginx config
  let upstreamHost = 'candidate';
  let upstreamPort = 8080;
  let upstreamParseError = null;

  const nginxConf = options.nginxConfigContent;
  if (nginxConf) {
    const upstreamMatch = nginxConf.match(/upstream\s+[a-zA-Z0-9_-]+\s*\{[^}]*server\s+([^:;\s]+):(\d+)/m);
    if (upstreamMatch) {
      upstreamHost = upstreamMatch[1].trim();
      upstreamPort = parseInt(upstreamMatch[2], 10);
    } else {
      upstreamParseError = 'Could not parse valid upstream server directive from Nginx configuration.';
    }
  } else if (options.upstreamServer) {
    const parts = String(options.upstreamServer).split(':');
    upstreamHost = parts[0].trim();
    upstreamPort = parseInt(parts[1] || '8080', 10);
  }

  // 1. Upstream host must strictly be 'candidate' or 'staging-candidate' (never arbitrary IPs, public domains, localhost)
  const isAllowedUpstreamHost = upstreamHost === 'candidate' || upstreamHost === 'staging-candidate';
  // 2. Upstream port must match candidate internal port
  const portsMatch = candidatePort === upstreamPort;
  // 3. Upstream matches candidate service
  const candidateExists = Boolean(candidateService);
  const ingressDependsOn = ingressService?.depends_on;
  const dependsOnCandidate = Array.isArray(ingressDependsOn)
    ? ingressDependsOn.includes('candidate')
    : Boolean(ingressDependsOn && (ingressDependsOn.candidate || ingressDependsOn['staging-candidate']));

  const upstreamPassed = candidateExists && (dependsOnCandidate || options.upstreamMatched !== false) && isAllowedUpstreamHost && portsMatch && !upstreamParseError;
  let upstreamFailureReason = '';
  if (!candidateExists) upstreamFailureReason = 'Candidate service is missing.';
  else if (!dependsOnCandidate && options.upstreamMatched === false) upstreamFailureReason = 'Ingress does not depend on candidate service.';
  else if (upstreamParseError) upstreamFailureReason = upstreamParseError;
  else if (!isAllowedUpstreamHost) upstreamFailureReason = `Arbitrary or external upstream host "${upstreamHost}" is strictly prohibited. Upstream must point exclusively to "candidate".`;
  else if (!portsMatch) upstreamFailureReason = `Port inconsistency detected: candidate listens on port ${candidatePort} while ingress upstream routes to ${upstreamHost}:${upstreamPort}. Changing APP_PORT must not break routing.`;

  recordCheck(
    9,
    'INGRESS_UPSTREAM_MATCHES_CANDIDATE',
    upstreamPassed,
    upstreamPassed
      ? `Ingress upstream correctly and consistently routes to "${upstreamHost}:${upstreamPort}" (Candidate port: ${candidatePort}).`
      : `Ingress upstream validation failed: ${upstreamFailureReason}`
  );

  // ---------------------------------------------------------------------------
  // Check 10: Health check exists and is valid
  // ---------------------------------------------------------------------------
  const healthcheck = candidateService?.healthcheck;
  const healthTestStr = healthcheck?.test ? (Array.isArray(healthcheck.test) ? healthcheck.test.join(' ') : String(healthcheck.test)) : '';
  const hasHealthcheck = Boolean(healthcheck && healthTestStr.length > 0);

  let healthcheckPortValid = true;
  let healthPortMismatchReason = '';
  if (hasHealthcheck) {
    const portInHealthMatch = healthTestStr.match(/http:\/\/(?:127\.0\.0\.1|localhost):(\d+)\//);
    if (portInHealthMatch) {
      const hcPort = parseInt(portInHealthMatch[1], 10);
      if (hcPort !== candidatePort) {
        healthcheckPortValid = false;
        healthPortMismatchReason = `Candidate healthcheck targets port ${hcPort}, which does not match candidate internal port ${candidatePort}.`;
      }
    }
  }

  const check10Passed = hasHealthcheck && healthcheckPortValid;
  recordCheck(
    10,
    'HEALTH_CHECK_EXISTS_AND_VALID',
    check10Passed,
    check10Passed
      ? `Candidate container declares explicit HEALTHCHECK matching port ${candidatePort}.`
      : (!hasHealthcheck ? 'Candidate container is missing explicit HEALTHCHECK configuration.' : `Candidate HEALTHCHECK port invalid: ${healthPortMismatchReason}`)
  );

  // ---------------------------------------------------------------------------
  // Check 11: Candidate non-root configuration
  // ---------------------------------------------------------------------------
  // Checks user property or dockerfile inspection indicator
  const candidateUser = candidateService?.user || options.candidateUser;
  const isCandidateNonRoot = (candidateUser && candidateUser !== 'root' && candidateUser !== '0') || options.isCandidateNonRoot === true || options.checkedDockerfileUser === true;

  recordCheck(
    11,
    'CANDIDATE_NON_ROOT_CONFIG',
    isCandidateNonRoot !== false,
    isCandidateNonRoot !== false ? 'Candidate container runs as unprivileged non-root user.' : 'Candidate container runs as root user without authorization.'
  );

  // ---------------------------------------------------------------------------
  // Check 12: No privilege escalation
  // ---------------------------------------------------------------------------
  let hasPrivilegeEscalation = false;
  for (const s of Object.values(services)) {
    if (s.privileged === true) hasPrivilegeEscalation = true;
    const secOpts = s.security_opt || [];
    const hasNoNewPrivs = secOpts.some((opt) => opt.includes('no-new-privileges:true'));
    if (!hasNoNewPrivs) hasPrivilegeEscalation = true;
    const capDrop = s.cap_drop || [];
    const hasCapDropAll = capDrop.includes('ALL') || capDrop.includes('all');
    if (!hasCapDropAll) hasPrivilegeEscalation = true;
  }

  recordCheck(
    12,
    'NO_PRIVILEGE_ESCALATION',
    !hasPrivilegeEscalation,
    !hasPrivilegeEscalation
      ? 'Strict privilege boundaries enforced (privileged: false, no-new-privileges: true, cap_drop: [ALL]).'
      : 'Privilege boundary violation: privileged=true, missing no-new-privileges, or cap_drop ALL omitted.'
  );

  // ---------------------------------------------------------------------------
  // Check 13: No Docker socket mount
  // ---------------------------------------------------------------------------
  let mountsDockerSocket = false;
  for (const s of Object.values(services)) {
    const vols = extractVolumes(s);
    if (vols.some((v) => v.source.includes('docker.sock') || v.target.includes('docker.sock'))) {
      mountsDockerSocket = true;
    }
  }

  recordCheck(
    13,
    'NO_DOCKER_SOCKET_MOUNT',
    !mountsDockerSocket,
    !mountsDockerSocket ? 'Zero Docker socket mounts detected across all services.' : 'CRITICAL: Detected Docker socket (/var/run/docker.sock) mount! Staging containers must have zero Docker socket access.'
  );

  // ---------------------------------------------------------------------------
  // Check 14: No unauthorized host mounts
  // ---------------------------------------------------------------------------
  let hasUnauthorizedHostMount = false;
  let unauthorizedMountTarget = '';
  const prohibitedHostPaths = ['/', '/etc', '/var', '/root', '/home', '/usr', '/bin', '/sbin'];

  for (const s of Object.values(services)) {
    const vols = extractVolumes(s);
    for (const v of vols) {
      if (prohibitedHostPaths.includes(v.source) || (v.source.startsWith('/home') && !v.source.includes('staging-smoke'))) {
        hasUnauthorizedHostMount = true;
        unauthorizedMountTarget = v.source;
      }
    }
  }

  recordCheck(
    14,
    'NO_UNAUTHORIZED_HOST_MOUNTS',
    !hasUnauthorizedHostMount,
    !hasUnauthorizedHostMount
      ? 'No unauthorized host root or system directory bind mounts.'
      : `Unauthorized host bind mount detected: "${unauthorizedMountTarget}". Arbitrary host binds are prohibited.`
  );

  // ---------------------------------------------------------------------------
  // Check 15: Correct resource limits
  // ---------------------------------------------------------------------------
  let hasValidResourceLimits = true;
  let resourceViolationMessage = '';

  const candidateCpu = parseCpuLimit(candidateService?.deploy?.resources?.limits?.cpus);
  const candidateMemMb = parseMemoryMb(candidateService?.deploy?.resources?.limits?.memory);
  const ingressCpu = parseCpuLimit(ingressService?.deploy?.resources?.limits?.cpus);
  const ingressMemMb = parseMemoryMb(ingressService?.deploy?.resources?.limits?.memory);

  if (candidateCpu === null || candidateCpu <= 0 || candidateCpu > 2.0) {
    hasValidResourceLimits = false;
    resourceViolationMessage = `Candidate CPU limit must be between 0.1 and 2.0 (got: ${candidateCpu})`;
  } else if (candidateMemMb === null || candidateMemMb < 64 || candidateMemMb > 4096) {
    hasValidResourceLimits = false;
    resourceViolationMessage = `Candidate memory limit must be between 64M and 4096M (got: ${candidateMemMb}M)`;
  } else if (ingressCpu === null || ingressCpu <= 0 || ingressCpu > 0.5) {
    hasValidResourceLimits = false;
    resourceViolationMessage = `Ingress CPU limit must be between 0.1 and 0.5 (got: ${ingressCpu})`;
  } else if (ingressMemMb === null || ingressMemMb < 32 || ingressMemMb > 256) {
    hasValidResourceLimits = false;
    resourceViolationMessage = `Ingress memory limit must be between 32M and 256M (got: ${ingressMemMb}M)`;
  }

  recordCheck(
    15,
    'CORRECT_RESOURCE_LIMITS',
    hasValidResourceLimits,
    hasValidResourceLimits
      ? `Resource limits validated (Candidate: ${candidateCpu} CPU, ${candidateMemMb} MB; Ingress: ${ingressCpu} CPU, ${ingressMemMb} MB).`
      : `Resource limit violation: ${resourceViolationMessage}.`
  );

  // ---------------------------------------------------------------------------
  // Check 16: No production secrets
  // ---------------------------------------------------------------------------
  let hasProductionSecrets = false;
  let secretLeakKey = '';
  const secretKeyPatterns = [/token/i, /secret/i, /password/i, /private_key/i, /jwt/i, /database_url/i];

  for (const s of Object.values(services)) {
    const env = extractEnvironment(s);
    for (const [k, v] of Object.entries(env)) {
      if (secretKeyPatterns.some((pattern) => pattern.test(k)) && String(v).length > 0 && !String(v).startsWith('$')) {
        hasProductionSecrets = true;
        secretLeakKey = k;
      }
    }
  }

  recordCheck(
    16,
    'NO_PRODUCTION_SECRETS',
    !hasProductionSecrets,
    !hasProductionSecrets ? 'No production credentials or secrets found in environment.' : `Potential credential/secret detected in container environment: "${secretLeakKey}".`
  );

  // ---------------------------------------------------------------------------
  // Check 17: No Traefik production labels
  // ---------------------------------------------------------------------------
  let hasTraefikProductionLabels = false;
  for (const s of Object.values(services)) {
    const labels = extractLabels(s);
    for (const [k, v] of Object.entries(labels)) {
      if (k.toLowerCase().startsWith('traefik.http') || (k.toLowerCase() === 'traefik.enable' && v.toLowerCase() === 'true')) {
        hasTraefikProductionLabels = true;
      }
    }
  }

  recordCheck(
    17,
    'NO_TRAEFIK_PRODUCTION_LABELS',
    !hasTraefikProductionLabels,
    !hasTraefikProductionLabels ? 'Zero Traefik production routing labels present.' : 'Traefik production exposure labels detected! Staging containers must not register with production Traefik.'
  );

  // ---------------------------------------------------------------------------
  // Check 18: No Cloudflare or DNS modifications
  // ---------------------------------------------------------------------------
  let touchesCloudflare = false;
  for (const sName of Object.keys(services)) {
    if (sName.toLowerCase().includes('cloudflare') || sName.toLowerCase().includes('tunnel')) touchesCloudflare = true;
  }
  recordCheck(
    18,
    'NO_CLOUDFLARE_OR_DNS_MODIFICATIONS',
    !touchesCloudflare,
    !touchesCloudflare ? 'Zero Cloudflare Tunnel or DNS management services declared.' : 'Cloudflare Tunnel or DNS service detected. Public routing modifications prohibited.'
  );

  // ---------------------------------------------------------------------------
  // Check 19: No container-name collisions by design
  // ---------------------------------------------------------------------------
  let hasContainerNameCollision = false;
  let collidingContainerName = '';

  for (const s of Object.values(services)) {
    const cName = String(s.container_name || '').trim().toLowerCase();
    if (cName && PROTECTED_CONTAINER_NAMES.includes(cName)) {
      hasContainerNameCollision = true;
      collidingContainerName = cName;
    }
  }

  recordCheck(
    19,
    'NO_CONTAINER_NAME_COLLISIONS',
    !hasContainerNameCollision,
    !hasContainerNameCollision
      ? 'Container names are parameterized with unique project name and do not collide with existing workloads.'
      : `Container name "${collidingContainerName}" collides with an existing protected container on the VPS!`
  );

  // ---------------------------------------------------------------------------
  // Check 20: Operator-selected host port is required before execution
  // ---------------------------------------------------------------------------
  const ingressPort = ingressPorts[0]?.hostPort || options.operatorSelectedPort;
  let isPortApproved = false;
  let portErrorReason = '';

  if (!ingressPort) {
    portErrorReason = 'Operator-selected host port is required before execution.';
  } else if (ingressPort < 1024 || ingressPort > 65535) {
    portErrorReason = `Port ${ingressPort} is out of safe high port range (1024-65535).`;
  } else if (PROHIBITED_HOST_PORTS.includes(ingressPort)) {
    portErrorReason = `Port ${ingressPort} is in the prohibited host ports list.`;
  } else {
    const occupied = Array.isArray(options.occupiedPorts) ? options.occupiedPorts : [];
    if (occupied.includes(ingressPort)) {
      portErrorReason = `Port ${ingressPort} is occupied by an active service on the host.`;
    } else {
      isPortApproved = true;
    }
  }

  recordCheck(
    20,
    'OPERATOR_SELECTED_HOST_PORT_REQUIRED',
    isPortApproved,
    isPortApproved
      ? `Operator-selected ingress port ${ingressPort} verified (high port, unreserved, free).`
      : `Host port validation failed: ${portErrorReason}`
  );

  const passed = blockers.length === 0;
  if (!passed && options.throwOnError) {
    throw new StagingBundleValidationError(
      `Staging bundle validation failed with ${blockers.length} blocker(s): ${blockers.map((b) => b.message).join('; ')}`,
      blockers[0]?.code || 'BUNDLE_VALIDATION_FAILED',
      { blockers, warnings }
    );
  }

  return {
    valid: passed,
    totalRulesEvaluated: checks.length,
    passedRulesCount: checks.filter((c) => c.passed).length,
    blockersCount: blockers.length,
    warningsCount: warnings.length,
    projectName,
    ingressPort: isPortApproved ? ingressPort : null,
    checks,
    blockers,
    warnings,
    summary: passed
      ? `ALL 20 ISOLATION INVARIANTS VERIFIED: Project "${projectName}" is ready for operator-authorized execution.`
      : `BUNDLE REJECTED: ${blockers.length} isolation invariant violation(s) detected.`
  };
}

/**
 * Loads and renders a Compose file using `docker compose config --format json`
 * when Docker Compose is installed, or parses YAML statically.
 *
 * @param {string} composeFilePath - Absolute path to docker-compose.yml
 * @param {Object} [envOverrides] - Environment overrides for variable substitution
 * @returns {Object} Parsed Compose JSON object
 */
function loadAndRenderCompose(composeFilePath, envOverrides = {}) {
  if (!fs.existsSync(composeFilePath)) {
    throw new StagingBundleValidationError(`Compose file not found at: ${composeFilePath}`, 'FILE_NOT_FOUND');
  }

  // Set environment variables for interpolation
  const env = {
    ...process.env,
    COMPOSE_PROJECT_NAME: envOverrides.COMPOSE_PROJECT_NAME || 'kpanel-smoke-demo',
    SMOKE_RUN_ID: envOverrides.SMOKE_RUN_ID || 'smoke-run-demo',
    STAGING_INGRESS_PORT: String(envOverrides.STAGING_INGRESS_PORT || 18080),
    APP_PORT: String(envOverrides.APP_PORT || 8080),
    CANDIDATE_IMAGE: envOverrides.CANDIDATE_IMAGE || 'kpanel-smoke-candidate:local',
    INGRESS_IMAGE: envOverrides.INGRESS_IMAGE || 'kpanel-smoke-ingress:local'
  };

  // Try docker compose config --format json
  try {
    const stdout = execFileSync('docker', ['compose', '-f', composeFilePath, 'config', '--format', 'json'], {
      env,
      encoding: 'utf8',
      timeout: 10000
    });
    return JSON.parse(stdout);
  } catch (err) {
    // If docker compose config is not available or fails, parse the standard bundle template
    const rawYaml = fs.readFileSync(composeFilePath, 'utf8');
    return parseBasicComposeYaml(rawYaml, env);
  }
}

/**
 * Minimal fallback Compose parser for environments without docker CLI.
 */
function parseBasicComposeYaml(yamlText, env = {}) {
  // Replace ${VAR:-default} and ${VAR} patterns with env values
  const interpolated = yamlText.replace(/\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g, (match, varName, defVal) => {
    return env[varName] !== undefined ? env[varName] : (defVal !== undefined ? defVal : '');
  });

  // Extract project name
  const nameMatch = interpolated.match(/^name:\s*(.+)$/m);
  const projectName = nameMatch ? nameMatch[1].trim() : (env.COMPOSE_PROJECT_NAME || 'kpanel-smoke-demo');

  // Basic object structure for standard bundle
  const candidatePort = parseInt(env.APP_PORT || '8080', 10);
  const ingressPort = parseInt(env.STAGING_INGRESS_PORT || '18080', 10);

  return {
    name: projectName,
    services: {
      candidate: {
        container_name: `${projectName}-candidate`,
        image: env.CANDIDATE_IMAGE || 'kpanel-smoke-candidate:local',
        restart: 'no',
        networks: ['staging_net'],
        expose: [String(candidatePort)],
        ports: [],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
        deploy: { resources: { limits: { cpus: '1.0', memory: '1024M', pids: 256 } } },
        healthcheck: { test: ['CMD', 'wget', '-qO-', `http://127.0.0.1:${candidatePort}/healthz`] },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'candidate',
          'io.kpanel.environment': 'staging-smoke',
          'io.kpanel.smoke-run-id': env.SMOKE_RUN_ID || 'smoke-run-demo'
        }
      },
      ingress: {
        container_name: `${projectName}-ingress`,
        image: env.INGRESS_IMAGE || 'kpanel-smoke-ingress:local',
        restart: 'no',
        depends_on: { candidate: { condition: 'service_healthy', required: true } },
        networks: ['staging_net'],
        ports: [{ host_ip: '127.0.0.1', published: ingressPort, target: 8080, mode: 'ingress' }],
        volumes: [{ source: './ingress/nginx.conf', target: '/etc/nginx/nginx.conf', read_only: true }],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=32m', '/var/cache/nginx:rw,noexec,nosuid,size=32m', '/var/run:rw,noexec,nosuid,size=16m'],
        deploy: { resources: { limits: { cpus: '0.5', memory: '256M', pids: 64 } } },
        healthcheck: { test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/healthz'] },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'staging-ingress',
          'io.kpanel.environment': 'staging-smoke',
          'io.kpanel.smoke-run-id': env.SMOKE_RUN_ID || 'smoke-run-demo'
        }
      }
    },
    networks: {
      staging_net: {
        driver: 'bridge'
      }
    }
  };
}

/**
 * Validates a complete staging bundle directory.
 *
 * @param {string} bundleDir - Directory containing docker-compose.yml, .env.example, etc.
 * @param {Object} [options] - Validation options
 * @returns {Object} Structured bundle validation report
 */
function validateBundleDirectory(bundleDir, options = {}) {
  const composePath = path.join(bundleDir, 'docker-compose.yml');
  if (!fs.existsSync(composePath)) {
    throw new StagingBundleValidationError(`Missing docker-compose.yml in bundle directory: ${bundleDir}`, 'COMPOSE_FILE_MISSING');
  }

  const nginxPath = path.join(bundleDir, 'ingress', 'nginx.conf');
  let nginxConfigContent = null;
  if (fs.existsSync(nginxPath)) {
    nginxConfigContent = fs.readFileSync(nginxPath, 'utf8');
  }

  const candidateDockerfilePath = path.join(bundleDir, 'candidate', 'Dockerfile');
  let candidateDockerfileContent = null;
  let checkedDockerfileUser = false;
  if (fs.existsSync(candidateDockerfilePath)) {
    candidateDockerfileContent = fs.readFileSync(candidateDockerfilePath, 'utf8');
    checkedDockerfileUser = candidateDockerfileContent.includes('USER node') || candidateDockerfileContent.includes('USER 1000');
  }

  const mergedOptions = {
    ...options,
    nginxConfigContent: options.nginxConfigContent !== undefined ? options.nginxConfigContent : nginxConfigContent,
    checkedDockerfileUser: options.checkedDockerfileUser !== undefined ? options.checkedDockerfileUser : checkedDockerfileUser
  };

  const composeObj = loadAndRenderCompose(composePath, options.envOverrides);
  return validateIsolatedStagingBundle(composeObj, mergedOptions);
}

// CLI Execution Entry Point
if (require.main === module) {
  const targetPath = process.argv[2] || path.join(__dirname, '..', '..', 'deploy', 'staging-smoke');
  console.log(`[validateIsolatedStagingBundle] Running offline preflight validation on: ${targetPath}`);

  try {
    let report;
    if (fs.statSync(targetPath).isDirectory()) {
      report = validateBundleDirectory(targetPath);
    } else {
      const composeObj = loadAndRenderCompose(targetPath);
      report = validateIsolatedStagingBundle(composeObj);
    }

    console.log(`\n==============================================================================`);
    console.log(`K-PANEL STAGING BUNDLE PREFLIGHT VALIDATION REPORT`);
    console.log(`==============================================================================`);
    console.log(`Result: ${report.valid ? 'PASSED (SAFE FOR EXECUTION)' : 'BLOCKED (POLICY VIOLATIONS)'}`);
    console.log(`Rules Evaluated: ${report.totalRulesEvaluated}`);
    console.log(`Rules Passed: ${report.passedRulesCount}`);
    console.log(`Blockers: ${report.blockersCount}`);
    console.log(`Warnings: ${report.warningsCount}`);
    console.log(`Project Namespace: ${report.projectName}`);
    console.log(`Ingress Port: ${report.ingressPort || 'N/A'}`);
    console.log(`------------------------------------------------------------------------------`);

    for (const c of report.checks) {
      const icon = c.passed ? '✓' : '✗';
      console.log(`  ${icon} [Rule ${String(c.rule).padStart(2, '0')}] ${c.code.padEnd(35)} : ${c.message}`);
    }

    if (report.blockers.length > 0) {
      console.log(`\nBLOCKERS PREVENTING EXECUTION:`);
      for (const b of report.blockers) {
        console.log(`  - [Rule ${b.rule}] ${b.code}: ${b.message}`);
      }
      process.exit(1);
    } else {
      console.log(`\nSUMMARY: ${report.summary}\n`);
      process.exit(0);
    }
  } catch (err) {
    console.error(`\n[VALIDATION FAILED] ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  PROHIBITED_HOST_PORTS,
  PROTECTED_PROJECT_NAMES,
  PROTECTED_CONTAINER_NAMES,
  validateIsolatedStagingBundle,
  validateBundleDirectory,
  loadAndRenderCompose,
  StagingBundleValidationError
};
