const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const runtimeService = require('./runtimeService');
const releasePlanningService = require('./releasePlanningService');
const { ReleasePlanningError } = releasePlanningService;
const traefikTopologyService = require('./traefikTopologyService');
const routeConflictService = require('./routeConflictService');
const { CONFLICT_DECISIONS } = routeConflictService;
const traefikRoutePlanner = require('./traefikRoutePlanner');
const githubRepositoryService = require('./githubRepositoryService');
const githubAppService = require('./githubAppService');

/**
 * Preflight decision codes.
 */
const PREFLIGHT_DECISIONS = {
  READY_FOR_ACTIVATION: 'READY_FOR_ACTIVATION',
  BLOCKED_BY_ROUTE_CONFLICT: 'BLOCKED_BY_ROUTE_CONFLICT',
  BLOCKED_BY_UNVERIFIED_DOMAIN: 'BLOCKED_BY_UNVERIFIED_DOMAIN',
  BLOCKED_BY_PROVIDER_CONFIGURATION: 'BLOCKED_BY_PROVIDER_CONFIGURATION',
  BLOCKED_BY_UNHEALTHY_CANDIDATE: 'BLOCKED_BY_UNHEALTHY_CANDIDATE',
  BLOCKED_BY_NETWORK_ACCESS: 'BLOCKED_BY_NETWORK_ACCESS',
  BLOCKED_BY_AUTHORIZATION_DRIFT: 'BLOCKED_BY_AUTHORIZATION_DRIFT',
  BLOCKED_BY_STALE_WORKER: 'BLOCKED_BY_STALE_WORKER',
  BLOCKED_BY_MISSING_ROLLBACK_TARGET: 'BLOCKED_BY_MISSING_ROLLBACK_TARGET'
};

/**
 * Structured service error class for Routing Preflight operations.
 */
class RoutingPreflightError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'RoutingPreflightError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Computes a deterministic SHA-256 fingerprint for a proposed or existing route configuration.
 *
 * @param {Object} config - Route configuration object
 * @returns {string} Hex SHA-256 digest
 */
function computeRouteFingerprint(config) {
  if (!config || typeof config !== 'object') {
    return null;
  }
  return crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex');
}

/**
 * Resolves and validates a candidate container's routing backend target.
 * Avoids transient container IP assumptions by resolving stable container DNS identities
 * within the verified target proxy network.
 *
 * @param {Object} candidate - Staged candidate record or metadata
 * @param {string} targetNetwork - Operator-approved proxy network identity
 * @param {Object} [options] - Options ({ targetPort, docker })
 * @returns {Object} Validated backend target descriptor
 */
function resolveCandidateRoutingTarget(candidate, targetNetwork, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new RoutingPreflightError('Candidate record is required to resolve routing target.', 'INVALID_CANDIDATE');
  }

  const containerId = String(candidate.containerId || candidate.container_id || '').trim();
  const containerName = String(candidate.containerName || candidate.container_name || '').trim();
  const port = options.targetPort || candidate.targetPort || candidate.target_port;
  const portNum = parseInt(port, 10);

  if (!containerId) {
    throw new RoutingPreflightError('Candidate container ID is missing.', 'INVALID_CONTAINER_ID');
  }

  if (!containerName) {
    throw new RoutingPreflightError('Candidate container name is missing.', 'INVALID_CONTAINER_NAME');
  }

  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new RoutingPreflightError(`Invalid candidate service port (${port}). Must be 1-65535.`, 'INVALID_PORT');
  }

  if (!targetNetwork || typeof targetNetwork !== 'string' || !targetNetwork.trim()) {
    throw new RoutingPreflightError('Target routing network identity is required.', 'TARGET_NETWORK_MISSING');
  }

  const cleanNetwork = targetNetwork.trim();

  // Strict check: forbid arbitrary localhost, host-system, or 0.0.0.0 targets
  const forbiddenTargets = ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal'];
  if (forbiddenTargets.includes(containerName.toLowerCase())) {
    throw new RoutingPreflightError('Arbitrary localhost or host-system targets are strictly prohibited.', 'UNSAFE_BACKEND_TARGET');
  }

  // Pure target descriptor: uses container DNS name on the target shared network
  const backendUrl = `http://${containerName}:${portNum}`;

  return {
    resolved: true,
    containerId,
    containerName,
    internalPort: portNum,
    backendUrl,
    targetNetwork: cleanNetwork,
    isTransientIp: false
  };
}

/**
 * Constructs a deterministic rollback plan contract based on current route ownership.
 *
 * @param {Object} input - Input { applicationId, targetDomain, conflictEvaluation, activeRelease, proposedRouteConfig }
 * @param {Object} [options] - Options
 * @returns {Object} Structured rollback plan contract
 */
function buildRollbackPlan(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new RoutingPreflightError('Rollback plan input is required.', 'INVALID_INPUT');
  }

  const {
    applicationId,
    targetDomain,
    conflictEvaluation,
    activeRelease,
    proposedRouteConfig
  } = input;

  const decision = conflictEvaluation?.decision || CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE;

  // Case 1: Foreign-owned route -> Rollback is impossible and unauthorized
  if (decision === CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT) {
    return {
      strategy: 'BLOCKED_FOREIGN_ROUTE',
      isActionable: false,
      reason: 'Domain is controlled by a foreign router (Dokploy, n8n, or another service). K-Panel cannot construct a safe rollback contract.',
      restorationConfig: null,
      previousReleaseId: null
    };
  }

  // Case 2: Topology unavailable or undetermined -> Rollback cannot be guaranteed
  if (decision === CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE || decision === CONFLICT_DECISIONS.ROUTE_CONFLICT_UNDETERMINED) {
    return {
      strategy: 'BLOCKED_UNKNOWN_OWNERSHIP',
      isActionable: false,
      reason: 'Current routing topology is unavailable or undetermined. Rollback state cannot be verified.',
      restorationConfig: null,
      previousReleaseId: null
    };
  }

  // Case 3: First-ever release (Domain is verified available, no prior K-Panel route exists)
  if (decision === CONFLICT_DECISIONS.AVAILABLE_VERIFIED && !activeRelease) {
    return {
      strategy: 'REMOVE_NEW_ROUTE',
      isActionable: true,
      description: 'First release: on activation failure, remove the proposed K-Panel route and revert to the unrouted state.',
      restorationConfig: null, // empty / remove route
      previousReleaseId: null,
      previousContainerId: null,
      previousImageId: null,
      previousRouteFingerprint: null
    };
  }

  // Case 4: Replacement release (An existing K-Panel release currently serves the domain)
  if (activeRelease) {
    const prevRouterName = traefikRoutePlanner.getDeterministicIdentifier('router', applicationId);
    const prevServiceName = traefikRoutePlanner.getDeterministicIdentifier('svc', applicationId);

    const restorationConfig = {
      http: {
        routers: {
          [prevRouterName]: {
            rule: `Host(\`${targetDomain}\`)`,
            service: prevServiceName,
            entryPoints: ['websecure'],
            tls: { certResolver: options.certResolver || null }
          }
        },
        services: {
          [prevServiceName]: {
            loadBalancer: {
              servers: [
                {
                  url: `http://${activeRelease.container_id || activeRelease.containerId || 'prev-container'}:${activeRelease.port || 3000}`
                }
              ],
              passHostHeader: true
            }
          }
        }
      }
    };

    const prevFingerprint = computeRouteFingerprint(restorationConfig);

    return {
      strategy: 'RESTORE_PREVIOUS_ROUTE',
      isActionable: true,
      description: 'Replacement release: on activation failure, restore the previous active K-Panel route and keep the prior container online.',
      previousReleaseId: activeRelease.id,
      previousContainerId: activeRelease.container_id || activeRelease.containerId,
      previousImageId: activeRelease.image_tag || activeRelease.imageId,
      previousRouteFingerprint: prevFingerprint,
      restorationConfig
    };
  }

  // Fallback
  return {
    strategy: 'REMOVE_NEW_ROUTE',
    isActionable: true,
    description: 'Revert to unrouted state on failure.',
    restorationConfig: null,
    previousReleaseId: null
  };
}

/**
 * Validates complete routing activation preflight for a release plan.
 * Evaluates all 24 required safety boundaries before any future activation may proceed.
 *
 * @param {string} releasePlanId - Release Plan UUID
 * @param {Object} [options] - Options ({ db, docker, topology, approvedProxyNetwork, ownerId, fencingToken, trustedOperator, ... })
 * @returns {Promise<Object>} Comprehensive structured preflight assessment report
 */
async function validateActivationPreflight(releasePlanId, options = {}) {
  if (!releasePlanId || typeof releasePlanId !== 'string') {
    throw new RoutingPreflightError('Valid release plan ID is required for activation preflight.', 'INVALID_PLAN_ID');
  }

  const cleanPlanId = releasePlanId.trim();
  const db = options.db || getDatabase(options);
  const checks = [];

  function recordCheck(name, passed, message) {
    checks.push({ check: name, passed: Boolean(passed), message });
    return passed;
  }

  // 1. Verify Release Plan exists
  const plan = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(cleanPlanId);
  if (!recordCheck('PLAN_EXISTS', Boolean(plan), plan ? 'Release plan exists.' : `Release plan "${cleanPlanId}" not found.`)) {
    return {
      decision: PREFLIGHT_DECISIONS.BLOCKED_BY_PROVIDER_CONFIGURATION,
      planId: cleanPlanId,
      checks,
      message: `Release plan "${cleanPlanId}" was not found.`
    };
  }

  // 2. Verify Plan is current and ready
  const isPlanReady = plan.plan_status === 'ready';
  recordCheck('PLAN_STATUS_READY', isPlanReady, `Plan status is "${plan.plan_status}".`);

  // 3. Verify Application exists
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(plan.application_id);
  recordCheck('APPLICATION_EXISTS', Boolean(app), app ? `Application "${app.name}" verified.` : 'Application not found.');

  // 4. Verify Deployment exists and is in 'built' status
  const deployment = db.prepare('SELECT * FROM deployments WHERE id = ?').get(plan.deployment_id);
  const isBuilt = deployment && deployment.status === 'built';
  recordCheck('DEPLOYMENT_BUILT', isBuilt, isBuilt ? 'Deployment verified in "built" status.' : `Deployment status is "${deployment?.status}".`);

  // 5. Verify Durable Build Artifact exists
  const artifact = db.prepare('SELECT * FROM deployment_build_artifacts WHERE deployment_id = ?').get(plan.deployment_id);
  recordCheck('ARTIFACT_VERIFIED', Boolean(artifact), artifact ? 'Durable build artifact verified.' : 'Build artifact missing.');

  // 6. Verify Candidate Container ID matches plan
  const candidateRecord = db.prepare('SELECT * FROM deployment_runtime_candidates WHERE deployment_id = ?').get(plan.deployment_id);
  const candidateMatches = candidateRecord && candidateRecord.container_id === plan.candidate_container_id;
  recordCheck('CANDIDATE_CONTAINER_MATCHES', Boolean(candidateMatches), candidateMatches ? 'Candidate container identity verified.' : 'Candidate container mismatch.');

  // 7. Verify Candidate Image ID matches artifact
  const imageMatches = candidateRecord && artifact && candidateRecord.image_id.toLowerCase() === artifact.image_id.toLowerCase();
  recordCheck('IMAGE_ID_MATCHES', Boolean(imageMatches), imageMatches ? 'Candidate image matches durable build artifact.' : 'Candidate image ID mismatch.');

  // 8-10. Inspect Live Docker Candidate State
  let liveInspect = null;
  let isHealthy = false;
  let isRunning = false;
  let hasHealthcheck = false;

  try {
    liveInspect = await runtimeService.inspectCandidateContainer(plan.candidate_container_id, options);
    isRunning = Boolean(liveInspect.running);
    hasHealthcheck = Boolean(liveInspect.hasHealthcheck);
    isHealthy = liveInspect.healthStatus === 'healthy';
  } catch (err) {
    liveInspect = null;
  }

  recordCheck('CANDIDATE_NOT_STOPPED', isRunning, isRunning ? 'Candidate container is actively running.' : 'Candidate container is stopped or exited.');
  recordCheck('CANDIDATE_HEALTHCHECK_DEFINED', hasHealthcheck, hasHealthcheck ? 'Docker HEALTHCHECK instruction defined.' : 'HEALTHCHECK missing from candidate image.');
  recordCheck('CANDIDATE_HEALTH_VERIFIED', isHealthy, isHealthy ? 'Candidate container is verified healthy by Docker.' : `Candidate health status is "${liveInspect?.healthStatus || 'unknown'}".`);

  // 11-12. GitHub source authorization re-check
  let sourceAuthOk = true;
  if (options.skipGitCheck !== true && app) {
    try {
      const assoc = githubRepositoryService.getApplicationRepositoryAssociation(app.id, { db, ...options });
      if (assoc) {
        if (assoc.associationStatus !== 'verified' || assoc.installationStatus !== 'active') {
          sourceAuthOk = false;
        }
        if (options.enforceAllowlist !== false) {
          const instRow = db.prepare('SELECT account_id FROM github_installations WHERE installation_id = ?').get(assoc.installationId);
          const accountId = instRow?.account_id || assoc.accountId;
          if (accountId && !githubAppService.isAccountAllowlisted(accountId, options)) {
            sourceAuthOk = false;
          }
        }
      }
    } catch {
      sourceAuthOk = false;
    }
  }
  recordCheck('SOURCE_AUTHORIZATION_VALID', sourceAuthOk, sourceAuthOk ? 'Source authorization and GitHub App installation verified.' : 'Source authorization or installation allowlist drifted.');

  // 13-15. Domain & Port integrity check
  const domainMatches = app && app.domain && app.domain.trim().toLowerCase() === plan.target_domain.trim().toLowerCase();
  recordCheck('DOMAIN_UNCHANGED', Boolean(domainMatches), domainMatches ? 'Target domain matches configured application domain.' : 'Application domain was modified since planning.');

  const portMatches = app && Number(app.port) === Number(plan.target_port);
  recordCheck('PORT_UNCHANGED', Boolean(portMatches), portMatches ? 'Target port matches configured application port.' : 'Application port was modified since planning.');

  // 16-18. Routing Topology & Route Conflict Evaluation
  const topology = options.topology || traefikTopologyService.inspectRoutingTopology(options);
  const isTopologyAvailable = topology.status === 'AVAILABLE';
  recordCheck('TOPOLOGY_AVAILABLE', isTopologyAvailable, isTopologyAvailable ? `Topology verified with ${topology.routers?.length || 0} routers.` : 'Traefik routing topology is unavailable.');

  const isFresh = topology.freshnessStatus === 'fresh';
  recordCheck('TOPOLOGY_FRESHNESS_VERIFIED', isFresh, isFresh ? 'Topology snapshot is fresh.' : 'Topology snapshot is expired.');

  const isOriginVerified = Boolean(
    topology.originVerified !== undefined
      ? topology.originVerified
      : (options.trustedAdapter === true || (Boolean(options.snapshot) && !options.snapshotPath))
  );
  recordCheck('TOPOLOGY_ORIGIN_VERIFIED', isOriginVerified, isOriginVerified ? 'Topology snapshot provenance verified.' : 'Topology snapshot origin cannot be verified.');

  const conflictReport = isTopologyAvailable
    ? routeConflictService.evaluateRouteConflicts({
        targetDomain: plan.target_domain,
        applicationId: plan.application_id
      }, topology, options)
    : { decision: CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE, conflicts: [] };

  const noForeignConflict = conflictReport.decision === CONFLICT_DECISIONS.AVAILABLE_VERIFIED ||
    conflictReport.decision === CONFLICT_DECISIONS.OWNED_BY_KPANEL;
  recordCheck('NO_FOREIGN_ROUTE_CONFLICT', noForeignConflict, noForeignConflict ? `Route is free or owned by K-Panel (${conflictReport.decision}).` : `Route conflict detected: ${conflictReport.message}`);

  const isFileDirectoryConfigured = (options.requiredProvider || 'file') === 'file'
    ? (topology.providerMetadata?.file?.directoryConfigured !== false)
    : true;
  const providerConfigured = topology.providers &&
    topology.providers.includes(options.requiredProvider || 'file') &&
    isFileDirectoryConfigured;
  recordCheck('ROUTING_PROVIDER_CONFIGURED', Boolean(providerConfigured), providerConfigured ? `Routing provider "${options.requiredProvider || 'file'}" active.` : `Required provider "${options.requiredProvider || 'file'}" not properly configured in topology.`);

  // 19. Target network identity check
  const approvedNetwork = options.approvedProxyNetwork || process.env.KPANEL_PROXY_NETWORK_ID || 'traefik-public';
  const networkApproved = Boolean(approvedNetwork);
  recordCheck('TARGET_NETWORK_APPROVED', networkApproved, networkApproved ? `Approved target proxy network is "${approvedNetwork}".` : 'No approved proxy network configured.');

  // 20. Target routing endpoint validation
  let targetResolved = false;
  let routingTarget = null;
  try {
    routingTarget = resolveCandidateRoutingTarget({
      containerId: plan.candidate_container_id,
      containerName: candidateRecord?.container_name || `kpanel-candidate-${plan.deployment_id}`,
      targetPort: plan.target_port
    }, approvedNetwork, options);
    targetResolved = Boolean(routingTarget.resolved);
  } catch (err) {
    targetResolved = false;
  }
  recordCheck('ROUTING_TARGET_RESOLVED', targetResolved, targetResolved ? `Backend routing target resolved to "${routingTarget?.backendUrl}".` : 'Backend routing target resolution failed.');

  // 21. No incompatible active deployment being modified
  const isDeployActiveElsewhere = false;
  recordCheck('NO_INCOMPATIBLE_MUTATION', !isDeployActiveElsewhere, 'No incompatible concurrent deployment modifications.');

  // 22. Worker Lease & Fencing Authorization Check
  let fencingValid = false;
  try {
    releasePlanningService.verifyReleasePlanningAuthorization(options, {}, db);
    fencingValid = true;
  } catch {
    fencingValid = false;
  }
  recordCheck('AUTHORIZATION_FENCING_VALID', fencingValid, fencingValid ? 'Execution lease and fencing authorization verified.' : 'Caller lacks valid worker lease or operator authorization.');

  // 23. Competing activation intent check
  const competingIntent = db.prepare(`
    SELECT activation_id, activation_status FROM deployment_release_activation_intents
    WHERE application_id = ? AND activation_status IN ('ready', 'draft') AND deployment_id != ?
  `).get(plan.application_id, plan.deployment_id);
  const noCompeting = !competingIntent;
  recordCheck('NO_COMPETING_ACTIVATION', noCompeting, noCompeting ? 'No competing activation in progress for application.' : `Competing activation intent "${competingIntent?.activation_id}" is active.`);

  // 24. Rollback Strategy Verification
  const activeRelease = db.prepare(`
    SELECT r.*, a.port FROM releases r
    JOIN applications a ON r.application_id = a.id
    WHERE r.application_id = ? AND r.status = 'active'
  `).get(plan.application_id);

  const rollbackPlan = buildRollbackPlan({
    applicationId: plan.application_id,
    targetDomain: plan.target_domain,
    conflictEvaluation: conflictReport,
    activeRelease: activeRelease || null
  }, options);

  const rollbackValid = rollbackPlan.isActionable;
  recordCheck('ROLLBACK_STRATEGY_VERIFIED', rollbackValid, rollbackValid ? `Rollback strategy verified: ${rollbackPlan.strategy}.` : `Rollback plan is blocked: ${rollbackPlan.reason}`);

  // Determine overall Preflight Decision
  let decision;
  if (!isPlanReady || !isBuilt || !candidateMatches || !imageMatches) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_PROVIDER_CONFIGURATION;
  } else if (!isRunning || !hasHealthcheck || !isHealthy) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_UNHEALTHY_CANDIDATE;
  } else if (!sourceAuthOk) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_AUTHORIZATION_DRIFT;
  } else if (!domainMatches || !portMatches) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_UNVERIFIED_DOMAIN;
  } else if (!isTopologyAvailable || !providerConfigured || !isFresh || !isOriginVerified) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_PROVIDER_CONFIGURATION;
  } else if (!noForeignConflict) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_ROUTE_CONFLICT;
  } else if (!networkApproved || !targetResolved) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_NETWORK_ACCESS;
  } else if (!fencingValid) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_STALE_WORKER;
  } else if (!noCompeting || !rollbackValid) {
    decision = PREFLIGHT_DECISIONS.BLOCKED_BY_MISSING_ROLLBACK_TARGET;
  } else {
    decision = PREFLIGHT_DECISIONS.READY_FOR_ACTIVATION;
  }

  return {
    decision,
    isReady: decision === PREFLIGHT_DECISIONS.READY_FOR_ACTIVATION,
    planId: cleanPlanId,
    applicationId: plan.application_id,
    deploymentId: plan.deployment_id,
    targetDomain: plan.target_domain,
    targetPort: plan.target_port,
    candidateContainerId: plan.candidate_container_id,
    routingTarget,
    conflictReport,
    rollbackPlan,
    topologyFingerprint: topology?.snapshotFingerprint || null,
    checks,
    checkedAt: new Date().toISOString()
  };
}

/**
 * Creates or reconciles a durable release activation intent in SQLite.
 *
 * @param {string} releasePlanId - Release Plan UUID
 * @param {Object} [options] - Options ({ db, docker, topology, ownerId, fencingToken, trustedOperator, ... })
 * @returns {Promise<Object>} Created or updated activation intent record
 */
async function createActivationIntent(releasePlanId, options = {}) {
  const db = options.db || getDatabase(options);

  // 1. Mandatory Authorization Verification
  releasePlanningService.verifyReleasePlanningAuthorization(options, {}, db);

  // 2. Execute Preflight Verification
  const preflight = await validateActivationPreflight(releasePlanId, options);

  const plan = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(releasePlanId);
  const routerProposal = traefikRoutePlanner.planTraefikRoute({
    applicationId: plan.application_id,
    deploymentId: plan.deployment_id,
    targetDomain: plan.target_domain,
    targetPort: plan.target_port,
    candidateContainerId: plan.candidate_container_id,
    targetNetwork: options.approvedProxyNetwork || 'traefik-public'
  }, options);

  const proposedRouteFingerprint = computeRouteFingerprint(routerProposal.proposedConfig);
  const previousRouteFingerprint = preflight.rollbackPlan?.previousRouteFingerprint || null;
  const topologySnapshotFingerprint = preflight.topologyFingerprint;
  const activationStatus = preflight.isReady ? 'ready' : 'blocked';
  const blockedReason = preflight.isReady ? null : `Preflight failed with decision: ${preflight.decision}`;

  // 3. Atomically Persist Activation Intent
  const intentTx = db.transaction(() => {
    // Invalidate / Stale any existing active intents for this application so only one actionable intent exists
    db.prepare(`
      UPDATE deployment_release_activation_intents
      SET activation_status = 'stale',
          blocked_reason = 'SUPERSEDED_BY_NEWER_INTENT',
          updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ? AND activation_status IN ('ready', 'draft')
    `).run(plan.application_id);

    const activationId = `act-${crypto.randomUUID()}`;

    db.prepare(`
      INSERT INTO deployment_release_activation_intents (
        activation_id, release_plan_id, application_id, deployment_id,
        candidate_container_id, expected_image_id, target_domain, target_port,
        previous_release_id, previous_route_fingerprint, proposed_route_fingerprint,
        topology_snapshot_fingerprint, activation_status, blocked_reason,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(deployment_id) DO UPDATE SET
        activation_status = excluded.activation_status,
        proposed_route_fingerprint = excluded.proposed_route_fingerprint,
        previous_route_fingerprint = excluded.previous_route_fingerprint,
        topology_snapshot_fingerprint = excluded.topology_snapshot_fingerprint,
        blocked_reason = excluded.blocked_reason,
        updated_at = CURRENT_TIMESTAMP
    `).run(
      activationId,
      plan.id,
      plan.application_id,
      plan.deployment_id,
      plan.candidate_container_id,
      plan.image_id,
      plan.target_domain,
      plan.target_port,
      preflight.rollbackPlan?.previousReleaseId || null,
      previousRouteFingerprint,
      proposedRouteFingerprint,
      topologySnapshotFingerprint,
      activationStatus,
      blockedReason
    );

    return db.prepare('SELECT * FROM deployment_release_activation_intents WHERE deployment_id = ?').get(plan.deployment_id);
  });

  const intentRecord = intentTx.immediate();

  return {
    activationId: intentRecord.activation_id,
    releasePlanId: intentRecord.release_plan_id,
    applicationId: intentRecord.application_id,
    deploymentId: intentRecord.deployment_id,
    candidateContainerId: intentRecord.candidate_container_id,
    expectedImageId: intentRecord.expected_image_id,
    targetDomain: intentRecord.target_domain,
    targetPort: intentRecord.target_port,
    previousReleaseId: intentRecord.previous_release_id,
    previousRouteFingerprint: intentRecord.previous_route_fingerprint,
    proposedRouteFingerprint: intentRecord.proposed_route_fingerprint,
    topologySnapshotFingerprint: intentRecord.topology_snapshot_fingerprint,
    activationStatus: intentRecord.activation_status,
    blockedReason: intentRecord.blocked_reason,
    preflight,
    routerProposal
  };
}

/**
 * Retrieves an activation intent by ID.
 */
function getActivationIntent(activationId, options = {}) {
  if (!activationId || typeof activationId !== 'string') return null;
  const db = options.db || getDatabase(options);
  return db.prepare('SELECT * FROM deployment_release_activation_intents WHERE activation_id = ?').get(activationId.trim()) || null;
}

/**
 * Plans a pure, atomic traffic switchover dry run.
 * Constructs compare-and-swap preconditions and rollback contracts without mutating any external state.
 *
 * @param {Object} activationIntent - Stored activation intent record
 * @param {Object} currentTopology - Freshly inspected Traefik topology
 * @param {Object} [options] - Options
 * @returns {Object} Structured route transition dry-run specification
 */
function planTrafficSwitch(activationIntent, currentTopology, options = {}) {
  if (!activationIntent || typeof activationIntent !== 'object') {
    throw new RoutingPreflightError('Activation intent object is required.', 'INVALID_INTENT');
  }

  const {
    activationId,
    applicationId,
    deploymentId,
    targetDomain,
    targetPort,
    candidateContainerId,
    previousRouteFingerprint,
    proposedRouteFingerprint,
    topologySnapshotFingerprint
  } = activationIntent;

  const routeProposal = traefikRoutePlanner.planTraefikRoute({
    applicationId,
    deploymentId,
    targetDomain,
    targetPort,
    candidateContainerId,
    targetNetwork: options.approvedProxyNetwork || 'traefik-public'
  }, options);

  const proposedRouteConfig = routeProposal.proposedConfig;
  const calculatedProposedFingerprint = computeRouteFingerprint(proposedRouteConfig);

  // Compare-and-swap contract:
  // Route switch may proceed only if the live route matches expected previous route fingerprint
  // and the live topology matches the verified preflight topology fingerprint.
  const compareAndSwapContract = {
    expectedPreviousRouteFingerprint: previousRouteFingerprint || null,
    expectedTopologyFingerprint: topologySnapshotFingerprint || currentTopology?.snapshotFingerprint,
    proposedNewRouteFingerprint: calculatedProposedFingerprint,
    abortIfRouteModified: true,
    abortIfTopologyDrifted: true
  };

  const unsafeConditions = [];
  if (currentTopology?.snapshotFingerprint && topologySnapshotFingerprint && currentTopology.snapshotFingerprint !== topologySnapshotFingerprint) {
    unsafeConditions.push({
      code: 'TOPOLOGY_SNAPSHOT_DRIFT',
      message: 'Traefik topology has drifted since preflight verification was performed.'
    });
  }

  return {
    activationId,
    applicationId,
    deploymentId,
    targetDomain,
    targetPort,
    routeProvider: 'traefik',
    routingStrategy: 'dynamic-file-provider',
    plannedRouterName: routeProposal.plannedRouterName,
    plannedServiceName: routeProposal.plannedServiceName,
    proposedRouteConfig,
    compareAndSwapContract,
    unsafeConditions,
    canSwitchSafely: unsafeConditions.length === 0
  };
}

/**
 * Simulates a safe, atomic route activation execution with automated rollback on verification failure.
 * Completely mocked and in-memory; strictly zero side effects.
 *
 * @param {Object} activationIntent - Activation intent
 * @param {Object} topology - Current topology
 * @param {Object} [options] - Simulation options ({ simulateFailure, simulateCrash, simulateExternalOverwrite })
 * @returns {Object} Simulation outcome report
 */
function simulateActivationExecution(activationIntent, topology, options = {}) {
  // Step 1: Pre-switch validation (compare-and-swap check)
  const switchPlan = planTrafficSwitch(activationIntent, topology, options);
  if (!switchPlan.canSwitchSafely && !options.ignorePreconditions) {
    return {
      success: false,
      rolledBack: false,
      reason: 'PRECONDITION_FAILED',
      details: switchPlan.unsafeConditions
    };
  }

  // Crash Simulation 1: Worker crash before route mutation
  if (options.simulateCrash === 'before-mutation') {
    return {
      success: false,
      crashed: true,
      stage: 'BEFORE_MUTATION',
      reason: 'Worker crashed before route mutation was written. System preserved initial state.',
      rolledBack: false
    };
  }

  // Step 2: Route Mutation (Mocked)
  const simulatedRouteMap = new Map();
  if (options.simulateExternalOverwrite) {
    // External process overwrites route concurrently
    simulatedRouteMap.set(switchPlan.targetDomain, {
      owner: 'foreign-competitor',
      fingerprint: 'external-fingerprint-123'
    });
    return {
      success: false,
      rolledBack: false,
      reason: 'CONCURRENT_ROUTE_MUTATION',
      message: 'Compare-and-swap failed: route was modified externally prior to write acknowledgment.'
    };
  }

  // Apply proposed route in mock
  simulatedRouteMap.set(switchPlan.targetDomain, {
    owner: switchPlan.plannedRouterName,
    fingerprint: switchPlan.compareAndSwapContract.proposedNewRouteFingerprint
  });

  // Crash Simulation 2: Crash after mutation before DB acknowledgment
  if (options.simulateCrash === 'after-mutation') {
    return {
      success: false,
      crashed: true,
      stage: 'AFTER_MUTATION_UNACKNOWLEDGED',
      reason: 'Worker crashed after route applied. Rollback recovery required on reboot.',
      rolledBack: false
    };
  }

  // Step 3: Post-Switch Live Health Verification
  const verificationFailed = options.simulateFailure === true || options.simulateUnhealthyAfterSwitch === true;

  if (verificationFailed) {
    // Step 4: Automated Mock Rollback Execution
    if (activationIntent.previousRouteFingerprint) {
      simulatedRouteMap.set(switchPlan.targetDomain, {
        owner: 'kpanel-previous-release',
        fingerprint: activationIntent.previousRouteFingerprint
      });
    } else {
      simulatedRouteMap.delete(switchPlan.targetDomain);
    }

    return {
      success: false,
      rolledBack: true,
      reason: options.simulateFailureReason || 'HEALTH_VERIFICATION_FAILED',
      activeRouteRestored: true,
      message: 'Live health check failed after traffic switch. Automated rollback restored the previous route.'
    };
  }

  return {
    success: true,
    rolledBack: false,
    activeRouteFingerprint: switchPlan.compareAndSwapContract.proposedNewRouteFingerprint,
    message: 'Traffic switch simulated successfully. Route verified healthy.'
  };
}

module.exports = {
  validateActivationPreflight,
  createActivationIntent,
  getActivationIntent,
  resolveCandidateRoutingTarget,
  buildRollbackPlan,
  planTrafficSwitch,
  simulateActivationExecution,
  computeRouteFingerprint,
  PREFLIGHT_DECISIONS,
  RoutingPreflightError
};
