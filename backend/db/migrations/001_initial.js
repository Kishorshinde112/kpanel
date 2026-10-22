/**
 * Migration 001: Initial Core Schema
 * Applications, Deployments, and Releases
 */

module.exports = {
  version: 1,
  name: '001_initial',

  up(db) {
    // 1. Applications table
    db.exec(`
      CREATE TABLE IF NOT EXISTS applications (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        slug TEXT NOT NULL UNIQUE,
        repo_url TEXT NOT NULL,
        branch TEXT NOT NULL DEFAULT 'main',
        build_type TEXT NOT NULL DEFAULT 'dockerfile',
        build_path TEXT NOT NULL DEFAULT '/',
        port INTEGER NOT NULL DEFAULT 3000,
        domain TEXT,
        cpu_limit REAL DEFAULT 1.0,
        memory_limit_mb INTEGER DEFAULT 1024,
        active_release_id TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Deployments table (history and execution runs)
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployments (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        commit_sha TEXT,
        trigger_source TEXT NOT NULL DEFAULT 'manual',
        status TEXT NOT NULL DEFAULT 'queued',
        failure_reason TEXT,
        log_path TEXT,
        started_at DATETIME,
        finished_at DATETIME,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT
      );
    `);

    // 3. Releases table (blue-green snapshots and rollback metadata)
    db.exec(`
      CREATE TABLE IF NOT EXISTS releases (
        id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        deployment_id TEXT,
        commit_sha TEXT NOT NULL,
        image_tag TEXT NOT NULL,
        container_id TEXT,
        status TEXT NOT NULL DEFAULT 'inactive',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE SET NULL
      );
    `);

    // 4. Performance & Look-up Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_applications_slug ON applications(slug);
      CREATE INDEX IF NOT EXISTS idx_deployments_app_id ON deployments(application_id);
      CREATE INDEX IF NOT EXISTS idx_deployments_status ON deployments(status);
      CREATE INDEX IF NOT EXISTS idx_releases_app_id ON releases(application_id);
      CREATE INDEX IF NOT EXISTS idx_releases_status ON releases(status);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_releases_status;
      DROP INDEX IF EXISTS idx_releases_app_id;
      DROP INDEX IF EXISTS idx_deployments_status;
      DROP INDEX IF EXISTS idx_deployments_app_id;
      DROP INDEX IF EXISTS idx_applications_slug;
      DROP TABLE IF EXISTS releases;
      DROP TABLE IF EXISTS deployments;
      DROP TABLE IF EXISTS applications;
    `);
  }
};
