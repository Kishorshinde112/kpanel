const crypto = require('crypto');
const path = require('path');
const { getDatabase } = require('../config/database');
const { validateRepositoryUrl } = require('./gitService');
const { isAccountAllowlisted } = require('./githubAppService');

/**
 * Structured service error class for Deployment Queue operations.
 */
class DeploymentQueueError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'DeploymentQueueError';
    this.code = code;
    this.details = details;
  }
}

const DEFAULT_LOG_DIR = path.resolve(path.join(__dirname, '..', 'data', 'logs', 'deployments'));

/**
 * Enqueues unprocessed webhook targets into durable deployment jobs.
 * Enforces strict authorization, deduplication, FIFO ordering, and transactional atomicity.
 *
 * @param {Object} options - Database and batch options
 * @returns {Object} { processedCount, enqueuedCount, deduplicatedCount, skippedCount, enqueuedJobs }
 */
function enqueueWebhookTargets(options = {}) {
  const db = options.db || getDatabase(options);
  const batchSize = Math.min(100, Math.max(1, parseInt(options.batchSize, 10) || 50));
  const logDir = options.logDir ? path.resolve(options.logDir) : DEFAULT_LOG_DIR;

  // 1. Query unprocessed targets belonging to accepted deliveries
  // Uses deterministic FIFO ordering: received_at ASC, created_at ASC
  const pendingTargets = db.prepare(`
    SELECT
      t.delivery_id,
      t.application_id,
      t.commit_sha,
      t.ref,
      t.created_at as target_created_at,
      d.event_name,
      d.installation_id as delivery_installation_id,
      d.repository_id as delivery_repository_id,
      d.received_at
    FROM github_webhook_targets t
    JOIN github_webhook_deliveries d ON t.delivery_id = d.delivery_id
    WHERE d.decision = 'accepted'
      AND NOT EXISTS (
        SELECT 1 FROM github_webhook_target_outcomes o
        WHERE o.delivery_id = t.delivery_id AND o.application_id = t.application_id
      )
    ORDER BY d.received_at ASC, t.created_at ASC
    LIMIT ?
  `).all(batchSize);

  if (pendingTargets.length === 0) {
    return {
      processedCount: 0,
      enqueuedCount: 0,
      deduplicatedCount: 0,
      skippedCount: 0,
      enqueuedJobs: []
    };
  }

  let enqueuedCount = 0;
  let deduplicatedCount = 0;
  let skippedCount = 0;
  const enqueuedJobs = [];

  // 2. Process all batch candidates inside a single atomic write transaction
  const processBatchTx = db.transaction(() => {
    const insertOutcomeStmt = db.prepare(`
      INSERT INTO github_webhook_target_outcomes (
        delivery_id, application_id, deployment_id, outcome, reason_code, created_at
      ) VALUES (
        @delivery_id, @application_id, @deployment_id, @outcome, @reason_code, CURRENT_TIMESTAMP
      )
    `);

    const insertDeploymentStmt = db.prepare(`
      INSERT INTO deployments (
        id, application_id, commit_sha, trigger_source, status, log_path, created_at
      ) VALUES (
        @id, @application_id, @commit_sha, 'webhook', 'queued', @log_path, CURRENT_TIMESTAMP
      )
    `);

    const insertSourceStmt = db.prepare(`
      INSERT INTO github_webhook_deployment_sources (
        deployment_id, application_id, delivery_id, installation_id, repository_id, repository_full_name, ref, commit_sha, created_at
      ) VALUES (
        @deployment_id, @application_id, @delivery_id, @installation_id, @repository_id, @repository_full_name, @ref, @commit_sha, CURRENT_TIMESTAMP
      )
    `);

    const checkExistingSourceStmt = db.prepare(`
      SELECT d.id, d.status FROM deployments d
      JOIN github_webhook_deployment_sources s ON d.id = s.deployment_id
      WHERE s.application_id = ? AND s.installation_id = ? AND s.repository_id = ? AND s.ref = ? AND s.commit_sha = ?
      LIMIT 1
    `);

    for (const target of pendingTargets) {
      // 1. Recheck application existence in SQLite
      const app = db.prepare('SELECT * FROM applications WHERE id = ?').get(target.application_id);
      if (!app) {
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: null,
          outcome: 'skipped',
          reason_code: 'APPLICATION_NOT_FOUND'
        });
        skippedCount++;
        continue;
      }

      // 2. Recheck application current branch matches the pushed branch
      const targetBranch = target.ref.startsWith('refs/heads/') ? target.ref.slice('refs/heads/'.length) : target.ref;
      if (app.branch !== targetBranch) {
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: null,
          outcome: 'skipped',
          reason_code: 'BRANCH_CHANGED'
        });
        skippedCount++;
        continue;
      }

      // 3. Recheck application verified repository association
      const assoc = db.prepare(`
        SELECT
          ar.installation_id,
          ar.repository_id,
          ar.repository_owner,
          ar.repository_name,
          ar.repository_full_name,
          ar.association_status,
          gi.account_id,
          gi.installation_status
        FROM application_repositories ar
        JOIN github_installations gi ON ar.installation_id = gi.installation_id
        WHERE ar.application_id = ?
      `).get(app.id);

      if (!assoc || assoc.association_status !== 'verified') {
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: null,
          outcome: 'skipped',
          reason_code: 'NOT_ASSOCIATED'
        });
        skippedCount++;
        continue;
      }

      // 4. Recheck installation status (reject suspended)
      if (assoc.installation_status !== 'active') {
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: null,
          outcome: 'skipped',
          reason_code: 'INSTALLATION_SUSPENDED'
        });
        skippedCount++;
        continue;
      }

      // 5. Recheck account allowlist policy
      if (options.enforceAllowlist !== false) {
        if (!isAccountAllowlisted(assoc.account_id, options)) {
          insertOutcomeStmt.run({
            delivery_id: target.delivery_id,
            application_id: target.application_id,
            deployment_id: null,
            outcome: 'skipped',
            reason_code: 'NOT_ALLOWLISTED'
          });
          skippedCount++;
          continue;
        }
      }

      // 6. Recheck repository identity drift against current app repo_url
      try {
        const urlInfo = validateRepositoryUrl(app.repo_url, options);
        if (
          urlInfo.owner.toLowerCase() !== assoc.repository_owner.toLowerCase() ||
          urlInfo.repo.toLowerCase() !== assoc.repository_name.toLowerCase()
        ) {
          insertOutcomeStmt.run({
            delivery_id: target.delivery_id,
            application_id: target.application_id,
            deployment_id: null,
            outcome: 'skipped',
            reason_code: 'REPO_DRIFTED'
          });
          skippedCount++;
          continue;
        }
      } catch {
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: null,
          outcome: 'skipped',
          reason_code: 'REPO_DRIFTED'
        });
        skippedCount++;
        continue;
      }

      // 7. Deduplication Check: Check if a deployment already exists for this exact commit & ref across all states
      const existingSource = checkExistingSourceStmt.get(
        app.id,
        assoc.installation_id,
        assoc.repository_id,
        target.ref,
        target.commit_sha
      );
      if (existingSource) {
        const reason = existingSource.status === 'queued' ? 'ALREADY_QUEUED' : 'ALREADY_DEPLOYED';
        insertOutcomeStmt.run({
          delivery_id: target.delivery_id,
          application_id: target.application_id,
          deployment_id: existingSource.id,
          outcome: 'deduplicated',
          reason_code: reason
        });
        deduplicatedCount++;
        continue;
      }

      // 8. Create new queued deployment and persist source metadata
      const deploymentId = crypto.randomUUID();
      const deploymentLogPath = path.join(logDir, `${deploymentId}.log`);

      try {
        insertDeploymentStmt.run({
          id: deploymentId,
          application_id: app.id,
          commit_sha: target.commit_sha,
          log_path: deploymentLogPath
        });

        insertSourceStmt.run({
          deployment_id: deploymentId,
          application_id: app.id,
          delivery_id: target.delivery_id,
          installation_id: assoc.installation_id,
          repository_id: assoc.repository_id,
          repository_full_name: assoc.repository_full_name,
          ref: target.ref,
          commit_sha: target.commit_sha
        });
      } catch (insertErr) {
        if (insertErr.message && insertErr.message.includes('UNIQUE constraint failed')) {
          const conflicting = checkExistingSourceStmt.get(
            app.id,
            assoc.installation_id,
            assoc.repository_id,
            target.ref,
            target.commit_sha
          );
          insertOutcomeStmt.run({
            delivery_id: target.delivery_id,
            application_id: target.application_id,
            deployment_id: conflicting?.id || null,
            outcome: 'deduplicated',
            reason_code: 'ALREADY_QUEUED'
          });
          deduplicatedCount++;
          continue;
        }
        throw insertErr;
      }

      insertOutcomeStmt.run({
        delivery_id: target.delivery_id,
        application_id: target.application_id,
        deployment_id: deploymentId,
        outcome: 'enqueued',
        reason_code: null
      });

      enqueuedCount++;
      enqueuedJobs.push({
        id: deploymentId,
        applicationId: app.id,
        applicationName: app.name,
        applicationSlug: app.slug,
        commitSha: target.commit_sha,
        ref: target.ref,
        branch: targetBranch,
        status: 'queued',
        deliveryId: target.delivery_id,
        logPath: deploymentLogPath
      });
    }
  });

  try {
    processBatchTx();
  } catch (err) {
    throw new DeploymentQueueError(`Failed to process deployment queue transaction: ${err.message}`, 'QUEUE_DATABASE_ERROR');
  }

  return {
    processedCount: pendingTargets.length,
    enqueuedCount,
    deduplicatedCount,
    skippedCount,
    enqueuedJobs
  };
}

/**
 * Retrieves deterministic, bounded listing of active queued deployment jobs.
 *
 * @param {Object} options - Pagination options
 * @returns {Array<Object>} List of queued deployments
 */
function getQueuedDeployments(options = {}) {
  const db = options.db || getDatabase(options);
  const limit = Math.min(100, Math.max(1, parseInt(options.limit, 10) || 50));

  const rows = db.prepare(`
    SELECT
      d.id,
      d.application_id,
      d.commit_sha,
      d.trigger_source,
      d.status,
      d.log_path,
      d.created_at,
      s.delivery_id,
      s.installation_id,
      s.repository_id,
      s.repository_full_name,
      s.ref,
      a.name as application_name,
      a.slug as application_slug
    FROM deployments d
    JOIN github_webhook_deployment_sources s ON d.id = s.deployment_id
    JOIN applications a ON d.application_id = a.id
    WHERE d.status = 'queued'
    ORDER BY d.created_at ASC, d.id ASC
    LIMIT ?
  `).all(limit);

  return rows.map((r) => ({
    id: r.id,
    applicationId: r.application_id,
    applicationName: r.application_name,
    applicationSlug: r.application_slug,
    commitSha: r.commit_sha,
    triggerSource: r.trigger_source,
    status: r.status,
    logPath: r.log_path,
    createdAt: r.created_at,
    deliveryId: r.delivery_id,
    installationId: r.installation_id,
    repositoryId: r.repository_id,
    repositoryFullName: r.repository_full_name,
    ref: r.ref
  }));
}

/**
 * Retrieves deployment details by UUID.
 *
 * @param {string} id - Deployment UUID
 * @param {Object} options - Database options
 * @returns {Object|null} Deployment record or null
 */
function getDeploymentById(id, options = {}) {
  if (!id || typeof id !== 'string') return null;

  const db = options.db || getDatabase(options);

  const row = db.prepare(`
    SELECT
      d.id,
      d.application_id,
      d.commit_sha,
      d.trigger_source,
      d.status,
      d.failure_reason,
      d.log_path,
      d.started_at,
      d.finished_at,
      d.created_at,
      s.delivery_id,
      s.installation_id,
      s.repository_id,
      s.repository_full_name,
      s.ref,
      a.name as application_name,
      a.slug as application_slug
    FROM deployments d
    LEFT JOIN github_webhook_deployment_sources s ON d.id = s.deployment_id
    LEFT JOIN applications a ON d.application_id = a.id
    WHERE d.id = ?
  `).get(id.trim());

  if (!row) return null;

  return {
    id: row.id,
    applicationId: row.application_id,
    applicationName: row.application_name || 'unknown',
    applicationSlug: row.application_slug || 'unknown',
    commitSha: row.commit_sha,
    triggerSource: row.trigger_source,
    status: row.status,
    failureReason: row.failure_reason,
    logPath: row.log_path,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
    deliveryId: row.delivery_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repositoryFullName: row.repository_full_name,
    ref: row.ref
  };
}

/**
 * Returns processing outcome metadata for a persisted webhook delivery target.
 *
 * @param {string} deliveryId - Delivery UUID
 * @param {string} applicationId - Application UUID
 * @param {Object} options - Database options
 * @returns {Object} Outcome metadata or { outcome: 'pending' }
 */
function getWebhookTargetOutcome(deliveryId, applicationId, options = {}) {
  if (!deliveryId || !applicationId) return null;

  const db = options.db || getDatabase(options);

  const row = db.prepare(`
    SELECT delivery_id, application_id, deployment_id, outcome, reason_code, created_at
    FROM github_webhook_target_outcomes
    WHERE delivery_id = ? AND application_id = ?
  `).get(deliveryId.trim(), applicationId.trim());

  if (row) {
    return {
      deliveryId: row.delivery_id,
      applicationId: row.application_id,
      deploymentId: row.deployment_id,
      outcome: row.outcome,
      reasonCode: row.reason_code,
      createdAt: row.created_at
    };
  }

  // Check if target exists in targets inbox but is not yet processed
  const targetExists = db.prepare(`
    SELECT 1 FROM github_webhook_targets
    WHERE delivery_id = ? AND application_id = ?
  `).get(deliveryId.trim(), applicationId.trim());

  if (targetExists) {
    return {
      deliveryId,
      applicationId,
      deploymentId: null,
      outcome: 'pending',
      reasonCode: null,
      createdAt: null
    };
  }

  return null;
}

module.exports = {
  enqueueWebhookTargets,
  getQueuedDeployments,
  getDeploymentById,
  getWebhookTargetOutcome,
  DeploymentQueueError
};
