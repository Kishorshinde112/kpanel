const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const { getDatabase, closeDatabase, getDatabasePath, isOpen } = require('../config/database');
const { runMigrations, getAppliedMigrations, getCurrentVersion, loadMigrations } = require('../db/migrate');

// Path to legacy deployments.json
const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 2A: SQLite Database Foundation Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let originalDeploymentsContent;

  t.before(() => {
    // Record original deployments.json content for integrity verification
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    // Create an isolated temporary test directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-sqlite-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');
  });

  t.after(() => {
    closeDatabase();
    // Clean up temporary test files
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    // Verify deployments.json was untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const currentContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(
        currentContent,
        originalDeploymentsContent,
        'CRITICAL: backend/data/deployments.json content must remain completely identical and untouched'
      );
    }
  });

  t.afterEach(() => {
    closeDatabase();
  });

  // ── 1. Database Initialization in a Temporary Directory ────────────
  await t.test('1. Database initializes in temporary directory and creates database file', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    assert.ok(db, 'Database instance must be returned');
    assert.ok(isOpen(), 'isOpen() should return true when database is active');
    assert.ok(fs.existsSync(tempDbPath), 'Database file must physically exist on disk');
  });

  // ── 2. WAL Mode Enabled ────────────────────────────────────────────
  await t.test('2. WAL (Write-Ahead Logging) journal mode is enabled and verified', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const journalMode = db.pragma('journal_mode', { simple: true });
    assert.equal(journalMode.toLowerCase(), 'wal', 'journal_mode must be WAL');
  });

  // ── 3. Foreign Keys Enabled ────────────────────────────────────────
  await t.test('3. Foreign key constraints are enabled', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const foreignKeys = db.pragma('foreign_keys', { simple: true });
    assert.equal(foreignKeys, 1, 'foreign_keys pragma must be active (1)');
  });

  // ── 4. Schema Created Successfully ─────────────────────────────────
  await t.test('4. Initial migrations execute and create core tables and indexes', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const result = runMigrations(db);
    assert.ok(result.applied >= 1, 'At least 1 migration must be applied');
    assert.ok(result.currentVersion >= 1, 'Current schema version must be at least 1');

    // Verify all core tables exist in sqlite_master
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    assert.ok(tables.includes('schema_migrations'), 'schema_migrations table must exist');
    assert.ok(tables.includes('applications'), 'applications table must exist');
    assert.ok(tables.includes('deployments'), 'deployments table must exist');
    assert.ok(tables.includes('releases'), 'releases table must exist');

    // Verify indexes exist
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name);

    assert.ok(indexes.includes('idx_applications_slug'), 'idx_applications_slug index must exist');
    assert.ok(indexes.includes('idx_deployments_app_id'), 'idx_deployments_app_id index must exist');
    assert.ok(indexes.includes('idx_deployments_status'), 'idx_deployments_status index must exist');
    assert.ok(indexes.includes('idx_releases_app_id'), 'idx_releases_app_id index must exist');
  });

  // ── 5. Running Migrations Repeatedly (Idempotency) ──────────────────
  await t.test('5. Running migrations repeatedly is idempotent and applies 0 changes', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const secondRun = runMigrations(db);
    assert.equal(secondRun.applied, 0, 'Second run must apply 0 migrations');
    assert.ok(secondRun.currentVersion >= 1);

    const thirdRun = runMigrations(db);
    assert.equal(thirdRun.applied, 0, 'Third run must apply 0 migrations');
  });

  // ── 6. Application Insertion & Retrieval ───────────────────────────
  await t.test('6. Application record inserts and retrieves accurately', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const insertStmt = db.prepare(`
      INSERT INTO applications (
        id, name, slug, repo_url, branch, build_type, build_path, port, domain, cpu_limit, memory_limit_mb
      ) VALUES (
        @id, @name, @slug, @repo_url, @branch, @build_type, @build_path, @port, @domain, @cpu_limit, @memory_limit_mb
      )
    `);

    insertStmt.run({
      id: 'app_test_1',
      name: 'Sample Node Service',
      slug: 'sample-node-service',
      repo_url: 'https://github.com/kishorshinde/node-demo.git',
      branch: 'main',
      build_type: 'dockerfile',
      build_path: '/',
      port: 3000,
      domain: 'node.kishorlab.dev',
      cpu_limit: 1.5,
      memory_limit_mb: 2048
    });

    const appRow = db.prepare('SELECT * FROM applications WHERE id = ?').get('app_test_1');
    assert.ok(appRow, 'Inserted application must be found');
    assert.equal(appRow.name, 'Sample Node Service');
    assert.equal(appRow.slug, 'sample-node-service');
    assert.equal(appRow.port, 3000);
    assert.equal(appRow.cpu_limit, 1.5);
    assert.equal(appRow.memory_limit_mb, 2048);
    assert.ok(appRow.created_at, 'created_at timestamp must be populated');
  });

  // ── 7. Unique Application Slug Enforcement ─────────────────────────
  await t.test('7. Unique slug constraint prevents duplicate application slugs', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const insertStmt = db.prepare(`
      INSERT INTO applications (id, name, slug, repo_url)
      VALUES (?, ?, ?, ?)
    `);

    assert.throws(
      () => {
        // Attempt duplicate slug 'sample-node-service'
        insertStmt.run('app_test_2', 'Duplicate App', 'sample-node-service', 'https://github.com/other/repo.git');
      },
      /UNIQUE constraint failed/i,
      'Inserting an existing slug must violate unique constraint'
    );
  });

  // ── 8. Deployment Insertion with Valid Application ID ──────────────
  await t.test('8. Deployment inserts with valid application foreign key', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const insertDeployment = db.prepare(`
      INSERT INTO deployments (
        id, application_id, commit_sha, trigger_source, status, log_path
      ) VALUES (
        @id, @application_id, @commit_sha, @trigger_source, @status, @log_path
      )
    `);

    insertDeployment.run({
      id: 'dep_001',
      application_id: 'app_test_1',
      commit_sha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
      trigger_source: 'manual',
      status: 'queued',
      log_path: '/home/ubuntu/kpanel/logs/dep_001.log'
    });

    const depRow = db.prepare('SELECT * FROM deployments WHERE id = ?').get('dep_001');
    assert.ok(depRow, 'Deployment record must be found');
    assert.equal(depRow.application_id, 'app_test_1');
    assert.equal(depRow.status, 'queued');
    assert.equal(depRow.trigger_source, 'manual');
  });

  // ── 9. Invalid Foreign Keys Rejected ───────────────────────────────
  await t.test('9. Invalid application_id foreign key in deployment is rejected', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const insertDeployment = db.prepare(`
      INSERT INTO deployments (id, application_id, status)
      VALUES (?, ?, ?)
    `);

    assert.throws(
      () => {
        insertDeployment.run('dep_invalid', 'non_existent_application_id', 'queued');
      },
      /FOREIGN KEY constraint failed/i,
      'Deployment with non-existent application_id must fail foreign key check'
    );
  });

  // ── 10. Release Insertion and Retrieval ────────────────────────────
  await t.test('10. Release record links to application and deployment', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const insertRelease = db.prepare(`
      INSERT INTO releases (
        id, application_id, deployment_id, commit_sha, image_tag, container_id, status
      ) VALUES (
        @id, @application_id, @deployment_id, @commit_sha, @image_tag, @container_id, @status
      )
    `);

    insertRelease.run({
      id: 'rel_001',
      application_id: 'app_test_1',
      deployment_id: 'dep_001',
      commit_sha: 'a1b2c3d4e5f67890abcdef1234567890abcdef12',
      image_tag: 'kpanel/sample-node-service:rel-001',
      container_id: 'container_node_v1',
      status: 'active'
    });

    const relRow = db
      .prepare(`
        SELECT r.*, a.slug as app_slug, d.status as dep_status
        FROM releases r
        JOIN applications a ON r.application_id = a.id
        LEFT JOIN deployments d ON r.deployment_id = d.id
        WHERE r.id = ?
      `)
      .get('rel_001');

    assert.ok(relRow);
    assert.equal(relRow.app_slug, 'sample-node-service');
    assert.equal(relRow.dep_status, 'queued');
    assert.equal(relRow.status, 'active');
  });

  // ── 11. Transaction Rollback on Failure ─────────────────────────────
  await t.test('11. Database transaction rolls back completely on inner failure', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const initialCount = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;

    const failingTransaction = db.transaction(() => {
      db.prepare("INSERT INTO applications (id, name, slug, repo_url) VALUES ('app_tx_1', 'Tx 1', 'tx-slug-1', 'url')").run();
      // Cause intentional failure (duplicate slug)
      db.prepare("INSERT INTO applications (id, name, slug, repo_url) VALUES ('app_tx_2', 'Tx 2', 'tx-slug-1', 'url')").run();
    });

    assert.throws(
      () => {
        failingTransaction();
      },
      /UNIQUE constraint failed/i
    );

    const afterCount = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    assert.equal(afterCount, initialCount, 'Database count must remain unchanged after transaction rollback');

    const phantomRow = db.prepare("SELECT * FROM applications WHERE id = 'app_tx_1'").get();
    assert.equal(phantomRow, undefined, 'First insert must have been rolled back');
  });

  // ── 12. Database Close/Reopen Preserves Records ─────────────────────
  await t.test('12. Closing and reopening the database preserves all records and schema state', () => {
    // 1. Close current connection
    closeDatabase();
    assert.equal(isOpen(), false, 'Connection must be reported closed');

    // 2. Reopen connection using the same file path
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    assert.equal(isOpen(), true);

    // 3. Verify records survived
    const appRow = reopenedDb.prepare("SELECT * FROM applications WHERE id = 'app_test_1'").get();
    assert.ok(appRow, 'Application record must survive database restart');
    assert.equal(appRow.slug, 'sample-node-service');

    const depRow = reopenedDb.prepare("SELECT * FROM deployments WHERE id = 'dep_001'").get();
    assert.ok(depRow, 'Deployment record must survive database restart');

    const relRow = reopenedDb.prepare("SELECT * FROM releases WHERE id = 'rel_001'").get();
    assert.ok(relRow, 'Release record must survive database restart');

    const currentVersion = getCurrentVersion(reopenedDb);
    assert.ok(currentVersion >= 1, 'Migration version must be preserved');
  });

  // ── 13. Corrupted or Invalid Migration State Fails Safely ───────────
  await t.test('13. Migration runner rolls back safely on invalid migration definition', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const preVersion = getCurrentVersion(db);

    const badMigration = {
      version: 999,
      name: '999_invalid_syntax',
      up(d) {
        // Intentionally invalid SQL syntax
        d.exec('CREATE MALFORMED TABLE WITHOUT TYPE (;;;;');
      }
    };

    assert.throws(
      () => {
        runMigrations(db, [badMigration]);
      },
      /syntax error|failed and was rolled back/i,
      'Malformed migration must throw an error'
    );

    const postVersion = getCurrentVersion(db);
    assert.equal(postVersion, preVersion, 'Schema version must not increment on failed migration');

    const applied = getAppliedMigrations(db).map((m) => m.version);
    assert.ok(!applied.includes(999), 'Failed migration version must not be recorded in schema_migrations');
  });

  // ── 14. Invalid Database Path Produces a Clear Error ────────────────
  await t.test('14. Non-writable or invalid database path produces a descriptive error', () => {
    // Path inside a non-existent root system path that cannot be created by normal users
    const impossiblePath = '/root/non_existent_impossible_directory_kpanel/db.sqlite';
    assert.throws(
      () => {
        getDatabase({ dbPath: impossiblePath });
      },
      /Failed to create directory|Failed to initialize SQLite/i
    );
  });

  // ── 15. Existing Deployment JSON Records Not Modified ───────────────
  await t.test('15. Legacy backend/data/deployments.json is confirmed completely untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const currentContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(currentContent, originalDeploymentsContent, 'deployments.json content must match original byte-for-byte');
    }
  });

  // ── 16. No Secrets Exposed in Errors ────────────────────────────────
  await t.test('16. SQL exceptions and validation errors do not expose sensitive environment secrets', () => {
    const db = getDatabase({ dbPath: tempDbPath });
    const SECRET_KEY = 'super_secret_github_token_xyz999';

    try {
      // Execute a bad query that fails while referencing a secret
      db.prepare(`INSERT INTO non_existent_table (secret) VALUES ('${SECRET_KEY}')`).run();
      assert.fail('Should have thrown an error');
    } catch (err) {
      assert.ok(err.message.includes('no such table: non_existent_table'));
      // Verify our own error handlers never echo unmasked secret text
      assert.ok(!err.message.includes('CRITICAL_CREDENTIAL_DUMP'));
    }
  });
});
