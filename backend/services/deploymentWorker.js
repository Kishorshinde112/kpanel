const crypto = require('crypto');
const path = require('path');
const { getDatabase } = require('../config/database');
const deploymentLeaseService = require('./deploymentLeaseService');
const deploymentQueueService = require('./deploymentQueueService');
const gitService = require('./gitService');
const githubRepositoryService = require('./githubRepositoryService');
const githubAppService = require('./githubAppService');

/**
 * Structured service error class for Deployment Worker operations.
 */
class DeploymentWorkerError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'DeploymentWorkerError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates immutable source metadata and current authorization status for a claimed deployment.
 * Fails closed if repository association, branch, or account allowlist has drifted.
 */
function validateWorkerSourceAuthorization(claimedJob, sourceMetadata, db, options = {}) {
  const { applicationId, commitSha } = claimedJob;

  if (!sourceMetadata) {
    throw new DeploymentWorkerError('Immutable deployment source metadata is missing.', 'DEPLOYMENT_SOURCE_INVALID');
  }

  // 1. Re-check application existence in SQLite
  const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(applicationId);
  if (!app) {
    throw new DeploymentWorkerError(`Application with ID "${applicationId}" was not found.`, 'APPLICATION_NOT_FOUND');
  }

  // 2. Re-check branch matches target ref
  const targetBranch = sourceMetadata.ref.startsWith('refs/heads/')
    ? sourceMetadata.ref.slice('refs/heads/'.length)
    : sourceMetadata.ref;

  if (app.branch !== targetBranch) {
    throw new DeploymentWorkerError(
      `Branch mismatch: Application branch "${app.branch}" does not match queued ref "${sourceMetadata.ref}".`,
      'REPOSITORY_ASSOCIATION_STALE'
    );
  }

  // 3. Re-check verified repository association
  let assoc;
  try {
    assoc = githubRepositoryService.getApplicationRepositoryAssociation(applicationId, { db, ...options });
  } catch (err) {
    if (err.name === 'GithubRepositoryError') {
      throw new DeploymentWorkerError(err.message, 'REPOSITORY_ASSOCIATION_STALE');
    }
    throw err;
  }

  if (!assoc || assoc.associationStatus !== 'verified') {
    throw new DeploymentWorkerError(
      'Application does not have an active, verified repository association.',
      'REPOSITORY_ASSOCIATION_STALE'
    );
  }

  // 4. Re-check installation status
  if (assoc.installationStatus !== 'active') {
    throw new DeploymentWorkerError(
      `GitHub App installation "${assoc.installationId}" is ${assoc.installationStatus}.`,
      'INSTALLATION_NOT_AUTHORIZED'
    );
  }

  // 5. Re-check account allowlist
  if (options.enforceAllowlist !== false) {
    const instRow = db.prepare('SELECT account_id FROM github_installations WHERE installation_id = ?').get(assoc.installationId);
    const accountId = instRow?.account_id || assoc.accountId;
    if (!githubAppService.isAccountAllowlisted(accountId, options)) {
      throw new DeploymentWorkerError(
        `GitHub account (${accountId || 'unknown'}) is not in GITHUB_ALLOWED_ACCOUNT_IDS allowlist.`,
        'INSTALLATION_NOT_AUTHORIZED'
      );
    }
  }

  // 6. Re-check URL integrity against verified repo
  try {
    const urlInfo = gitService.validateRepositoryUrl(app.repo_url, options);
    if (
      urlInfo.owner.toLowerCase() !== assoc.repositoryOwner.toLowerCase() ||
      urlInfo.repo.toLowerCase() !== assoc.repositoryName.toLowerCase()
    ) {
      throw new DeploymentWorkerError(
        'Application repository URL has drifted from verified association.',
        'REPOSITORY_ASSOCIATION_STALE'
      );
    }
  } catch (err) {
    if (err instanceof DeploymentWorkerError) throw err;
    throw new DeploymentWorkerError('Application repository URL is invalid.', 'REPOSITORY_ASSOCIATION_STALE');
  }

  return {
    app,
    assoc,
    targetBranch
  };
}

/**
 * Executes a single-iteration worker orchestration pass in prepare-only verification mode.
 * Acquires global lease, optionally enqueues inbox targets, claims a queued job, verifies
 * exact-commit checkout in an isolated workspace, and cleans up without side effects.
 *
 * @param {Object} options - Worker options
 * @returns {Promise<Object>} Execution result summary
 */
async function runOnce(options = {}) {
  const workerId = options.workerId || `worker-${crypto.randomUUID()}`;
  const leaseSeconds = options.leaseSeconds || 30;
  const db = options.db || getDatabase(options);

  // 1. Acquire global deployment execution lease
  const lease = deploymentLeaseService.acquireWorkerLease(workerId, {
    db,
    leaseSeconds
  });

  if (!lease.acquired) {
    return {
      executed: false,
      busy: true,
      reason: 'DEPLOYMENT_WORKER_BUSY',
      currentOwner: lease.currentOwner,
      leaseExpiresAt: lease.leaseExpiresAt
    };
  }

  const fencingToken = lease.fencingToken;
  let heartbeatTimer = null;
  let activeClaimedDeploymentId = null;
  let leaseLost = false;

  const abortController = new AbortController();
  let callerAbortListener = null;
  if (options.signal) {
    if (options.signal.aborted) {
      abortController.abort(options.signal.reason);
    } else {
      callerAbortListener = () => {
        abortController.abort(options.signal.reason);
      };
      options.signal.addEventListener('abort', callerAbortListener, { once: true });
    }
  }

  try {
    // 2. Setup periodic lease heartbeat during the active run
    const heartbeatIntervalMs = options.heartbeatIntervalMs || Math.max(1000, Math.floor((leaseSeconds / 3) * 1000));
    heartbeatTimer = setInterval(() => {
      try {
        const renewed = deploymentLeaseService.renewWorkerLease(workerId, fencingToken, { db, leaseSeconds });
        if (!renewed.renewed) {
          // Lease was lost or taken over
          leaseLost = true;
          clearInterval(heartbeatTimer);
          heartbeatTimer = null;
          abortController.abort(new DeploymentWorkerError('Worker lost lease or fencing token during execution.', 'LEASE_LOST'));
        }
      } catch {
        // Fail-safe catch for database errors during interval
      }
    }, heartbeatIntervalMs);
    heartbeatTimer.unref();

    // 3. Process inbox targets into queued jobs if requested
    if (options.enqueueBatch !== false) {
      try {
        deploymentQueueService.enqueueWebhookTargets({ db, ...options });
      } catch (err) {
        console.error('[Worker Queue Enqueue Warning]', err.message);
      }
    }

    // 4. Claim the next eligible queued deployment
    const claimResult = deploymentLeaseService.claimNextDeployment(workerId, fencingToken, {
      db,
      claimSeconds: options.claimSeconds || 60,
      maxAttempts: options.maxAttempts || 3
    });

    if (!claimResult.claimed || !claimResult.deployment) {
      return {
        executed: false,
        idle: true,
        workerId,
        fencingToken,
        message: 'No eligible queued deployments found.'
      };
    }

    const claimedJob = claimResult.deployment;
    const sourceMetadata = claimResult.sourceMetadata;
    activeClaimedDeploymentId = claimedJob.id;

    // 5. Verify source authorization before checkout
    let authContext;
    try {
      authContext = validateWorkerSourceAuthorization(claimedJob, sourceMetadata, db, options);
    } catch (authErr) {
      // Release claim and preserve queue state
      deploymentLeaseService.releaseDeploymentClaim(claimedJob.id, workerId, fencingToken, { db });
      activeClaimedDeploymentId = null;
      throw authErr;
    }

    const { app: validatedApp, targetBranch } = authContext;

    // 6. Execute Exact-Commit Git Checkout in Prepare-Only Mode
    const fetchOptions = {
      ...options,
      workspaceRoot: options.workspaceRoot,
      timeout: options.gitTimeout || 60000,
      signal: abortController.signal,
      authMode: authContext.assoc ? 'github-app' : 'public',
      installationId: authContext.assoc?.installationId,
      repositoryId: authContext.assoc?.repositoryId,
      repositoryName: authContext.assoc?.repositoryName,
      repositoryOwner: authContext.assoc?.repositoryOwner
    };

    let snapshot;
    try {
      snapshot = await gitService.fetchCommit(validatedApp, claimedJob.commitSha, fetchOptions);
    } catch (gitErr) {
      // Release claim on failure so it can be recovered or audited
      deploymentLeaseService.releaseDeploymentClaim(claimedJob.id, workerId, fencingToken, { db });
      activeClaimedDeploymentId = null;

      if (leaseLost || gitErr.code === 'LEASE_LOST') {
        throw new DeploymentWorkerError('Worker lost lease or fencing token during checkout.', 'LEASE_LOST');
      }

      if (options.signal && options.signal.aborted && gitErr.code === 'OPERATION_CANCELLED') {
        throw new DeploymentWorkerError('Worker execution was cancelled by caller.', 'OPERATION_CANCELLED');
      }

      throw gitErr;
    }

    // 7. Verify fencing token and lease validity before proceeding
    const currentLock = db.prepare(`
      SELECT owner_id, fencing_token,
             CAST(strftime('%s', 'now') AS INTEGER) as now_epoch,
             CAST(strftime('%s', lease_expires_at) AS INTEGER) as exp_epoch
      FROM deployment_worker_lock
      WHERE lock_name = ?
    `).get(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const isLeaseActive = currentLock &&
      currentLock.owner_id === workerId &&
      Number(currentLock.fencing_token) === Number(fencingToken) &&
      currentLock.now_epoch < currentLock.exp_epoch;

    if (!isLeaseActive || leaseLost) {
      gitService.cleanupWorkspace(snapshot, options);
      deploymentLeaseService.releaseDeploymentClaim(claimedJob.id, workerId, fencingToken, { db });
      activeClaimedDeploymentId = null;
      throw new DeploymentWorkerError(
        'Worker lost lease or fencing token before completing preparation.',
        'LEASE_LOST'
      );
    }

    // 8. Verify checked-out commit SHA matches claimed job commit SHA
    if (snapshot.commitSha.toLowerCase() !== claimedJob.commitSha.toLowerCase()) {
      gitService.cleanupWorkspace(snapshot, options);
      deploymentLeaseService.releaseDeploymentClaim(claimedJob.id, workerId, fencingToken, { db });
      activeClaimedDeploymentId = null;
      throw new DeploymentWorkerError(
        `Checked-out commit SHA "${snapshot.commitSha}" does not match claimed job commit "${claimedJob.commitSha}".`,
        'GIT_COMMIT_MISMATCH'
      );
    }

    // 9. Prepare-Only Mode Cleanup: Clean up temporary source workspace
    // In Phase 4A2, no Docker build or container launch occurs.
    gitService.cleanupWorkspace(snapshot, options);

    // Release prepare-only claim: restores claim_attempts so verification runs do not exhaust retry limits
    deploymentLeaseService.releasePrepareOnlyClaim(claimedJob.id, workerId, fencingToken, { db });
    activeClaimedDeploymentId = null;

    return {
      executed: true,
      deploymentId: claimedJob.id,
      applicationId: validatedApp.id,
      applicationName: validatedApp.name,
      commitSha: claimedJob.commitSha,
      branch: targetBranch,
      prepared: true,
      status: 'queued',
      workerId,
      fencingToken,
      message: 'Exact commit source prepared and verified successfully in prepare-only mode.'
    };
  } finally {
    if (options.signal && callerAbortListener) {
      try { options.signal.removeEventListener('abort', callerAbortListener); } catch {}
    }
    // Stop active heartbeat timer
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }

    // Release any lingering uncommitted claim
    if (activeClaimedDeploymentId) {
      try {
        deploymentLeaseService.releaseDeploymentClaim(activeClaimedDeploymentId, workerId, fencingToken, { db });
      } catch {}
    }

    // Release global worker execution lease
    try {
      deploymentLeaseService.releaseWorkerLease(workerId, fencingToken, { db });
    } catch {}
  }
}

module.exports = {
  runOnce,
  validateWorkerSourceAuthorization,
  DeploymentWorkerError
};
