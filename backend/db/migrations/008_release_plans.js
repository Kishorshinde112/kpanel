/**
 * Migration 008: Release Planning & Routing Preparation
 * Introduces durable release plans between healthy runtime candidates
 * and future production traffic activation.
 */

module.exports = {
  version: 8,
  name: '008_release_plans',

  up(db) {
    // 1. Release Plans Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_release_plans (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        deployment_id TEXT NOT NULL UNIQUE,
        candidate_container_id TEXT NOT NULL,
        image_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        target_domain TEXT,
        target_port INTEGER NOT NULL,
        route_provider TEXT NOT NULL DEFAULT 'traefik',
        plan_status TEXT NOT NULL DEFAULT 'draft',
        readiness_checked_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        invalidated_reason TEXT,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE RESTRICT
      );
    `);

    // 2. Indexes for application lookups, domain collision checks, and plan status queries
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_release_plans_app_id ON deployment_release_plans(application_id);
      CREATE INDEX IF NOT EXISTS idx_release_plans_deployment_id ON deployment_release_plans(deployment_id);
      CREATE INDEX IF NOT EXISTS idx_release_plans_status ON deployment_release_plans(plan_status);
      CREATE INDEX IF NOT EXISTS idx_release_plans_target_domain ON deployment_release_plans(target_domain);
      CREATE INDEX IF NOT EXISTS idx_release_plans_app_status ON deployment_release_plans(application_id, plan_status);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_release_plans_app_status;
      DROP INDEX IF EXISTS idx_release_plans_target_domain;
      DROP INDEX IF EXISTS idx_release_plans_status;
      DROP INDEX IF EXISTS idx_release_plans_deployment_id;
      DROP INDEX IF EXISTS idx_release_plans_app_id;
      DROP TABLE IF EXISTS deployment_release_plans;
    `);
  }
};
