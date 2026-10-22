/**
 * Migration 003: GitHub Webhook Deliveries & Target Inbox
 * Durable, deduplicated storage for incoming GitHub webhook events.
 */

module.exports = {
  version: 3,
  name: '003_github_webhook_inbox',

  up(db) {
    // 1. Webhook Deliveries Ledger Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_webhook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        event_name TEXT NOT NULL,
        payload_sha256 TEXT NOT NULL,
        installation_id TEXT,
        repository_id TEXT,
        ref TEXT,
        commit_sha TEXT,
        decision TEXT NOT NULL,
        received_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Webhook Target Applications Table (Composite PK prevents duplicate target records)
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_webhook_targets (
        delivery_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        ref TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (delivery_id, application_id),
        FOREIGN KEY (delivery_id) REFERENCES github_webhook_deliveries(delivery_id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT
      );
    `);

    // 3. Performance & Look-up Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received_at ON github_webhook_deliveries(received_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_repo_id ON github_webhook_deliveries(repository_id);
      CREATE INDEX IF NOT EXISTS idx_webhook_targets_app_id ON github_webhook_targets(application_id);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_webhook_targets_app_id;
      DROP INDEX IF EXISTS idx_webhook_deliveries_repo_id;
      DROP INDEX IF EXISTS idx_webhook_deliveries_received_at;
      DROP TABLE IF EXISTS github_webhook_targets;
      DROP TABLE IF EXISTS github_webhook_deliveries;
    `);
  }
};
