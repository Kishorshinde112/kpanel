/**
 * Migration 006: Durable Build Artifacts
 * Stores immutable Docker BuildKit image build metadata, tags, image digests,
 * and execution durations associated with deployments.
 */

module.exports = {
  version: 6,
  name: '006_build_artifacts',

  up(db) {
    // 1. Dedicated Durable Build Artifacts Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS deployment_build_artifacts (
        deployment_id TEXT PRIMARY KEY,
        application_id TEXT NOT NULL,
        commit_sha TEXT NOT NULL,
        image_tag TEXT NOT NULL,
        image_id TEXT NOT NULL,
        build_duration_ms INTEGER NOT NULL,
        log_path TEXT NOT NULL,
        platform TEXT NOT NULL DEFAULT 'linux/arm64',
        build_type TEXT NOT NULL DEFAULT 'dockerfile',
        build_path TEXT NOT NULL DEFAULT '.',
        dockerfile_path TEXT NOT NULL DEFAULT 'Dockerfile',
        built_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE CASCADE,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT
      );
    `);

    // 2. Indexes for artifact lookups by application, image tag, and commit
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_build_artifacts_app_id ON deployment_build_artifacts(application_id);
      CREATE INDEX IF NOT EXISTS idx_build_artifacts_image_tag ON deployment_build_artifacts(image_tag);
      CREATE INDEX IF NOT EXISTS idx_build_artifacts_commit_sha ON deployment_build_artifacts(commit_sha);
    `);

    // 3. Additive columns on deployments table
    const deploymentColumns = db.prepare("PRAGMA table_info(deployments)").all().map((c) => c.name);

    if (!deploymentColumns.includes('image_tag')) {
      db.exec("ALTER TABLE deployments ADD COLUMN image_tag TEXT;");
    }
    if (!deploymentColumns.includes('image_id')) {
      db.exec("ALTER TABLE deployments ADD COLUMN image_id TEXT;");
    }
    if (!deploymentColumns.includes('build_duration_ms')) {
      db.exec("ALTER TABLE deployments ADD COLUMN build_duration_ms INTEGER;");
    }
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_build_artifacts_commit_sha;
      DROP INDEX IF EXISTS idx_build_artifacts_image_tag;
      DROP INDEX IF EXISTS idx_build_artifacts_app_id;
      DROP TABLE IF EXISTS deployment_build_artifacts;
    `);
  }
};
