const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'kpanel.db');

let activeDb = null;
let activeDbPath = null;

/**
 * Resolves the database path using custom parameter, KPANEL_DB_PATH env var, or the default persistent location.
 */
function getDatabasePath(customPath) {
  if (customPath && typeof customPath === 'string' && customPath.trim().length > 0) {
    return path.resolve(customPath.trim());
  }
  if (process.env.KPANEL_DB_PATH && process.env.KPANEL_DB_PATH.trim().length > 0) {
    return path.resolve(process.env.KPANEL_DB_PATH.trim());
  }
  return DEFAULT_DB_PATH;
}

/**
 * Initializes and returns a SQLite database connection with WAL mode, foreign keys, and busy timeout.
 * Connections are managed lazily without global connection side-effects on require.
 */
function getDatabase(options = {}) {
  const targetPath = getDatabasePath(options.dbPath);

  // Return existing active connection if path matches and it remains open
  if (activeDb && activeDbPath === targetPath && activeDb.open) {
    return activeDb;
  }

  // Close previous connection if path changed or state was closed
  if (activeDb && activeDb.open) {
    try { activeDb.close(); } catch {}
    activeDb = null;
    activeDbPath = null;
  }

  // Ensure target directory exists
  try {
    const dir = path.dirname(targetPath);
    fs.mkdirSync(dir, { recursive: true });
  } catch (err) {
    throw new Error(`Failed to create directory for database at "${targetPath}": ${err.message}`);
  }

  try {
    const db = new Database(targetPath, {
      timeout: options.timeout || 5000,
      fileMustExist: options.fileMustExist || false,
      verbose: options.verbose ? console.log : null
    });

    // Enforce essential operational pragmas
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');

    activeDb = db;
    activeDbPath = targetPath;
    return db;
  } catch (err) {
    throw new Error(`Failed to initialize SQLite database at "${targetPath}": ${err.message}`);
  }
}

/**
 * Closes the active database connection safely and resets internal references.
 */
function closeDatabase() {
  if (activeDb) {
    try {
      if (activeDb.open) {
        activeDb.close();
      }
    } finally {
      activeDb = null;
      activeDbPath = null;
    }
  }
}

/**
 * Returns true if an active database connection is currently open.
 */
function isOpen() {
  return Boolean(activeDb && activeDb.open);
}

module.exports = {
  getDatabase,
  closeDatabase,
  getDatabasePath,
  isOpen,
  DEFAULT_DB_PATH
};
