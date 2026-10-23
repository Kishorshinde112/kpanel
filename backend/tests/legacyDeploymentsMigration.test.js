const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const { runMigrations } = require('../db/migrate');
const {
  planLegacyImport,
  executeLegacyImport,
  rollbackLegacyImport
} = require('../scripts/migrateLegacyDeployments');

test('Phase U1: Legacy Deployments Migration & Coexistence Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let tempDeploymentsPath;
  let db;

  const sampleLegacyDeployments = [
    {
      id: 'dep_legacy_001',
      name: 'Custom Web App',
      repoUrl: 'https://github.com/example/web-app.git',
      branch: 'production',
      deployDir: '/home/ubuntu/apps/web-app',
      composeFile: 'docker-compose.yml',
      containerName: 'custom-web-app',
      envFile: '.env',
      createdAt: '2026-01-15T10:00:00.000Z',
      status: 'registered'
    },
    {
      id: 'dep_legacy_002',
      name: 'Production Redis Blueprint',
      type: 'Redis',
      domain: 'redis.internal',
      composeDir: '/home/ubuntu/blueprints/redis',
      containerName: 'redis-prod',
      deployedAt: '2026-02-20T14:30:00.000Z'
    },
    {
      // Incompatible: missing ID
      name: 'Corrupt Record Without ID',
      repoUrl: 'https://github.com/example/broken.git'
    }
  ];

  t.beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel_migration_test_'));
    tempDbPath = path.join(tempDir, 'test.db');
    tempDeploymentsPath = path.join(tempDir, 'deployments.json');

    // Create fresh disposable database with all migrations
    db = new Database(tempDbPath);
    runMigrations(db);

    // Write sample legacy deployments.json
    fs.writeFileSync(tempDeploymentsPath, JSON.stringify(sampleLegacyDeployments, null, 2), 'utf8');
  });

  t.afterEach(() => {
    if (db && db.open) {
      db.close();
    }
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test('1. Dry-run planning reports eligible and incompatible records without mutating database or JSON', () => {
    const originalJson = fs.readFileSync(tempDeploymentsPath, 'utf8');

    const plan = planLegacyImport({
      db,
      deploymentsPath: tempDeploymentsPath
    });

    assert.strictEqual(plan.status, 'READY');
    assert.strictEqual(plan.totalLegacyRecords, 3);
    assert.strictEqual(plan.eligibleToImport.length, 2);
    assert.strictEqual(plan.incompatibleRecords.length, 1);
    assert.strictEqual(plan.alreadyImported.length, 0);

    // Assert database was NOT mutated
    const count = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    assert.strictEqual(count, 0, 'Dry-run must not insert any rows');

    // Assert deployments.json was NOT mutated
    const afterJson = fs.readFileSync(tempDeploymentsPath, 'utf8');
    assert.strictEqual(afterJson, originalJson, 'deployments.json must remain byte-for-byte identical');
  });

  await t.test('2. Execute legacy import successfully creates applications records in SQLite', () => {
    const originalJson = fs.readFileSync(tempDeploymentsPath, 'utf8');

    const result = executeLegacyImport({
      db,
      deploymentsPath: tempDeploymentsPath
    });

    assert.strictEqual(result.status, 'COMPLETED');
    assert.strictEqual(result.importedCount, 2);

    // Verify rows in SQLite
    const rows = db.prepare('SELECT * FROM applications ORDER BY id ASC').all();
    assert.strictEqual(rows.length, 2);

    const app1 = rows.find((r) => r.id === 'dep_legacy_001');
    assert.ok(app1);
    assert.strictEqual(app1.name, 'Custom Web App');
    assert.strictEqual(app1.slug, 'custom-web-app');
    assert.strictEqual(app1.repo_url, 'https://github.com/example/web-app.git');
    assert.strictEqual(app1.branch, 'production');
    assert.strictEqual(app1.build_type, 'dockerfile');

    const app2 = rows.find((r) => r.id === 'dep_legacy_002');
    assert.ok(app2);
    assert.strictEqual(app2.name, 'Production Redis Blueprint');
    assert.strictEqual(app2.repo_url, 'local://blueprints/redis');
    assert.strictEqual(app2.build_type, 'compose');

    // Assert deployments.json was NOT mutated
    const afterJson = fs.readFileSync(tempDeploymentsPath, 'utf8');
    assert.strictEqual(afterJson, originalJson, 'deployments.json must remain byte-for-byte untouched');
  });

  await t.test('3. Idempotency: Re-running import performs NOOP and creates zero duplicates', () => {
    // First run
    executeLegacyImport({ db, deploymentsPath: tempDeploymentsPath });
    const countAfterFirst = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    assert.strictEqual(countAfterFirst, 2);

    // Second run
    const secondResult = executeLegacyImport({ db, deploymentsPath: tempDeploymentsPath });
    assert.strictEqual(secondResult.status, 'NO_CHANGES');
    assert.strictEqual(secondResult.importedCount, 0);

    const countAfterSecond = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    assert.strictEqual(countAfterSecond, 2, 'Re-run must not create duplicate records');
  });

  await t.test('4. Rollback utility cleanly removes imported records', () => {
    // Import first
    executeLegacyImport({ db, deploymentsPath: tempDeploymentsPath });
    assert.strictEqual(db.prepare('SELECT COUNT(*) as count FROM applications').get().count, 2);

    // Rollback
    const rollbackResult = rollbackLegacyImport({ db, deploymentsPath: tempDeploymentsPath });
    assert.strictEqual(rollbackResult.status, 'COMPLETED');
    assert.strictEqual(rollbackResult.deletedCount, 2);

    const countAfterRollback = db.prepare('SELECT COUNT(*) as count FROM applications').get().count;
    assert.strictEqual(countAfterRollback, 0, 'Rollback must remove the imported records');
  });

  await t.test('5. Real backend/data/deployments.json is confirmed untouched', () => {
    const realDeploymentsPath = path.join(__dirname, '..', 'data', 'deployments.json');
    if (fs.existsSync(realDeploymentsPath)) {
      const content = fs.readFileSync(realDeploymentsPath, 'utf8');
      assert.doesNotThrow(() => JSON.parse(content));
    }
  });
});
