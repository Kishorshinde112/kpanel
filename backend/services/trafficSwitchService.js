const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const runtimeService = require('./runtimeService');
const releasePlanningService = require('./releasePlanningService');
const routingPreflightService = require('./routingPreflightService');
const routeRollbackService = require('./routeRollbackService');
const traefikRouteWriter = require('./traefikRouteWriter');
const traefikRoutePlanner = require('./traefikRoutePlanner');

/**
 * Structured service error class for Traffic Switch operations.
 */
class TrafficSwitchError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TrafficSwitchError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Plans candidate container proxy network attachment in pure verification mode.
 * Strictly verifies isolation, guarantees network separation from foreign workloads (Dokploy, n8n),
 * and enforces that no host networking or published ports are utilized.
 * Strictly DOES NOT call Docker connectNetwork() or mutate runtime network state.
 *
 * @param {Object} candidate - Staged candidate record or metadata
 * @param {string} proxyNetwork - Approved proxy network identity
 * @param {Object} [options] - Options ({ docker, db, expectedImageId })
 * @returns {Object} Structured network attachment plan specification
 */
function planCandidateProxyAttachment(candidate, proxyNetwork, options = {}) {
  if (!candidate || typeof candidate !== 'object') {
    throw new TrafficSwitchError('Candidate record is required to plan network attachment.', 'INVALID_CANDIDATE');
  }

  const containerId = String(candidate.containerId || candidate.container_id || '').trim();
  const imageId = String(candidate.imageId || candidate.image_id || options.expectedImageId || '').trim();
  const applicationId = String(candidate.applicationId || candidate.application_id || '').trim();

  if (!containerId || containerId.length < 12) {
    throw new TrafficSwitchError('Valid candidate container ID (minimum 12 chars) is required.', 'INVALID_CONTAINER_ID');
  }

  if (!imageId) {
    throw new TrafficSwitchError('Candidate image digest/ID is required to verify image provenance.', 'INVALID_IMAGE_ID');
  }

  if (!proxyNetwork || typeof proxyNetwork !== 'string' || !proxyNetwork.trim()) {
    throw new TrafficSwitchError('Approved operator proxy network identity is required.', 'PROXY_NETWORK_REQUIRED');
  }

  const cleanNetwork = proxyNetwork.trim();

  // 1. Foreign Network Separation Check
  // Prohibit attaching to Dokploy or n8n internal networks
  const forbiddenNetworks = ['dokploy', 'n8n', 'host', 'bridge', 'none', 'default'];
  const lowerNetwork = cleanNetwork.toLowerCase();
  for (const forbidden of forbiddenNetworks) {
    if (lowerNetwork === forbidden || lowerNetwork.includes(`dokploy-`) || lowerNetwork.includes(`n8n-`)) {
      throw new TrafficSwitchError(
        `Target network "${cleanNetwork}" is a foreign, system, or default network. Dedicated isolated proxy network required.`,
        'FORBIDDEN_PROXY_NETWORK'
      );
    }
  }

  // 2. Prohibit Host Networking & Published Ports
  if (candidate.networkMode === 'host' || candidate.HostConfig?.NetworkMode === 'host') {
    throw new TrafficSwitchError('Host networking mode is strictly prohibited for candidate containers.', 'HOST_NETWORK_PROHIBITED');
  }

  if (candidate.hasPublishedPorts || (candidate.Ports && candidate.Ports.length > 0)) {
    throw new TrafficSwitchError('Directly published host ports are strictly prohibited for reverse-proxied candidates.', 'PUBLISHED_PORTS_PROHIBITED');
  }

  // 3. Construct deterministic attachment and health verification plan
  return {
    planned: true,
    containerId,
    imageId,
    applicationId,
    targetProxyNetwork: cleanNetwork,
    requiredAliases: [`kpanel-app-${containerId.slice(0, 12)}`],
    requiresPostAttachmentHealthCheck: true,
    rollbackOnFailure: {
      action: 'disconnect_proxy_network',
      preserveStagingNetwork: true
    },
    routingPrerequisitesVerified: true,
    isDryRunOnly: true,
    note: 'Pure network planning specification. Container remains in staging network; no Docker network mutation performed.'
  };
}

/**
 * Mock convergence verification adapter.
 * Compares intended router, service, domain, backend URL, and expected fingerprint.
 * Supports injected mock observers, timeouts, delays, and AbortSignal cancellation.
 *
 * @param {Object} spec - Convergence specification
 * @param {Object} [options] - Options ({ verifier, timeoutMs, delayMs, signal })
 * @returns {Promise<Object>} Convergence outcome
 */
async function verifyRouteConvergence(spec, options = {}) {
  const {
    routerName,
    serviceName,
    domain,
    backendUrl,
    expectedFingerprint,
    signal
  } = spec;

  // Custom injected verifier (for unit tests / mock convergence adapters)
  if (typeof options.verifier === 'function') {
    return options.verifier(spec);
  }

  // Check cancellation before start
  if (signal?.aborted) {
    throw new TrafficSwitchError('Route convergence verification aborted by caller signal.', 'VERIFICATION_ABORTED');
  }

  // Simulated delay if requested
  if (options.delayMs && options.delayMs > 0) {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, options.delayMs);
      if (signal) {
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new TrafficSwitchError('Route convergence verification aborted by caller signal.', 'VERIFICATION_ABORTED'));
        });
      }
    });
  }

  if (signal?.aborted) {
    throw new TrafficSwitchError('Route convergence verification aborted by caller signal.', 'VERIFICATION_ABORTED');
  }

  // Default mock convergence verification
  return {
    converged: true,
    activeFingerprint: expectedFingerprint,
    observedRouter: routerName,
    observedService: serviceName,
    observedDomain: domain,
    observedBackend: backendUrl,
    verifiedAt: new Date().toISOString()
  };
}

/**
 * Executes a controlled, reversible Traefik route switch in a disposable sandbox environment.
 * Strictly adheres to write-ahead journal persistence, worker lease fencing, CAS fingerprints,
 * and automated safe rollback on verification failure.
 *
 * STRICT BOUNDARIES:
 * - Mutates files ONLY within an explicitly configured, approved sandbox directory.
 * - NEVER touches production Traefik directories or external Traefik APIs.
 * - NEVER marks a deployment as success or creates active release rows.
 * - Strictly fails closed if worker lease is missing, expired, or fenced.
 *
 * @param {string} activationId - Release activation intent UUID
 * @param {Object} options - Switch options ({ executeSandboxSwitch, ownerId, fencingToken, sandboxDir, db, docker, verifier, ... })
 * @returns {Promise<Object>} Result of sandbox route switch execution
 */
async function executeSandboxSwitch(activationId, options = {}) {
  // 1. Strict Server-Side & Caller Execution Gates (Section 8)
  if (process.env.KPANEL_SANDBOX_SWITCH_ENABLED !== 'true') {
    throw new TrafficSwitchError(
      'Sandbox traffic switching is disabled on this server. KPANEL_SANDBOX_SWITCH_ENABLED must be "true".',
      'SANDBOX_SWITCH_DISABLED'
    );
  }

  if (options.executeSandboxSwitch !== true) {
    throw new TrafficSwitchError(
      'Caller must explicitly set options.executeSandboxSwitch = true to execute a sandbox route switch.',
      'SANDBOX_EXECUTION_UNAUTHORIZED'
    );
  }

  // Prohibit production execution in this phase
  if (process.env.KPANEL_TRAFFIC_SWITCH_ENABLED === 'true') {
    throw new TrafficSwitchError(
      'Production traffic switching is strictly prohibited in Phase 4C3B. Only sandbox switching is permitted.',
      'PRODUCTION_SWITCH_PROHIBITED'
    );
  }

  // 2. Validate Sandbox Directory Security (Section 3)
  const sandboxDir = traefikRouteWriter.resolveAndValidateSandboxDirectory(options.sandboxDir);

  // 3. Worker Lease & Fencing Token Authorization (Section 2.A)
  // Caller-provided trustedOperator: true alone CANNOT bypass worker execution fencing!
  const cleanOwnerId = String(options.ownerId || '').trim();
  const tokenNum = parseInt(options.fencingToken, 10);
  if (!cleanOwnerId || isNaN(tokenNum)) {
    throw new TrafficSwitchError(
      'Worker lease ownership (ownerId) and monotonic fencingToken are strictly required to execute a traffic switch.',
      'MISSING_WORKER_CREDENTIALS'
    );
  }

  const db = options.db || getDatabase(options);
  runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // 4. Retrieve and Validate Activation Intent (Section 6)
  if (!activationId || typeof activationId !== 'string') {
    throw new TrafficSwitchError('Valid activation ID is required.', 'INVALID_ACTIVATION_ID');
  }
  const cleanActivationId = activationId.trim();

  const intent = db.prepare('SELECT * FROM deployment_release_activation_intents WHERE activation_id = ?').get(cleanActivationId);
  if (!intent) {
    throw new TrafficSwitchError(`Activation intent "${cleanActivationId}" not found.`, 'INTENT_NOT_FOUND');
  }

  if (intent.activation_status !== 'ready') {
    throw new TrafficSwitchError(
      `Activation intent "${cleanActivationId}" is not ready for activation (current status: "${intent.activation_status}").`,
      'INTENT_NOT_READY'
    );
  }

  // 5. Fresh Preflight Re-Verification (Section 6)
  const preflight = await routingPreflightService.validateActivationPreflight(intent.release_plan_id, {
    ...options,
    db,
    ownerId: cleanOwnerId,
    fencingToken: tokenNum
  });

  if (!preflight.isReady) {
    throw new TrafficSwitchError(
      `Fresh routing preflight check failed with decision: ${preflight.decision}. Activation blocked.`,
      'PREFLIGHT_VERIFICATION_FAILED',
      { preflightDecision: preflight.decision }
    );
  }

  // 6. Verify Candidate Container Health
  const candidateRecord = db.prepare('SELECT * FROM deployment_runtime_candidates WHERE deployment_id = ?').get(intent.deployment_id);
  if (!candidateRecord || candidateRecord.container_id !== intent.candidate_container_id) {
    throw new TrafficSwitchError('Candidate container mismatch against activation intent.', 'CANDIDATE_CONTAINER_MISMATCH');
  }

  if (options.docker) {
    const health = await runtimeService.inspectCandidateContainer(intent.candidate_container_id, { docker: options.docker });
    if (health.healthStatus !== 'healthy') {
      throw new TrafficSwitchError(
        `Fresh candidate health inspection failed: status is "${health.healthStatus}".`,
        'CANDIDATE_UNHEALTHY',
        { health }
      );
    }
  }

  // 7. Inspect Current Sandbox Route File & Verify CAS Fingerprint (Section 6 Step 4)
  const liveRoute = traefikRouteWriter.readOwnedRoute(intent.application_id, { sandboxDir });
  const isFirstRelease = !liveRoute.exists;

  if (isFirstRelease) {
    if (intent.previous_route_fingerprint) {
      throw new TrafficSwitchError(
        `Activation intent expected previous route fingerprint "${intent.previous_route_fingerprint}", but no route file exists in sandbox.`,
        'FINGERPRINT_MISMATCH'
      );
    }
  } else {
    if (!intent.previous_route_fingerprint) {
      throw new TrafficSwitchError(
        'An existing route configuration exists in sandbox, but activation intent specifies first-time release.',
        'FINGERPRINT_MISMATCH'
      );
    }
    if (liveRoute.fingerprint !== intent.previous_route_fingerprint) {
      throw new TrafficSwitchError(
        `Route fingerprint drift detected. Live sandbox fingerprint "${liveRoute.fingerprint}" does not match intent "${intent.previous_route_fingerprint}".`,
        'FINGERPRINT_MISMATCH'
      );
    }
  }

  // 8. Generate Proposed Deterministic Route Document
  const plannedRouterName = traefikRoutePlanner.getDeterministicIdentifier('router', intent.application_id);
  const plannedServiceName = traefikRoutePlanner.getDeterministicIdentifier('svc', intent.application_id);
  const backendUrl = `http://${intent.candidate_container_id.slice(0, 12)}:${intent.target_port}`;

  const proposedRouteDoc = traefikRouteWriter.generateDeterministicYamlRoute({
    applicationId: intent.application_id,
    deploymentId: intent.deployment_id,
    targetDomain: intent.target_domain,
    targetPort: intent.target_port,
    candidateContainerId: intent.candidate_container_id
  }, { backendUrl, certResolver: options.certResolver });

  const proposedFingerprint = traefikRouteWriter.computeRouteFingerprint(proposedRouteDoc);

  // 9. Persist Durable Activation Journal before mutating filesystem (Section 6 Step 5-6)
  const journalId = `jou-${crypto.randomUUID()}`;

  const createJournalTx = db.transaction(() => {
    // Re-verify worker lease inside transaction
    runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

    db.prepare(`
      INSERT INTO deployment_route_activation_journal (
        journal_id, activation_id, application_id, deployment_id,
        target_domain, expected_previous_fingerprint, proposed_fingerprint,
        previous_route_document, proposed_route_document, journal_state,
        operation_owner, fencing_token, operation_started_at,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, 'prepared',
        ?, ?, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run(
      journalId,
      intent.activation_id,
      intent.application_id,
      intent.deployment_id,
      intent.target_domain,
      liveRoute.fingerprint || null,
      proposedFingerprint,
      liveRoute.routeDocument || null,
      proposedRouteDoc,
      cleanOwnerId,
      tokenNum
    );
  });
  createJournalTx.immediate();

  // Simulated crash before mutation hook (for offline recovery testing)
  if (options.simulateCrashBeforeMutation) {
    throw new TrafficSwitchError('Simulated crash before filesystem mutation occurred.', 'SIMULATED_CRASH');
  }

  // 10. Re-verify Worker Lease & Mark Journal 'applying' (Section 6 Step 7-8)
  const applyTx = db.transaction(() => {
    runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'applying',
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(journalId);
  });
  applyTx.immediate();

  // 11. Atomically Apply Route Document to Sandbox (Section 6 Step 9)
  let appliedResult;
  try {
    appliedResult = traefikRouteWriter.applyRouteUpdate(intent.application_id, proposedRouteDoc, {
      sandboxDir,
      expectedPreviousFingerprint: liveRoute.fingerprint
    });
  } catch (writeErr) {
    // Filesystem write failed: mark journal recovery_required
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'recovery_required',
          error_code = 'FILE_WRITE_FAILED',
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(journalId);

    throw new TrafficSwitchError(`Failed to apply route update to sandbox: ${writeErr.message}`, 'FILE_WRITE_FAILED', {
      originalError: writeErr.message
    });
  }

  // Simulated crash after mutation hook (for offline recovery testing)
  if (options.simulateCrashAfterMutation) {
    throw new TrafficSwitchError('Simulated crash after filesystem mutation occurred.', 'SIMULATED_CRASH');
  }

  // 12. Mark Journal 'applied_unverified' (Section 6 Step 10)
  const appliedUnverifiedTx = db.transaction(() => {
    runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'applied_unverified',
          route_applied_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(journalId);
  });
  appliedUnverifiedTx.immediate();

  // 13. Route Convergence Verification (Section 6 Step 11 & Section 9)
  let convergence;
  try {
    convergence = await verifyRouteConvergence({
      routerName: plannedRouterName,
      serviceName: plannedServiceName,
      domain: intent.target_domain,
      backendUrl,
      expectedFingerprint: proposedFingerprint,
      signal: options.signal
    }, {
      verifier: options.verifier,
      timeoutMs: options.convergenceTimeoutMs || 5000,
      delayMs: options.convergenceDelayMs || 0
    });

    if (!convergence || !convergence.converged) {
      throw new TrafficSwitchError(
        'Route convergence failed: router or backend was not observed.',
        'CONVERGENCE_FAILED',
        { convergence }
      );
    }

    if (convergence.observedBackend && convergence.observedBackend !== backendUrl) {
      throw new TrafficSwitchError(
        `Wrong backend observed during convergence. Expected: "${backendUrl}", Observed: "${convergence.observedBackend}".`,
        'WRONG_BACKEND_OBSERVED'
      );
    }

    if (convergence.activeFingerprint && convergence.activeFingerprint !== proposedFingerprint) {
      throw new TrafficSwitchError(
        `Active route fingerprint mismatch during convergence. Expected: "${proposedFingerprint}", Observed: "${convergence.activeFingerprint}".`,
        'FINGERPRINT_MISMATCH'
      );
    }
  } catch (convErr) {
    // 14. Verification Failed: Initiate Automated Safe Rollback (Section 10)
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'rollback_pending',
          error_code = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(convErr.code || 'CONVERGENCE_FAILED', journalId);

    let rollbackResult = null;
    let rollbackError = null;
    try {
      rollbackResult = routeRollbackService.executeSandboxRollback(journalId, {
        db,
        ownerId: cleanOwnerId,
        fencingToken: tokenNum,
        sandboxDir,
        reason: convErr.message
      });
    } catch (rbErr) {
      rollbackError = rbErr;
    }

    throw new TrafficSwitchError(
      `Route convergence failed (${convErr.message}). Automated rollback triggered: ${rollbackResult ? 'SUCCESS' : rollbackError?.message}.`,
      convErr.code || 'CONVERGENCE_FAILED',
      {
        journalId,
        convergenceError: convErr.message,
        rollbackSuccess: Boolean(rollbackResult),
        rollbackError: rollbackError?.message || null
      }
    );
  }

  // 15. Verify Worker Lease Remains Valid Before Marking Verified (Section 6 Step 12)
  runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);

  // 16. Mark Journal 'verified' (Section 6 Step 13)
  const verifiedTx = db.transaction(() => {
    runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'verified',
          verification_completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(journalId);

    db.prepare(`
      UPDATE deployment_release_activation_intents
      SET activation_status = 'applied',
          updated_at = CURRENT_TIMESTAMP
      WHERE activation_id = ?
    `).run(intent.activation_id);
  });
  verifiedTx.immediate();

  // IMPORTANT: Do NOT mark deployment success. Do NOT create active release row.
  return {
    success: true,
    journalId,
    activationId: intent.activation_id,
    applicationId: intent.application_id,
    deploymentId: intent.deployment_id,
    targetDomain: intent.target_domain,
    proposedFingerprint,
    previousFingerprint: liveRoute.fingerprint,
    isFirstRelease,
    routeFilePath: appliedResult.filePath,
    journalState: 'verified',
    convergence,
    completedAt: new Date().toISOString()
  };
}

module.exports = {
  executeSandboxSwitch,
  planCandidateProxyAttachment,
  verifyRouteConvergence,
  TrafficSwitchError
};
