/**
 * Migration 002: GitHub App Installations & Application Repository Associations
 * Enables trusted, verified linkage between K-Panel applications and authorized GitHub repositories.
 */

module.exports = {
  version: 2,
  name: '002_github_integrations',

  up(db) {
    // 1. GitHub App Installations Table
    db.exec(`
      CREATE TABLE IF NOT EXISTS github_installations (
        installation_id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        account_login TEXT NOT NULL,
        account_type TEXT NOT NULL DEFAULT 'User',
        repository_selection TEXT NOT NULL DEFAULT 'selected',
        installation_status TEXT NOT NULL DEFAULT 'active',
        last_verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 2. Application Repository Associations Table (1 active association per application)
    db.exec(`
      CREATE TABLE IF NOT EXISTS application_repositories (
        application_id TEXT PRIMARY KEY,
        installation_id TEXT NOT NULL,
        repository_id TEXT NOT NULL,
        repository_owner TEXT NOT NULL,
        repository_name TEXT NOT NULL,
        repository_full_name TEXT NOT NULL,
        repository_private INTEGER NOT NULL DEFAULT 1,
        association_status TEXT NOT NULL DEFAULT 'verified',
        verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE RESTRICT,
        FOREIGN KEY (installation_id) REFERENCES github_installations(installation_id) ON DELETE RESTRICT
      );
    `);

    // 3. Look-up & Relational Indexes
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_github_installations_account ON github_installations(account_login);
      CREATE INDEX IF NOT EXISTS idx_app_repos_installation_id ON application_repositories(installation_id);
      CREATE INDEX IF NOT EXISTS idx_app_repos_repository_id ON application_repositories(repository_id);
    `);
  },

  down(db) {
    db.exec(`
      DROP INDEX IF EXISTS idx_app_repos_repository_id;
      DROP INDEX IF EXISTS idx_app_repos_installation_id;
      DROP INDEX IF EXISTS idx_github_installations_account;
      DROP TABLE IF EXISTS application_repositories;
      DROP TABLE IF EXISTS github_installations;
    `);
  }
};
