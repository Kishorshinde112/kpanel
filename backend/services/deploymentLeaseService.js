const { getDatabase } = require('../config/database');

/**
 * Structured service error class for Deployment Lease operations.
 */
class DeploymentLeaseError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'DeploymentLeaseError';
    this.code = code;
    this.details = details;
  }
}

const GLOBAL_LOCK_NAME = 'global_deployment_worker';
const DEFAULT_LEASE_DURATION_SEC = 30; // 30 seconds global worker lease
const DEFAULT_CLAIM_DURATION_SEC = 60; // 60 seconds per-job execution claim
const DEFAULT_MAX_CLAIM_ATTEMPTS = 3;  // Maximum retry attempts before job is skipped

/**
 * Attempts to acquire or takeover the singleton global deployment execution lease.
 * Enforces atomic SQLite write transactions and monotonically increasing fencing tokens.
 *
 * @param {string} ownerId - Unique identifier of the worker process (e.g. worker UUID)
 * @param {Object} options - Lease options
 * @param {number} [options.leaseSeconds=30] - Lease validity duration in seconds
 * @returns {Object} { acquired, ownerId, fencingToken, leaseExpiresAt, busy, isTakeover, renewed }
 */
function acquireWorkerLease(ownerId, options = {}) {
  if (!ownerId || typeof ownerId !== 'string' || ownerId.trim().length === 0) {
    throw new DeploymentLeaseError('Owner ID is required to acquire worker lease.', 'DATABASE_ERROR');
  }

  const cleanOwnerId = ownerId.trim();
  const leaseSeconds = Math.max(5, parseInt(options.leaseSeconds, 10) || DEFAULT_LEASE_DURATION_SEC);
  const db = options.db || getDatabase(options);

  const acquireTx = db.transaction(() => {
    // 1. Read current global lock state with normalized integer epoch timestamps
    const current = db.prepare(`
      SELECT lock_name, owner_id, fencing_token, lease_expires_at,
             CAST(strftime('%s', 'now') AS INTEGER) as now_epoch,
             CAST(strftime('%s', lease_expires_at) AS INTEGER) as exp_epoch
      FROM deployment_worker_lock
      WHERE lock_name = ?
    `).get(GLOBAL_LOCK_NAME);

    // Case A: No lock row exists yet -> Initial acquisition
    if (!current) {
      db.prepare(`
        INSERT INTO deployment_worker_lock (
          lock_name, owner_id, fencing_token, lease_expires_at, heartbeat_at, updated_at
        ) VALUES (
          ?, ?, 1, datetime('now', ?), CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(GLOBAL_LOCK_NAME, cleanOwnerId, `+${leaseSeconds} seconds`);

      const row = db.prepare('SELECT fencing_token, lease_expires_at FROM deployment_worker_lock WHERE lock_name = ?').get(GLOBAL_LOCK_NAME);
      return {
        acquired: true,
        busy: false,
        ownerId: cleanOwnerId,
        fencingToken: row.fencing_token,
        leaseExpiresAt: row.lease_expires_at,
        isTakeover: false,
        renewed: false
      };
    }

    // Case B: Same owner already holds the lease -> Extend / Renew
    if (current.owner_id === cleanOwnerId) {
      db.prepare(`
        UPDATE deployment_worker_lock
        SET lease_expires_at = datetime('now', ?),
            heartbeat_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE lock_name = ? AND owner_id = ?
      `).run(`+${leaseSeconds} seconds`, GLOBAL_LOCK_NAME, cleanOwnerId);

      const row = db.prepare('SELECT fencing_token, lease_expires_at FROM deployment_worker_lock WHERE lock_name = ?').get(GLOBAL_LOCK_NAME);
      return {
        acquired: true,
        busy: false,
        ownerId: cleanOwnerId,
        fencingToken: row.fencing_token,
        leaseExpiresAt: row.lease_expires_at,
        isTakeover: false,
        renewed: true
      };
    }

    // Case C: Different owner holds an active, unexpired lease -> Busy
    const isExpired = current.now_epoch >= current.exp_epoch;
    if (!isExpired) {
      return {
        acquired: false,
        busy: true,
        ownerId: cleanOwnerId,
        currentOwner: current.owner_id,
        fencingToken: current.fencing_token,
        leaseExpiresAt: current.lease_expires_at,
        isTakeover: false,
        renewed: false
      };
    }

    // Case D: Previous owner's lease has expired -> Atomic Takeover with incremented fencing token
    const nextFencingToken = Number(current.fencing_token || 0) + 1;

    db.prepare(`
      UPDATE deployment_worker_lock
      SET owner_id = ?,
          fencing_token = ?,
          lease_expires_at = datetime('now', ?),
          heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE lock_name = ?
    `).run(cleanOwnerId, nextFencingToken, `+${leaseSeconds} seconds`, GLOBAL_LOCK_NAME);

    const row = db.prepare('SELECT fencing_token, lease_expires_at FROM deployment_worker_lock WHERE lock_name = ?').get(GLOBAL_LOCK_NAME);
    return {
      acquired: true,
      busy: false,
      ownerId: cleanOwnerId,
      fencingToken: row.fencing_token,
      leaseExpiresAt: row.lease_expires_at,
      isTakeover: true,
      renewed: false
    };
  });

  return acquireTx.immediate();
}

/**
 * Renews an active worker lease if and only if the owner and fencing token match and it has not expired.
 *
 * @param {string} ownerId - Current lease owner UUID
 * @param {number} fencingToken - Monotonically increasing fencing token
 * @param {Object} options - Options
 * @returns {Object} { renewed: boolean, leaseExpiresAt }
 */
function renewWorkerLease(ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const leaseSeconds = Math.max(5, parseInt(options.leaseSeconds, 10) || DEFAULT_LEASE_DURATION_SEC);
  const db = options.db || getDatabase(options);

  const renewTx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE deployment_worker_lock
      SET lease_expires_at = datetime('now', ?),
          heartbeat_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE lock_name = ?
        AND owner_id = ?
        AND fencing_token = ?
        AND CAST(strftime('%s', lease_expires_at) AS INTEGER) > CAST(strftime('%s', 'now') AS INTEGER)
    `).run(`+${leaseSeconds} seconds`, GLOBAL_LOCK_NAME, cleanOwnerId, tokenNum);

    if (result.changes === 0) {
      return {
        renewed: false,
        ownerId: cleanOwnerId,
        fencingToken: tokenNum,
        reason: 'LEASE_STALE_OR_LOST'
      };
    }

    const row = db.prepare('SELECT lease_expires_at FROM deployment_worker_lock WHERE lock_name = ?').get(GLOBAL_LOCK_NAME);
    return {
      renewed: true,
      ownerId: cleanOwnerId,
      fencingToken: tokenNum,
      leaseExpiresAt: row.lease_expires_at
    };
  });

  return renewTx.immediate();
}

/**
 * Releases the global worker lease safely if the owner and fencing token match.
 *
 * @param {string} ownerId - Current lease owner UUID
 * @param {number} fencingToken - Fencing token
 * @param {Object} options - Options
 * @returns {Object} { released: boolean }
 */
function releaseWorkerLease(ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const db = options.db || getDatabase(options);

  const releaseTx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE deployment_worker_lock
      SET lease_expires_at = datetime('now', '-1 second'),
          updated_at = CURRENT_TIMESTAMP
      WHERE lock_name = ?
        AND owner_id = ?
        AND fencing_token = ?
    `).run(GLOBAL_LOCK_NAME, cleanOwnerId, tokenNum);

    return {
      released: result.changes > 0
    };
  });

  return releaseTx.immediate();
}

/**
 * Atomically claims the oldest eligible queued deployment job.
 * Requires an active, unexpired global worker lease with matching owner and fencing token.
 *
 * @param {string} ownerId - Worker process ID
 * @param {number} fencingToken - Current fencing token
 * @param {Object} options - Claim options
 * @returns {Object} { claimed: boolean, deployment: Object|null, sourceMetadata: Object|null }
 */
function claimNextDeployment(ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const claimSeconds = Math.max(10, parseInt(options.claimSeconds, 10) || DEFAULT_CLAIM_DURATION_SEC);
  const maxAttempts = Math.max(1, parseInt(options.maxAttempts, 10) || DEFAULT_MAX_CLAIM_ATTEMPTS);
  const db = options.db || getDatabase(options);

  const claimTx = db.transaction(() => {
    // 1. Validate that the caller holds the active global worker lease with integer epoch comparison
    const lockRow = db.prepare(`
      SELECT owner_id, fencing_token, lease_expires_at,
             CAST(strftime('%s', 'now') AS INTEGER) as now_epoch,
             CAST(strftime('%s', lease_expires_at) AS INTEGER) as exp_epoch
      FROM deployment_worker_lock
      WHERE lock_name = ?
    `).get(GLOBAL_LOCK_NAME);

    if (
      !lockRow ||
      lockRow.owner_id !== cleanOwnerId ||
      Number(lockRow.fencing_token) !== tokenNum ||
      lockRow.now_epoch >= lockRow.exp_epoch
    ) {
      throw new DeploymentLeaseError(
        'Cannot claim deployment jobs without active, unexpired global worker lease.',
        'LEASE_STALE'
      );
    }

    // 2. Query oldest eligible queued deployment with epoch-normalized expiration check
    const eligibleJob = db.prepare(`
      SELECT d.id, d.application_id, d.commit_sha, d.claim_attempts, d.status
      FROM deployments d
      WHERE d.status = 'queued'
        AND (d.lease_owner IS NULL OR CAST(strftime('%s', d.lease_expires_at) AS INTEGER) <= CAST(strftime('%s', 'now') AS INTEGER))
        AND d.claim_attempts < ?
      ORDER BY d.created_at ASC, d.id ASC
      LIMIT 1
    `).get(maxAttempts);

    if (!eligibleJob) {
      return {
        claimed: false,
        deployment: null,
        sourceMetadata: null
      };
    }

    // 3. Atomically write claim metadata to the deployment record
    db.prepare(`
      UPDATE deployments
      SET lease_owner = ?,
          lease_token = ?,
          lease_expires_at = datetime('now', ?),
          claim_attempts = claim_attempts + 1,
          claimed_at = CURRENT_TIMESTAMP,
          last_heartbeat_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `).run(cleanOwnerId, tokenNum, `+${claimSeconds} seconds`, eligibleJob.id);

    // 4. Retrieve immutable source metadata
    const sourceRow = db.prepare(`
      SELECT s.*, a.name as application_name, a.slug as application_slug, a.repo_url, a.branch
      FROM github_webhook_deployment_sources s
      JOIN applications a ON s.application_id = a.id
      WHERE s.deployment_id = ?
    `).get(eligibleJob.id);

    const updatedJob = db.prepare(`
      SELECT id, application_id, commit_sha, status, claim_attempts, lease_owner, lease_token, lease_expires_at, claimed_at
      FROM deployments WHERE id = ?
    `).get(eligibleJob.id);

    return {
      claimed: true,
      deployment: {
        id: updatedJob.id,
        applicationId: updatedJob.application_id,
        commitSha: updatedJob.commit_sha,
        status: updatedJob.status,
        claimAttempts: updatedJob.claim_attempts,
        leaseOwner: updatedJob.lease_owner,
        leaseToken: updatedJob.lease_token,
        leaseExpiresAt: updatedJob.lease_expires_at,
        claimedAt: updatedJob.claimed_at
      },
      sourceMetadata: sourceRow || null
    };
  });

  return claimTx.immediate();
}

/**
 * Renews the claim lease on an in-progress deployment.
 */
function renewDeploymentClaim(deploymentId, ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const claimSeconds = Math.max(10, parseInt(options.claimSeconds, 10) || DEFAULT_CLAIM_DURATION_SEC);
  const db = options.db || getDatabase(options);

  const renewTx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE deployments
      SET lease_expires_at = datetime('now', ?),
          last_heartbeat_at = CURRENT_TIMESTAMP
      WHERE id = ?
        AND lease_owner = ?
        AND lease_token = ?
        AND CAST(strftime('%s', lease_expires_at) AS INTEGER) > CAST(strftime('%s', 'now') AS INTEGER)
    `).run(`+${claimSeconds} seconds`, deploymentId.trim(), cleanOwnerId, tokenNum);

    return {
      renewed: result.changes > 0
    };
  });

  return renewTx.immediate();
}

/**
 * Releases a claim on an unexecuted deployment, returning it to the open queue.
 */
function releaseDeploymentClaim(deploymentId, ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const db = options.db || getDatabase(options);

  const releaseTx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE deployments
      SET lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL
      WHERE id = ?
        AND lease_owner = ?
        AND lease_token = ?
    `).run(deploymentId.trim(), cleanOwnerId, tokenNum);

    return {
      released: result.changes > 0
    };
  });

  return releaseTx.immediate();
}

/**
 * Releases a claim on an unexecuted deployment in prepare-only verification mode.
 * Clears the claim lease and decrements claim_attempts back so verification passes
 * do not exhaust production claim attempts.
 */
function releasePrepareOnlyClaim(deploymentId, ownerId, fencingToken, options = {}) {
  const cleanOwnerId = String(ownerId || '').trim();
  const tokenNum = parseInt(fencingToken, 10);
  const db = options.db || getDatabase(options);

  const releaseTx = db.transaction(() => {
    const result = db.prepare(`
      UPDATE deployments
      SET lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          claim_attempts = MAX(0, claim_attempts - 1)
      WHERE id = ?
        AND lease_owner = ?
        AND lease_token = ?
    `).run(deploymentId.trim(), cleanOwnerId, tokenNum);

    return {
      released: result.changes > 0
    };
  });

  return releaseTx.immediate();
}

module.exports = {
  acquireWorkerLease,
  renewWorkerLease,
  releaseWorkerLease,
  claimNextDeployment,
  renewDeploymentClaim,
  releaseDeploymentClaim,
  releasePrepareOnlyClaim,
  GLOBAL_LOCK_NAME,
  DEFAULT_LEASE_DURATION_SEC,
  DEFAULT_CLAIM_DURATION_SEC,
  DEFAULT_MAX_CLAIM_ATTEMPTS,
  DeploymentLeaseError
};
