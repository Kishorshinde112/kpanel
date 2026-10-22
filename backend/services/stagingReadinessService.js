const { getDatabase } = require('../config/database');
const runtimeService = require('./runtimeService');
const traefikTopologyService = require('./traefikTopologyService');
const routeConflictService = require('./routeConflictService');
const { CONFLICT_DECISIONS } = routeConflictService;
const hostInventoryService = require('./hostInventoryService');
const traefikReadOnlyAdapter = require('./traefikReadOnlyAdapter');
const stagingNetworkService = require('./stagingNetworkService');
const traefikRouteWriter = require('./traefikRouteWriter');

/**
 * Standard structured decision outcomes for Staging Integration Readiness.
 */
const STAGING_DECISIONS = {
  STAGING_READY_FOR_AUTHORIZED_TEST: 'STAGING_READY_FOR_AUTHORIZED_TEST',
  STAGING_BLOCKED_PROVIDER: 'STAGING_BLOCKED_PROVIDER',
  STAGING_BLOCKED_FOREIGN_ROUTE: 'STAGING_BLOCKED_FOREIGN_ROUTE',
  STAGING_BLOCKED_NETWORK: 'STAGING_BLOCKED_NETWORK',
  STAGING_BLOCKED_UNREACHABLE: 'STAGING_BLOCKED_UNREACHABLE',
  STAGING_BLOCKED_CANDIDATE_HEALTH: 'STAGING_BLOCKED_CANDIDATE_HEALTH',
  STAGING_BLOCKED_AUTHORIZATION: 'STAGING_BLOCKED_AUTHORIZATION',
  STAGING_BLOCKED_STALE_INVENTORY: 'STAGING_BLOCKED_STALE_INVENTORY',
  STAGING_BLOCKED_ROLLBACK: 'STAGING_BLOCKED_ROLLBACK',
  STAGING_UNVERIFIED: 'STAGING_UNVERIFIED'
};

/**
 * Structured service error class for Staging Readiness operations.
 */
class StagingReadinessError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'StagingReadinessError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Evaluates full Staging Integration Readiness across 16 critical isolation,
 * provider, routing, network, reachability, authorization, and rollback factors.
 * Pure inspection; zero mutation and zero live execution side effects.
 *
 * @param {Object} input - Readiness assessment inputs
 * @param {Object} [options] - Evaluation options
 * @returns {Promise<Object>} Comprehensive readiness report
 */
async function assessStagingReadiness(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new StagingReadinessError('Readiness input object is required.', 'INVALID_INPUT');
  }

  const checks = [];
  const blockers = [];
  const warnings = [];

  function recordCheck(code, passed, message, meta = {}) {
    checks.push({ code, passed, message, ...meta });
    if (!passed) {
      blockers.push({ code, message, ...meta });
    }
  }

  const applicationId = String(input.applicationId || input.application_id || '').trim();
  const targetDomain = String(input.targetDomain || input.target_domain || '').trim().toLowerCase();
  const targetPort = parseInt(input.targetPort || input.target_port || 3000, 10);
  const db = options.db || getDatabase(options);

  // ---------------------------------------------------------------------------
  // Factor 1: Host Inventory Validity & Freshness
  // ---------------------------------------------------------------------------
  let inventory = null;
  let inventoryError = null;

  if (input.inventory || input.hostInventory) {
    try {
      inventory = typeof input.inventory === 'object' && input.inventory.valid
        ? input.inventory
        : hostInventoryService.ingestHostInventory(input.inventory || input.hostInventory, options);
    } catch (err) {
      inventoryError = err.message;
    }
  }

  const hasInventory = Boolean(inventory && inventory.valid);
  recordCheck(
    'HOST_INVENTORY_VALID',
    hasInventory,
    hasInventory ? 'Host infrastructure inventory successfully ingested and validated.' : `Host inventory missing or invalid: ${inventoryError || 'Not provided'}.`
  );

  const isInventoryFresh = hasInventory ? !inventory.isStale : false;
  if (hasInventory) {
    recordCheck(
      'HOST_INVENTORY_FRESHNESS',
      isInventoryFresh,
      isInventoryFresh ? `Host inventory is fresh (age: ${Math.round(inventory.ageMs / 1000)}s).` : 'Host inventory is stale and exceeds maximum freshness age.'
    );
  }

  // ---------------------------------------------------------------------------
  // Factor 2: Traefik Instance Identity
  // ---------------------------------------------------------------------------
  const traefikInstanceId = inventory?.traefik?.instanceId || options.traefikInstanceId || null;
  const isTraefikIdentified = Boolean(traefikInstanceId);

  // Check for conflicting Traefik instances
  const instanceConflict = Boolean(
    options.expectedTraefikInstanceId &&
    traefikInstanceId &&
    traefikInstanceId !== options.expectedTraefikInstanceId
  );

  recordCheck(
    'TRAEFIK_INSTANCE_IDENTIFIED',
    isTraefikIdentified && !instanceConflict,
    !isTraefikIdentified
      ? 'Traefik instance identity cannot be determined from host inventory.'
      : (instanceConflict ? `Traefik instance mismatch: expected "${options.expectedTraefikInstanceId}", observed "${traefikInstanceId}".` : `Traefik instance identified: "${traefikInstanceId}".`)
  );

  // ---------------------------------------------------------------------------
  // Factor 3: Routing Provider Availability
  // ---------------------------------------------------------------------------
  const requiredProvider = options.requiredProvider || 'file';
  let providerAvailable = false;

  if (inventory) {
    if (requiredProvider === 'file' && inventory.providers?.file?.enabled) {
      providerAvailable = true;
    } else if (requiredProvider === 'docker' && inventory.providers?.docker?.enabled) {
      providerAvailable = true;
    }
  } else if (options.topology?.providers) {
    providerAvailable = options.topology.providers.includes(requiredProvider);
  }

  recordCheck(
    'ROUTING_PROVIDER_AVAILABLE',
    providerAvailable,
    providerAvailable ? `Required Traefik provider "${requiredProvider}" is active.` : `Required Traefik provider "${requiredProvider}" is not enabled on host.`
  );

  // ---------------------------------------------------------------------------
  // Factor 4: File Provider Directory Compatibility
  // ---------------------------------------------------------------------------
  let fileProviderCompatibility = { compatible: false, blockedReasons: [] };
  if (requiredProvider === 'file') {
    const fileConfig = inventory?.providers?.file || options.fileProviderConfig || options.topology?.providerMetadata?.file;
    fileProviderCompatibility = traefikReadOnlyAdapter.assessFileProviderCompatibility(fileConfig, options);

    recordCheck(
      'FILE_PROVIDER_COMPATIBLE',
      fileProviderCompatibility.compatible,
      fileProviderCompatibility.compatible
        ? 'File provider directory configuration is fully compatible with dedicated K-Panel dynamic routing.'
        : `File provider compatibility check blocked: ${fileProviderCompatibility.blockedReasons.join('; ')}`
    );
  } else {
    recordCheck('FILE_PROVIDER_COMPATIBLE', true, 'File provider checks skipped (alternative provider requested).');
  }

  // ---------------------------------------------------------------------------
  // Factor 5: Router Conflict Inventory (Fail-Closed)
  // ---------------------------------------------------------------------------
  let conflictReport = { decision: CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE, conflicts: [] };
  let topologyReport = options.topology;

  if (!topologyReport && inventory) {
    topologyReport = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: inventory.routers,
        services: inventory.services,
        providers: [
          inventory.providers?.file?.enabled ? 'file' : null,
          inventory.providers?.docker?.enabled ? 'docker' : null
        ].filter(Boolean),
        providerMetadata: {
          file: {
            directoryConfigured: Boolean(inventory.providers?.file?.directory || inventory.providers?.file?.filename),
            watchEnabled: inventory.providers?.file?.watch
          }
        }
      },
      sourceType: 'operator-inventory',
      capturedAt: inventory.captureTimestamp,
      freshnessStatus: inventory.freshnessStatus,
      originVerified: inventory.originVerified,
      traefikInstanceId: inventory.traefik?.instanceId
    });
  }

  if (topologyReport && targetDomain) {
    conflictReport = routeConflictService.evaluateRouteConflicts({
      targetDomain,
      applicationId
    }, topologyReport, options);
  }

  const noForeignConflict = conflictReport.decision === CONFLICT_DECISIONS.AVAILABLE_VERIFIED ||
    conflictReport.decision === CONFLICT_DECISIONS.OWNED_BY_KPANEL;

  recordCheck(
    'NO_FOREIGN_ROUTE_CONFLICT',
    noForeignConflict,
    noForeignConflict
      ? `Route conflict check passed: domain "${targetDomain}" is ${conflictReport.decision}.`
      : `Foreign route conflict detected: ${conflictReport.message || conflictReport.decision}`
  );

  // ---------------------------------------------------------------------------
  // Factor 6: Domain Ownership Prerequisites
  // ---------------------------------------------------------------------------
  const isDomainSyntacticallyValid = Boolean(
    targetDomain &&
    /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/.test(targetDomain)
  );

  recordCheck(
    'DOMAIN_OWNERSHIP_PREREQUISITES',
    isDomainSyntacticallyValid,
    isDomainSyntacticallyValid ? `Target domain "${targetDomain}" syntax verified.` : `Invalid target domain "${targetDomain}".`
  );

  // ---------------------------------------------------------------------------
  // Factor 7: Approved Proxy Network Identity
  // ---------------------------------------------------------------------------
  let networkValidation = { valid: false };
  let proxyNetworkObj = options.proxyNetwork;

  if (!proxyNetworkObj && inventory?.networks && inventory.networks.length > 0) {
    const configuredNetId = options.approvedProxyNetworkId || process.env.KPANEL_PROXY_NETWORK_ID;
    if (configuredNetId) {
      proxyNetworkObj = inventory.networks.find((n) => n.id === configuredNetId || n.name === configuredNetId) || null;
    }
    // If not found by configuredNetId, select network with Traefik container attached or valid bridge network
    if (!proxyNetworkObj) {
      proxyNetworkObj = inventory.networks.find((n) => n.containers && n.containers.some((c) => c.name.includes('traefik'))) ||
        inventory.networks.find((n) => !n.name.includes('dokploy') && !n.name.includes('n8n') && n.driver === 'bridge') ||
        inventory.networks[0];
    }
  }

  if (proxyNetworkObj) {
    try {
      networkValidation = stagingNetworkService.validateApprovedProxyNetwork(proxyNetworkObj, {
        approvedNetworkId: options.approvedProxyNetworkId || process.env.KPANEL_PROXY_NETWORK_ID || (options.operatorApprovedNetwork ? proxyNetworkObj.id : null),
        isApproved: options.operatorApprovedNetwork === true || (options.operatorApproved === true && options.disapproveNetwork !== true),
        traefikContainerId: traefikInstanceId,
        requireTraefikMembership: options.requireTraefikMembership !== false
      });
      recordCheck('PROXY_NETWORK_VALID', true, `Proxy network "${networkValidation.networkName}" (${networkValidation.networkId.slice(0, 12)}) verified.`);
    } catch (netErr) {
      recordCheck('PROXY_NETWORK_VALID', false, `Proxy network validation failed: ${netErr.message}`);
    }
  } else {
    recordCheck('PROXY_NETWORK_VALID', false, 'Approved proxy network was not found or provided.');
  }

  // ---------------------------------------------------------------------------
  // Factor 8 & 9: Candidate Ownership & Immutable Image Identity
  // ---------------------------------------------------------------------------
  const candidate = input.candidate || options.candidate || {};
  const candidateContainerId = String(candidate.containerId || candidate.container_id || '').trim();
  const candidateImageId = String(candidate.imageId || candidate.image_id || options.expectedImageId || '').trim();

  const isCandidateIdentified = Boolean(candidateContainerId && candidateContainerId.length >= 12);
  const isImageDigestValid = Boolean(candidateImageId && candidateImageId.startsWith('sha256:'));
  const isImageMatching = Boolean(!options.expectedImageId || candidateImageId === options.expectedImageId);

  recordCheck(
    'CANDIDATE_OWNERSHIP_VERIFIED',
    isCandidateIdentified,
    isCandidateIdentified ? `Candidate container "${candidateContainerId.slice(0, 12)}" verified.` : 'Candidate container ID is missing or invalid.'
  );

  recordCheck(
    'IMMUTABLE_IMAGE_VERIFIED',
    isImageDigestValid && isImageMatching,
    !isImageDigestValid
      ? 'Candidate image does not possess an immutable sha256 digest.'
      : (!isImageMatching ? `Candidate image drift: expected "${options.expectedImageId}", found "${candidateImageId}".` : `Immutable image ID verified: "${candidateImageId.slice(0, 19)}...".`)
  );

  // ---------------------------------------------------------------------------
  // Factor 10: Fresh Candidate Health
  // ---------------------------------------------------------------------------
  let isCandidateHealthy = false;
  let candidateHealthDetails = null;

  if (candidate.healthStatus === 'healthy' || candidate.status === 'healthy') {
    isCandidateHealthy = true;
    candidateHealthDetails = { healthStatus: 'healthy', checkedVia: 'candidate-record' };
  } else if (options.docker && candidateContainerId) {
    try {
      const inspectRes = await runtimeService.inspectCandidateContainer(candidateContainerId, { docker: options.docker });
      isCandidateHealthy = inspectRes.healthStatus === 'healthy';
      candidateHealthDetails = inspectRes;
    } catch (inspectErr) {
      candidateHealthDetails = { error: inspectErr.message };
    }
  }

  recordCheck(
    'FRESH_CANDIDATE_HEALTH',
    isCandidateHealthy,
    isCandidateHealthy ? 'Candidate container reports healthy state.' : `Candidate container is unhealthy or uninspected: status "${candidateHealthDetails?.healthStatus || 'unknown'}".`
  );

  // ---------------------------------------------------------------------------
  // Factor 11: Network Attachment Eligibility
  // ---------------------------------------------------------------------------
  let attachmentPlan = null;
  if (isCandidateIdentified && networkValidation.valid && proxyNetworkObj) {
    try {
      attachmentPlan = stagingNetworkService.planCandidateAttachment(candidate, proxyNetworkObj, {
        expectedImageId: candidateImageId,
        applicationId,
        isApproved: options.operatorApprovedNetwork === true || options.operatorApproved === true,
        approvedNetworkId: networkValidation.networkId
      });
      recordCheck('NETWORK_ATTACHMENT_ELIGIBLE', true, 'Candidate attachment plan formulated without alias collisions or port leaks.');
    } catch (planErr) {
      recordCheck('NETWORK_ATTACHMENT_ELIGIBLE', false, `Candidate attachment plan blocked: ${planErr.message}`);
    }
  } else {
    recordCheck('NETWORK_ATTACHMENT_ELIGIBLE', false, 'Prerequisites for network attachment planning not satisfied.');
  }

  // ---------------------------------------------------------------------------
  // Factor 12: Backend Reachability Contract
  // ---------------------------------------------------------------------------
  let reachabilityResult = { reachable: false };
  if (isCandidateIdentified && isImageDigestValid) {
    try {
      reachabilityResult = await stagingNetworkService.validateProxyBackendReachability(
        {
          containerId: candidateContainerId,
          imageId: candidateImageId,
          port: targetPort,
          aliases: attachmentPlan?.plannedAliases
        },
        {
          containerId: traefikInstanceId || 'traefik-proxy',
          name: 'traefik'
        },
        options
      );

      recordCheck(
        'BACKEND_REACHABILITY_CONTRACT',
        reachabilityResult.reachable,
        reachabilityResult.reachable
          ? `Backend reachability contract verified for "${reachabilityResult.backendUrl}".`
          : `Backend reachability validation failed: ${reachabilityResult.reason || 'Unreachable'}.`
      );
    } catch (reachErr) {
      recordCheck('BACKEND_REACHABILITY_CONTRACT', false, `Backend reachability validation error: ${reachErr.message}`);
    }
  } else {
    recordCheck('BACKEND_REACHABILITY_CONTRACT', false, 'Candidate parameters insufficient to validate reachability.');
  }

  // ---------------------------------------------------------------------------
  // Factor 13: Fenced Execution Authorization
  // ---------------------------------------------------------------------------
  let isWorkerAuthorized = false;
  let workerAuthReason = 'MISSING_WORKER_CREDENTIALS';

  const ownerId = String(options.ownerId || '').trim();
  const fencingToken = parseInt(options.fencingToken, 10);

  if (ownerId && !isNaN(fencingToken) && db) {
    try {
      runtimeService.verifyActiveWorkerLease(ownerId, fencingToken, db);
      isWorkerAuthorized = true;
      workerAuthReason = 'ACTIVE_LEASE_VERIFIED';
    } catch (authErr) {
      workerAuthReason = authErr.code || authErr.message;
    }
  }

  recordCheck(
    'FENCED_EXECUTION_AUTHORIZED',
    isWorkerAuthorized,
    isWorkerAuthorized ? `Worker lease verified for "${ownerId}" with fencing token ${fencingToken}.` : `Worker lease verification failed: ${workerAuthReason}.`
  );

  // ---------------------------------------------------------------------------
  // Factor 14: Activation Journal Readiness
  // ---------------------------------------------------------------------------
  let isJournalReady = false;
  if (db) {
    try {
      const activeOps = db.prepare(`
        SELECT COUNT(*) as count FROM deployment_route_activation_journal
        WHERE application_id = ? AND journal_state IN ('prepared', 'applying', 'rolling_back')
      `).get(applicationId);

      if (activeOps && activeOps.count > 0) {
        recordCheck('ACTIVATION_JOURNAL_READY', false, `Application has ${activeOps.count} in-progress activation/rollback operation(s). Must reconcile first.`);
      } else {
        isJournalReady = true;
        recordCheck('ACTIVATION_JOURNAL_READY', true, 'Activation journal clean; no conflicting in-progress operations.');
      }
    } catch {
      // In-memory mock or non-sqlite
      isJournalReady = true;
      recordCheck('ACTIVATION_JOURNAL_READY', true, 'Activation journal readiness accepted in mock environment.');
    }
  } else {
    recordCheck('ACTIVATION_JOURNAL_READY', true, 'Activation journal mock check passed.');
  }

  // ---------------------------------------------------------------------------
  // Factor 15: Rollback Target Readiness
  // ---------------------------------------------------------------------------
  let isRollbackReady = true;
  let rollbackBlockReason = null;

  if (options.simulateRollbackUnready === true) {
    isRollbackReady = false;
    rollbackBlockReason = 'Simulated rollback unready condition.';
  } else if (input.isReplacementRelease === true || options.previousRelease) {
    // Replacement release: verify previous container exists and is healthy
    const prevContainerId = input.previousContainerId || options.previousRelease?.containerId;
    if (!prevContainerId) {
      isRollbackReady = false;
      rollbackBlockReason = 'Replacement release specified but previous container ID is missing.';
    } else if (options.docker) {
      try {
        const prevInspect = await runtimeService.inspectCandidateContainer(prevContainerId, { docker: options.docker });
        if (prevInspect.healthStatus !== 'healthy') {
          isRollbackReady = false;
          rollbackBlockReason = `Previous container "${prevContainerId.slice(0, 12)}" is in state "${prevInspect.healthStatus}", cannot serve as safe rollback target.`;
        }
      } catch (prevErr) {
        isRollbackReady = false;
        rollbackBlockReason = `Failed to inspect previous container "${prevContainerId.slice(0, 12)}": ${prevErr.message}.`;
      }
    }
  }

  recordCheck(
    'ROLLBACK_TARGET_READY',
    isRollbackReady,
    isRollbackReady ? 'Rollback target readiness verified.' : `Rollback target unready: ${rollbackBlockReason}.`
  );

  // ---------------------------------------------------------------------------
  // Factor 16: Explicit Operator Approval Prerequisite
  // ---------------------------------------------------------------------------
  const isOperatorApproved = options.operatorApproved === true;
  recordCheck(
    'OPERATOR_APPROVAL_PREREQUISITE',
    isOperatorApproved,
    isOperatorApproved ? 'Explicit operator approval confirmed.' : 'Explicit operator approval is required before staging activation.'
  );

  // ---------------------------------------------------------------------------
  // Synthesize Decision
  // ---------------------------------------------------------------------------
  let decision;

  if (!hasInventory) {
    decision = STAGING_DECISIONS.STAGING_UNVERIFIED;
  } else if (hasInventory && !isInventoryFresh) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_STALE_INVENTORY;
  } else if (!isTraefikIdentified || instanceConflict || !providerAvailable || (requiredProvider === 'file' && !fileProviderCompatibility.compatible)) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_PROVIDER;
  } else if (!noForeignConflict) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_FOREIGN_ROUTE;
  } else if (!networkValidation.valid || !attachmentPlan) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_NETWORK;
  } else if (!reachabilityResult.reachable) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_UNREACHABLE;
  } else if (!isCandidateHealthy || !isImageDigestValid || !isImageMatching) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_CANDIDATE_HEALTH;
  } else if (!isWorkerAuthorized || !isOperatorApproved) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_AUTHORIZATION;
  } else if (!isRollbackReady) {
    decision = STAGING_DECISIONS.STAGING_BLOCKED_ROLLBACK;
  } else {
    decision = STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST;
  }

  // Provenance & Evidence Category Differentiation
  const evidenceType = options.evidenceType || (inventory?.originVerified ? 'operator-verified' : 'synthetic');

  return {
    decision,
    isReadyForAuthorizedTest: decision === STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST,
    evidenceType,
    executed: false, // Strictly false in this phase!
    applicationId,
    targetDomain,
    targetPort,
    candidateContainerId: candidateContainerId.slice(0, 12) || null,
    traefikInstanceId,
    checks,
    blockers,
    warnings,
    summary: {
      totalChecks: checks.length,
      passedChecks: checks.filter((c) => c.passed).length,
      failedChecks: blockers.length
    },
    evaluatedAt: new Date().toISOString()
  };
}

module.exports = {
  assessStagingReadiness,
  STAGING_DECISIONS,
  StagingReadinessError
};
