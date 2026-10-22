/**
 * Migration 009: Release Activation Intents
 * Tracks durable pre-activation intents between validated release plans
 * and future traffic activation, recording compare-and-swap fingerprints and rollback targets.
 */

module.exports = {
  version: 9,
  name: '009_release_activation_intents',

  up(db) {
    // 1. Dedicated Release Activation Intents Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_release_activation_intents (
        activation_id TEXT PRIMARY KEY,
        release_plan_id TEXT NOT NULL,
        application_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL UNIQUE,
        candidate_container_id TEXT NOT NULL,
        expected_image_id TEXT NOT NULL,
        target_domain TEXT NOT NULL,
        target_port INTEGER NOT NULL,
        previous_release_id TEXT,
        previous_route_fingerprint TEXT,
        proposed_route_fingerprint TEXT,
        topology_snapshot_fingerprint TEXT,
        activation_status TEXT NOT NULL DEFAULT 'draft',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        blocked_reason TEXT,
        FOREIGN KEY (release_plan_id) REFERENCES deployment_release_plans(id) ON DELETE RESTRICT,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE RESTRICT
      );
    `);

    // 2. Performance and uniqueness indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_activation_intents_app_id ON deployment_release_activation_intents(application_id);
      CREATE INDEX IF NOT EXISTS idx_activation_intents_plan_id ON deployment_release_activation_intents(release_plan_id);
      CREATE INDEX IF NOT EXISTS idx_activation_intents_deployment_id ON deployment_release_activation_intents(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_activation_intents_status ON deployment_release_activation_intents(activation_status);
      CREATE INDEX IF NOT EXISTS idx_activation_intents_domain ON deployment_release_activation_intents(target_domain);
      CREATE INDEX IF NOT EXISTS idx_activation_intents_app_status ON deployment_release_activation_intents(application_id, activation_status);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_activation_intents_app_status;
      DROP INDEX IF EXISTS idx_activation_intents_domain;
      DROP INDEX IF EXISTS idx_activation_intents_status;
      DROP INDEX IF EXISTS idx_activation_intents_deployment_id;
      DROP INDEX IF EXISTS idx_activation_intents_plan_id;
      DROP INDEX IF EXISTS idx_activation_intents_app_id;
      DROP TABLE IF EXISTS deployment_release_activation_intents;
    `);
  }
};
