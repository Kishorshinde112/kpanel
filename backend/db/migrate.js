const fs = require('fs');
const path = require('path');
const { getDatabase } = require('../config/database');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

/**
 * Ensures the schema_migrations tracking table exists.
 */
function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
}

/**
 * Retrieves list of all migration objects from the migrations directory.
 * Sorted sequentially by version ascending.
 */
function loadMigrations(migrationsDir = MIGRATIONS_DIR) {
  if (!fs.existsSync(migrationsDir)) {
    return [];
  }

  const files = fs.readdirSync(migrationsDir).filter((file) => file.endsWith('.js'));
  const migrations = [];

  for (const file of files) {
    const fullPath = path.join(migrationsDir, file);
    try {
      const migration = require(fullPath);
      if (typeof migration.version !== 'number' || !migration.name || typeof migration.up !== 'function') {
        throw new Error(`Invalid migration structure in "${file}": version, name, and up() are required.`);
      }
      migrations.push(migration);
    } catch (err) {
      throw new Error(`Failed to load migration file "${file}": ${err.message}`);
    }
  }

  return migrations.sort((a, b) => a.version - b.version);
}

/**
 * Returns array of already applied migration version numbers from the database.
 */
function getAppliedMigrations(db) {
  ensureMigrationTable(db);
  const rows = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version ASC').all();
  return rows;
}

/**
 * Returns the highest applied migration version number, or 0 if none applied.
 */
function getCurrentVersion(db) {
  ensureMigrationTable(db);
  const row = db.prepare('SELECT MAX(version) as max_version FROM schema_migrations').get();
  return row?.max_version || 0;
}

/**
 * Executes pending migrations sequentially inside atomic transactions.
 * Idempotent: repeated runs execute only unapplied migrations.
 */
function runMigrations(db, customMigrations = null) {
  ensureMigrationTable(db);

  const migrations = customMigrations || loadMigrations();
  const appliedRows = getAppliedMigrations(db);
  const appliedVersions = new Set(appliedRows.map((r) => r.version));

  const pending = migrations.filter((m) => !appliedVersions.has(m.version));
  let appliedCount = 0;

  for (const migration of pending) {
    // Atomic execution per migration
    const executeMigrationTx = db.transaction((m) => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)').run(m.version, m.name);
    });

    try {
      executeMigrationTx(migration);
      appliedCount++;
    } catch (err) {
      throw new Error(`Migration ${migration.version} (${migration.name}) failed and was rolled back: ${err.message}`);
    }
  }

  return {
    applied: appliedCount,
    currentVersion: getCurrentVersion(db),
    totalMigrations: migrations.length
  };
}

// Allow direct execution via CLI: node backend/db/migrate.js
if (require.main === module) {
  try {
    const db = getDatabase();
    console.log(`[DB] Running migrations against: ${db.name}`);
    const result = runMigrations(db);
    console.log(`[DB] Successfully applied ${result.applied} migrations. Current schema version: ${result.currentVersion}`);
  } catch (err) {
    console.error(`[DB ERROR] Migration runner failed: ${err.message}`);
    process.exit(1);
  }
}

module.exports = {
  runMigrations,
  getAppliedMigrations,
  getCurrentVersion,
  loadMigrations,
  ensureMigrationTable
};
