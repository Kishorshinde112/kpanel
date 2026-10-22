/**
 * Migration 004: Deployment Queue & Target Processing Outcomes
 * Tracks immutable webhook source metadata, deduplication, and execution outcomes.
 */

module.exports = {
  version: 4,
  name: '004_deployment_queue',

  up(db) {
    // 1. Webhook Deployment Sources Table (Immutable source metadata for future deployment workers)
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_webhook_deployment_sources (
        deployment_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        delivery_id TEXT NOT NULL,
        installation_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        ref TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (delivery_id) REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT
      );
    `);

    // 2. Webhook Target Processing Outcomes Table (Tracks whether each target was enqueued, deduplicated, or skipped)
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_webhook_target_outcomes (
        delivery_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        deployment_id TEXT,
        outcome TEXT NOT NULL,
        reason_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (delivery_id, application_id),
        FOREIGN KEY (delivery_id) REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT
      );
    `);

    // 3. Performance & Deduplication Look-up Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_deployment_sources_app_commit ON github_webhook_deployment_sources(application_id, commit_sha, ref);
      CREATE INDEX IF NOT EXISTS idx_deployment_sources_delivery_id ON github_webhook_deployment_sources(delivery_id);
      CREATE INDEX IF NOT EXISTS idx_target_outcomes_deployment_id ON github_webhook_target_outcomes(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_target_outcomes_outcome ON github_webhook_target_outcomes(outcome);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_target_outcomes_outcome;
      DROP INDEX IF EXISTS idx_target_outcomes_deployment_id;
      DROP INDEX IF EXISTS idx_deployment_sources_delivery_id;
      DROP INDEX IF EXISTS idx_deployment_sources_app_commit;
      DROP TABLE IF EXISTS github_webhook_target_outcomes;
      DROP TABLE IF EXISTS github_webhook_deployment_sources;
    `);
  }
};
