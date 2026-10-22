/**
 * Migration 007: Isolated Runtime Candidates
 * Tracks isolated candidate containers created from verified built artifacts
 * for staging health verification and readiness testing prior to release promotion.
 */

module.exports = {
  version: 7,
  name: '007_runtime_candidates',

  up(db) {
    // 1. Dedicated Runtime Candidates Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_runtime_candidates (
        deployment_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        container_id TEXT,
        container_name TEXT NOT NULL,
        staging_network_id TEXT NOT NULL,
        candidate_state TEXT NOT NULL DEFAULT 'created',
        health_status TEXT NOT NULL DEFAULT 'unknown',
        health_reason TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        last_checked_at DATETIME,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT
      );
    `);

    // 2. Indexes for candidate lookups by application, container ID, and state
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_runtime_candidates_app_id ON deployment_runtime_candidates(application_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_candidates_container_id ON deployment_runtime_candidates(container_id);
      CREATE INDEX IF NOT EXISTS idx_runtime_candidates_state ON deployment_runtime_candidates(candidate_state);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_runtime_candidates_state;
      DROP INDEX IF EXISTS idx_runtime_candidates_container_id;
      DROP INDEX IF EXISTS idx_runtime_candidates_app_id;
      DROP TABLE IF EXISTS deployment_runtime_candidates;
    `);
  }
};
