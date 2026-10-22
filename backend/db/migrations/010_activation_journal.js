/**
 * Migration 010: Durable Route Activation Journal
 * Tracks atomic write-ahead transition states, expected vs proposed route fingerprints,
 * and durable rollback documents for guarded Traefik route execution.
 */

module.exports = {
  version: 10,
  name: '010_activation_journal',

  up(db) {
    // 1. Dedicated Route Activation Journal Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_route_activation_journal (
        journal_id TEXT PRIMARY KEY,
        activation_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL,
        target_domain TEXT NOT NULL,
        expected_previous_fingerprint TEXT,
        proposed_fingerprint TEXT NOT NULL,
        previous_route_document TEXT,
        proposed_route_document TEXT NOT NULL,
        journal_state TEXT NOT NULL CHECK(journal_state IN (
          'prepared',
          'applying',
          'applied_unverified',
          'verified',
          'rollback_pending',
          'rolling_back',
          'rolled_back',
          'blocked',
          'recovery_required'
        )),
        operation_owner TEXT NOT NULL,
        fencing_token INTEGER NOT NULL,
        operation_started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        route_applied_at DATETIME,
        verification_completed_at DATETIME,
        rollback_started_at DATETIME,
        rollback_completed_at DATETIME,
        error_code TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE RESTRICT,
        FOREIGN KEY (activation_id) REFERENCES deployment_release_activation_intents(activation_id) ON DELETE RESTRICT
      );
    `);

    // 2. Performance & Query Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activation_journal_app_id ON deployment_route_activation_journal(application_id);
      CREATE INDEX IF NOT EXISTS idx_activation_journal_deployment_id ON deployment_route_activation_journal(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_activation_journal_state ON deployment_route_activation_journal(journal_state);
      CREATE INDEX IF NOT EXISTS idx_activation_journal_activation_id ON deployment_route_activation_journal(activation_id);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_activation_journal_activation_id;
      DROP INDEX IF EXISTS idx_activation_journal_state;
      DROP INDEX IF EXISTS idx_activation_journal_deployment_id;
      DROP INDEX IF EXISTS idx_activation_journal_app_id;
      DROP TABLE IF EXISTS deployment_route_activation_journal;
    `);
  }
};
