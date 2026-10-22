/**
 * Migration 005: Singleton Deployment Worker Leases & Idempotency Hardening
 * Introduces global worker lease coordination table, claim metadata on deployments,
 * and database-enforced webhook deduplication uniqueness index.
 */

module.exports = {
  version: 5,
  name: '005_worker_leases',

  up(db) {
    // 1. Singleton Deployment Worker Lock Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_worker_lock (
        lock_name TEXT PRIMARY KEY,
        owner_id TEXT NOT NULL,
        fencing_token INTEGER NOT NULL DEFAULT 1,
        lease_expires_at DATETIME NOT NULL,
        heartbeat_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Add Worker Claim Columns to deployments table (if not already present)
    const deploymentColumns = db.prepare("PRAGMA table_info(deployments)").all().map((c) => c.name);

    if (!deploymentColumns.includes('lease_owner')) {
      db.exec("ALTER TABLE deployments ADD COLUMN lease_owner TEXT;");
    }
    if (!deploymentColumns.includes('lease_token')) {
      db.exec("ALTER TABLE deployments ADD COLUMN lease_token INTEGER;");
    }
    if (!deploymentColumns.includes('lease_expires_at')) {
      db.exec("ALTER TABLE deployments ADD COLUMN lease_expires_at DATETIME;");
    }
    if (!deploymentColumns.includes('claim_attempts')) {
      db.exec("ALTER TABLE deployments ADD COLUMN claim_attempts INTEGER NOT NULL DEFAULT 0;");
    }
    if (!deploymentColumns.includes('claimed_at')) {
      db.exec("ALTER TABLE deployments ADD COLUMN claimed_at DATETIME;");
    }
    if (!deploymentColumns.includes('last_heartbeat_at')) {
      db.exec("ALTER TABLE deployments ADD COLUMN last_heartbeat_at DATETIME;");
    }

    // 3. Database-Enforced Webhook Idempotency Uniqueness Index across all job states
    // Prevents redundant deployments for the exact same commit and ref across queued, building, verifying, success, failed, and cancelled states
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_webhook_sources_idempotency
      ON github_webhook_deployment_sources(application_id, installation_id, repository_id, ref, commit_sha);
    `);

    // 4. Index for worker claim queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_deployments_claim_lookup
      ON deployments(status, lease_expires_at, claim_attempts);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_deployments_claim_lookup;
      DROP INDEX IF EXISTS idx_webhook_sources_idempotency;
      DROP TABLE IF EXISTS deployment_worker_lock;
    `);
  }
};
