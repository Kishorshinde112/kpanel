const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getCurrentVersion, getAppliedMigrations, loadMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentLeaseService = require('../services/deploymentLeaseService');
const deploymentWorker = require('../services/deploymentWorker');
const { DeploymentWorkerError, isBuildExecutionEnabled } = deploymentWorker;
const gitService = require('../services/gitService');
const { readBuildLog } = require('../services/buildLogService');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

// Helper to create an in-memory mock child process for spawn in offline tests
function createMockChildProcess({ exitCode = 0, signal = null, stdout = '', stderr = '', delayMs = 10, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.killSignals = [];

  child.kill = (sig = 'SIGTERM') => {
    child.killed = true;
    child.killSignals.push(sig);
  };

  setTimeout(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) {
      child.stdout.push(stdout);
    }
    child.stdout.push(null);

    if (stderr) {
      child.stderr.push(stderr);
    }
    child.stderr.push(null);

    setTimeout(() => {
      child.emit('close', exitCode, signal);
    }, delayMs);
  }, 5);

  return child;
}

test('Phase 4B2: Fenced Deployment Worker & BuildKit Integration Suite', async (t) => {
  let tempBaseDir;
  let workspaceRoot;
  let logRoot;
  let tempDbPath;
  let testDb;
  let fixtureRepoPath;
  let commit1Sha;
  let commit2Sha;
  let testPrivateKeyPem;
  let originalDeploymentsContent;

  const TEST_APP_ID = '888777';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '777,888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-worker-build-test-'));
    workspaceRoot = path.join(tempBaseDir, 'workspaces');
    logRoot = path.join(tempBaseDir, 'logs');
    tempDbPath = path.join(tempBaseDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;
    process.env.KPANEL_WORKSPACE_ROOT = workspaceRoot;
    process.env.KPANEL_BUILD_LOG_ROOT = logRoot;

    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);

    // Setup active installation once for all tests in suite
    testDb.prepare(`
      INSERT OR IGNORE INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status
      ) VALUES ('12345', '777', 'my-org', 'Organization', 'selected', 'active')
    `).run();

    // Generate test RSA keypair
    const { privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;

    // ── Setup an Offline Git Fixture with Dockerfile and commits ───────
    const fixtureWorkingDir = path.join(tempBaseDir, 'fixture-src');
    fixtureRepoPath = path.join(tempBaseDir, 'fixture-origin.git');
    fs.mkdirSync(fixtureWorkingDir, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.name', 'Worker Build Tester'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.email', 'worker-build@kpanel.local'], { cwd: fixtureWorkingDir });

    // Commit 1: Initial commit with Dockerfile
    fs.writeFileSync(path.join(fixtureWorkingDir, 'Dockerfile'), 'FROM node:20-alpine\nCMD ["node", "-v"]\n');
    fs.writeFileSync(path.join(fixtureWorkingDir, 'app.js'), 'console.log("v1");\n');
    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Commit 1 with Dockerfile'], { cwd: fixtureWorkingDir });
    commit1Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim().toLowerCase();

    // Commit 2: Second commit
    fs.writeFileSync(path.join(fixtureWorkingDir, 'app.js'), 'console.log("v2");\n');
    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Commit 2 update'], { cwd: fixtureWorkingDir });
    commit2Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim().toLowerCase();

    // Bare clone for origin
    execFileSync('git', ['clone', '--bare', fixtureWorkingDir, fixtureRepoPath]);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_WORKSPACE_ROOT;
    delete process.env.KPANEL_BUILD_LOG_ROOT;
    delete process.env.GITHUB_ALLOWED_ACCOUNT_IDS;

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json must remain completely untouched');
    }
  });

  // Helper to enqueue a job
  function setupQueuedJob(app, commitSha, ref = 'refs/heads/main', options = {}) {
    const deploymentId = crypto.randomUUID();
    const deliveryId = `deliv-${crypto.randomUUID()}`;

    testDb.prepare(`
      INSERT INTO github_webhook_deliveries (
        delivery_id, event_name, payload_sha256, decision, received_at
      ) VALUES (?, 'push', 'payload-hash-placeholder', 'accepted', CURRENT_TIMESTAMP)
    `).run(deliveryId);

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, log_path, created_at)
      VALUES (?, ?, ?, 'webhook', 'queued', ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, path.join(logRoot, `${deploymentId}.log`));

    testDb.prepare(`
      INSERT INTO github_webhook_deployment_sources (
        deployment_id, application_id, delivery_id, installation_id, repository_id, repository_full_name, ref, commit_sha, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      deploymentId,
      app.id,
      deliveryId,
      options.installationId || '12345',
      options.repositoryId || '777123',
      options.repositoryFullName || 'my-org/fixture-repo',
      ref,
      commitSha
    );

    return deploymentId;
  }

  // Mock execFile helper for Docker preflight & inspection
  function createMockExecFile({
    dockerVersion = 'Docker version 24.0.5',
    buildxVersion = 'github.com/docker/buildx v0.11.2',
    daemonVersion = '24.0.5',
    imageId = 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff'
  } = {}) {
    return (file, args, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }

      if (args[0] === 'rev-parse') {
        // Return commitSha or default
        return callback(null, commit1Sha, '');
      }
      if (args[0] === '--version') {
        return callback(null, dockerVersion, '');
      }
      if (args[0] === 'buildx' && args[1] === 'version') {
        return callback(null, buildxVersion, '');
      }
      if (args[0] === 'info') {
        return callback(null, daemonVersion, '');
      }
      if (args[0] === 'image' && args[1] === 'inspect') {
        return callback(null, imageId, '');
      }

      return callback(null, '', '');
    };
  }

  // ── 1. Migration 006 Schema & Idempotency Verification ──────────────
  await t.test('1. Migration 006 applies cleanly, creates deployment_build_artifacts, and adds columns to deployments', () => {
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 6, 'Schema version must be at least 6');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.length >= 6);

    const rerun = runMigrations(testDb);
    assert.equal(rerun.applied, 0, 'Migration re-run must be idempotent');

    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('deployment_build_artifacts'), 'deployment_build_artifacts table must exist');

    const deploymentCols = testDb.prepare('PRAGMA table_info(deployments)').all().map((c) => c.name);
    assert.ok(deploymentCols.includes('image_tag'), 'deployments table must include image_tag');
    assert.ok(deploymentCols.includes('image_id'), 'deployments table must include image_id');
    assert.ok(deploymentCols.includes('build_duration_ms'), 'deployments table must include build_duration_ms');

    const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
    assert.ok(indexes.includes('idx_build_artifacts_app_id'));
    assert.ok(indexes.includes('idx_build_artifacts_image_tag'));
    assert.ok(indexes.includes('idx_build_artifacts_commit_sha'));
  });

  // ── 2. Dual Build-Execution Authorization Gate Suite (Phase 4B2H Section 2) ──
  await t.test('2.1 Default prepare-only behavior preserved when executeBuild option is omitted', async () => {
    const app = createApplication(
      { name: 'Default Prepare App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(app.id);

    const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_workerTokenMock1',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    const result = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      logRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false
    });

    assert.equal(result.executed, true);
    assert.equal(result.deploymentId, jobId);
    assert.equal(result.prepared, true);
    assert.equal(result.buildExecutionEnabled, false);
    assert.equal(result.status, 'queued');

    const depRow = testDb.prepare('SELECT status, image_tag, image_id, claim_attempts FROM deployments WHERE id = ?').get(jobId);
    assert.equal(depRow.status, 'queued');
    assert.equal(depRow.claim_attempts, 0, 'Prepare-only run must not consume claim attempts');
    assert.equal(depRow.image_tag, null);
    assert.equal(depRow.image_id, null);

    const artifact = deploymentLeaseService.getDeploymentArtifact(jobId, { db: testDb });
    assert.equal(artifact, null);
  });

  await t.test('2.2 Build mode disabled when env is missing (executeBuild:true cannot bypass gate)', async () => {
    delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    assert.equal(isBuildExecutionEnabled(), false);

    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

    const app = createApplication(
      { name: 'Missing Env App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(app.id);

    const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

    let spawnCalled = false;
    const mockSpawn = () => {
      spawnCalled = true;
      throw new Error('Docker spawn should never be invoked when build execution is disabled!');
    };

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_tokenMissingEnv',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    const result = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      logRoot,
      executeBuild: true,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false,
      spawn: mockSpawn
    });

    assert.equal(spawnCalled, false, 'BuildKit must not be invoked when env is missing');
    assert.equal(result.executed, true);
    assert.equal(result.deploymentId, jobId);
    assert.equal(result.prepared, true);
    assert.equal(result.buildExecutionEnabled, false);
    assert.equal(result.buildRefused, true);
    assert.equal(result.status, 'queued');

    const depRow = testDb.prepare('SELECT status, image_tag, image_id, claim_attempts FROM deployments WHERE id = ?').get(jobId);
    assert.equal(depRow.status, 'queued', 'Deployment status must not change when build execution is refused');
    assert.equal(depRow.claim_attempts, 0, 'Claim attempts must not be consumed when build is refused');
    assert.equal(depRow.image_tag, null);
    assert.equal(depRow.image_id, null);

    const artifact = deploymentLeaseService.getDeploymentArtifact(jobId, { db: testDb });
    assert.equal(artifact, null, 'No artifact must be created when build execution is refused');
  });

  await t.test('2.3 Build mode disabled when env is false (executeBuild:true cannot bypass gate)', async () => {
    process.env.KPANEL_BUILD_EXECUTION_ENABLED = 'false';
    assert.equal(isBuildExecutionEnabled(), false);

    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

    const app = createApplication(
      { name: 'False Env App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(app.id);

    const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_tokenFalseEnv',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    try {
      const result = await deploymentWorker.runOnce({
        db: testDb,
        workspaceRoot,
        logRoot,
        executeBuild: true,
        allowTestFixture: true,
        testFixtureUrl: `file://${fixtureRepoPath}`,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockTokenFetch,
        enqueueBatch: false
      });

      assert.equal(result.executed, true);
      assert.equal(result.buildExecutionEnabled, false);
      assert.equal(result.buildRefused, true);
      assert.equal(result.status, 'queued');

      const depRow = testDb.prepare('SELECT status, claim_attempts FROM deployments WHERE id = ?').get(jobId);
      assert.equal(depRow.status, 'queued');
      assert.equal(depRow.claim_attempts, 0);
    } finally {
      delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    }
  });

  await t.test('2.4 Build mode disabled with malformed env values', async () => {
    const malformedValues = ['1', 'yes', 'TRUE', 'True', 'enabled', '', '0', 'undefined'];

    for (let idx = 0; idx < malformedValues.length; idx++) {
      const val = malformedValues[idx];
      process.env.KPANEL_BUILD_EXECUTION_ENABLED = val;
      assert.equal(isBuildExecutionEnabled(), false, `Malformed value "${val}" must evaluate to disabled`);

      testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

      const app = createApplication(
        { name: `Malformed App ${idx} ${Date.now()}`, repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: testDb }
      );

      testDb.prepare(`
        INSERT OR REPLACE INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

      const mockTokenFetch = async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          token: `ghs_tokenMalformed_${idx}`,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        })
      });

      const result = await deploymentWorker.runOnce({
        db: testDb,
        workspaceRoot,
        logRoot,
        executeBuild: true,
        allowTestFixture: true,
        testFixtureUrl: `file://${fixtureRepoPath}`,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockTokenFetch,
        enqueueBatch: false
      });

      assert.equal(result.buildExecutionEnabled, false, `Must be disabled for "${val}"`);
      assert.equal(result.buildRefused, true);
      assert.equal(result.status, 'queued');
    }

    delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
  });

  // ── 3. Fenced Build Execution with Both Controls Explicitly Enabled ─
  await t.test('3. Fenced build execution builds image, transitions to built, records durable artifacts', async () => {
    process.env.KPANEL_BUILD_EXECUTION_ENABLED = 'true';
    try {
      testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

      const app = createApplication(
        { name: 'Build App 1', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: testDb }
      );

      testDb.prepare(`
        INSERT OR REPLACE INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

      const mockTokenFetch = async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          token: 'ghs_workerTokenMock2',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        })
      });

      const expectedImageId = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
      const mockSpawn = (cmd, args) => {
        return createMockChildProcess({
          exitCode: 0,
          stdout: '#1 [internal] load build definition from Dockerfile\n#2 DONE 0.2s\n'
        });
      };

      // Run with executeBuild: true AND env gate enabled
      const result = await deploymentWorker.runOnce({
        db: testDb,
        workspaceRoot,
        logRoot,
        executeBuild: true,
        allowOverwrite: true,
        allowTestFixture: true,
        testFixtureUrl: `file://${fixtureRepoPath}`,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockTokenFetch,
        enqueueBatch: false,
        spawn: mockSpawn,
        execFile: createMockExecFile({ imageId: expectedImageId })
      });

      assert.equal(result.executed, true);
      assert.equal(result.deploymentId, jobId);
      assert.equal(result.status, 'built');
      assert.equal(result.imageId, expectedImageId);
      assert.equal(result.imageTag, `kpanel/app-${app.id}:d-${jobId}-${commit1Sha.slice(0, 7)}`);
      assert.ok(result.buildDurationMs >= 0);
      assert.ok(fs.existsSync(result.logPath));

      // ── Invariant Checks ──────────────────────────────────────────────
      // 1. Status is strictly 'built', NOT 'success'
      const depRow = testDb.prepare('SELECT status, image_tag, image_id, build_duration_ms, lease_owner FROM deployments WHERE id = ?').get(jobId);
      assert.equal(depRow.status, 'built', 'Deployment status must be "built"');
      assert.notEqual(depRow.status, 'success', 'Must NOT be marked success');
      assert.equal(depRow.image_tag, result.imageTag);
      assert.equal(depRow.image_id, expectedImageId);
      assert.equal(depRow.lease_owner, null, 'Lease claim must be cleared');

      // 2. Durable build artifact persisted in deployment_build_artifacts table
      const artifact = deploymentLeaseService.getDeploymentArtifact(jobId, { db: testDb });
      assert.ok(artifact, 'Durable artifact record must exist');
      assert.equal(artifact.deployment_id, jobId);
      assert.equal(artifact.application_id, app.id);
      assert.equal(artifact.commit_sha, commit1Sha);
      assert.equal(artifact.image_tag, result.imageTag);
      assert.equal(artifact.image_id, expectedImageId);
      assert.equal(artifact.build_type, 'dockerfile');

      // 3. Zero release records created
      const releaseCount = testDb.prepare('SELECT count(*) as count FROM releases WHERE deployment_id = ?').get(jobId).count;
      assert.equal(releaseCount, 0, 'No releases must be created');

      // 4. Temporary workspace was completely removed
      const appWorkspace = path.join(workspaceRoot, app.id);
      if (fs.existsSync(appWorkspace)) {
        const remainingOps = fs.readdirSync(appWorkspace);
        assert.equal(remainingOps.length, 0, 'All temporary workspaces must be cleaned up');
      }

      // 5. Build log is preserved and readable
      const logContent = readBuildLog(jobId, { logRoot });
      assert.match(logContent, /BUILD STARTED/);
      assert.match(logContent, /load build definition from Dockerfile/);
      assert.match(logContent, /BUILD SUCCESSFUL/);
    } finally {
      delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    }
  });

  // ── 4. Mandatory SQLite 'built' Status Verification (Phase 4B2H Section 3) ──
  await t.test('4.1 Case A: Brand-new database with migrations 001–006 accepts built status (10-step verification)', async () => {
    const caseAPath = path.join(tempBaseDir, 'case-a-brand-new.db');
    const caseADb = new Database(caseAPath);
    caseADb.pragma('foreign_keys = ON');
    try {
      // Step A: Brand-new database with migrations 001–006
      const migResult = runMigrations(caseADb);
      assert.ok(migResult.currentVersion >= 6, 'Schema version must be at least 6');

      // Step 1: Insert authentic queued deployment with required relationships
      const app = createApplication(
        { name: 'Case A App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: caseADb }
      );

      caseADb.prepare(`
        INSERT INTO github_installations (
          installation_id, account_id, account_login, account_type, repository_selection, installation_status
        ) VALUES ('inst-case-a', '777', 'my-org', 'Organization', 'selected', 'active')
      `).run();

      caseADb.prepare(`
        INSERT INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, 'inst-case-a', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const depId = crypto.randomUUID();
      const delivId = `deliv-case-a-${crypto.randomUUID()}`;

      caseADb.prepare(`
        INSERT INTO github_webhook_deliveries (delivery_id, event_name, payload_sha256, decision, received_at)
        VALUES (?, 'push', 'hash-case-a', 'accepted', CURRENT_TIMESTAMP)
      `).run(delivId);

      caseADb.prepare(`
        INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, created_at)
        VALUES (?, ?, ?, 'webhook', 'queued', CURRENT_TIMESTAMP)
      `).run(depId, app.id, commit1Sha);

      caseADb.prepare(`
        INSERT INTO github_webhook_deployment_sources (
          deployment_id, application_id, delivery_id, installation_id, repository_id, repository_full_name, ref, commit_sha, created_at
        ) VALUES (?, ?, ?, 'inst-case-a', '777123', 'my-org', 'refs/heads/main', ?, CURRENT_TIMESTAMP)
      `).run(depId, app.id, delivId, commit1Sha);

      // Step 2: Acquire the global lease
      const lease = deploymentLeaseService.acquireWorkerLease('worker-case-a', { db: caseADb });
      assert.equal(lease.acquired, true);

      // Step 3: Claim the deployment
      const claim = deploymentLeaseService.claimNextDeployment('worker-case-a', lease.fencingToken, { db: caseADb });
      assert.equal(claim.claimed, true);
      assert.equal(claim.deployment.id, depId);

      // Step 4: Apply the fenced transition to building
      const buildingResult = deploymentLeaseService.recordDeploymentBuilding(depId, 'worker-case-a', lease.fencingToken, { db: caseADb });
      assert.equal(buildingResult.status, 'building');

      // Step 5: Persist a valid mocked build result
      const expectedImageId = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
      const expectedImageTag = `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`;
      const artifactData = {
        applicationId: app.id,
        commitSha: commit1Sha,
        imageTag: expectedImageTag,
        imageId: expectedImageId,
        buildDurationMs: 1200,
        logPath: path.join(logRoot, `${depId}.log`),
        platform: 'linux/arm64',
        buildType: 'dockerfile',
        buildPath: '.',
        dockerfilePath: 'Dockerfile'
      };

      // Step 6: Apply the fenced transition to built
      const builtResult = deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-case-a', lease.fencingToken, artifactData, { db: caseADb });
      assert.equal(builtResult.status, 'built');

      // Step 7: Verify the committed SQLite status is built (and NOT success)
      const depRow = caseADb.prepare('SELECT status, image_tag, image_id, lease_owner FROM deployments WHERE id = ?').get(depId);
      assert.equal(depRow.status, 'built', 'Committed status must be "built"');
      assert.notEqual(depRow.status, 'success', 'Must NOT be marked success in Phase 4B2');
      assert.equal(depRow.lease_owner, null, 'Lease owner must be cleared');

      // Step 8: Verify the artifact exists with the expected image ID
      const artifactRow = deploymentLeaseService.getDeploymentArtifact(depId, { db: caseADb });
      assert.ok(artifactRow, 'Artifact row must exist');
      assert.equal(artifactRow.image_id, expectedImageId);
      assert.equal(artifactRow.image_tag, expectedImageTag);

      // Step 9: Reopen the database
      caseADb.close();
      const reopenedDb = new Database(caseAPath);
      reopenedDb.pragma('foreign_keys = ON');

      // Step 10: Verify status and artifact remain consistent
      const reopenedDep = reopenedDb.prepare('SELECT status, image_tag, image_id FROM deployments WHERE id = ?').get(depId);
      assert.equal(reopenedDep.status, 'built', 'Status must remain built after reopen');
      assert.equal(reopenedDep.image_id, expectedImageId);

      const reopenedArtifact = deploymentLeaseService.getDeploymentArtifact(depId, { db: reopenedDb });
      assert.ok(reopenedArtifact);
      assert.equal(reopenedArtifact.image_id, expectedImageId);
      assert.equal(reopenedArtifact.image_tag, expectedImageTag);

      reopenedDb.close();
    } catch (err) {
      try { caseADb.close(); } catch {}
      throw err;
    }
  });

  await t.test('4.2 Case B: Existing database migrated through 005, containing queued job, upgraded to 006 (10-step verification)', async () => {
    const caseBPath = path.join(tempBaseDir, 'case-b-upgrade.db');
    const caseBDb = new Database(caseBPath);
    caseBDb.pragma('foreign_keys = ON');
    try {
      // 1. Run migrations 001–005 only
      const v1to5Migrations = loadMigrations().filter((m) => m.version <= 5);
      const migResult = runMigrations(caseBDb, v1to5Migrations);
      assert.equal(migResult.currentVersion, 5, 'Initial database must be schema version 5');

      // 2. Insert authentic queued deployment with required relationships in v005 database
      const app = createApplication(
        { name: 'Case B App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: caseBDb }
      );

      caseBDb.prepare(`
        INSERT INTO github_installations (
          installation_id, account_id, account_login, account_type, repository_selection, installation_status
        ) VALUES ('inst-case-b', '777', 'my-org', 'Organization', 'selected', 'active')
      `).run();

      caseBDb.prepare(`
        INSERT INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, 'inst-case-b', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const depId = crypto.randomUUID();
      const delivId = `deliv-case-b-${crypto.randomUUID()}`;

      caseBDb.prepare(`
        INSERT INTO github_webhook_deliveries (delivery_id, event_name, payload_sha256, decision, received_at)
        VALUES (?, 'push', 'hash-case-b', 'accepted', CURRENT_TIMESTAMP)
      `).run(delivId);

      caseBDb.prepare(`
        INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, created_at)
        VALUES (?, ?, ?, 'webhook', 'queued', CURRENT_TIMESTAMP)
      `).run(depId, app.id, commit1Sha);

      caseBDb.prepare(`
        INSERT INTO github_webhook_deployment_sources (
          deployment_id, application_id, delivery_id, installation_id, repository_id, repository_full_name, ref, commit_sha, created_at
        ) VALUES (?, ?, ?, 'inst-case-b', '777123', 'my-org', 'refs/heads/main', ?, CURRENT_TIMESTAMP)
      `).run(depId, app.id, delivId, commit1Sha);

      // Verify deployment exists in v005 db with status 'queued'
      const preUpgradeDep = caseBDb.prepare('SELECT status FROM deployments WHERE id = ?').get(depId);
      assert.equal(preUpgradeDep.status, 'queued');

      // 3. Subsequently upgrade to migration 006
      const v1to6Migrations = loadMigrations().filter((m) => m.version <= 6);
      const upgradeResult = runMigrations(caseBDb, v1to6Migrations);
      assert.equal(upgradeResult.applied, 1, 'Exactly one pending migration (006) must be applied');
      assert.equal(upgradeResult.currentVersion, 6, 'Schema version must now be 6');

      // 4. Acquire the global lease
      const lease = deploymentLeaseService.acquireWorkerLease('worker-case-b', { db: caseBDb });
      assert.equal(lease.acquired, true);

      // 5. Claim the deployment
      const claim = deploymentLeaseService.claimNextDeployment('worker-case-b', lease.fencingToken, { db: caseBDb });
      assert.equal(claim.claimed, true);
      assert.equal(claim.deployment.id, depId);

      // 6. Apply the fenced transition to building
      const buildingResult = deploymentLeaseService.recordDeploymentBuilding(depId, 'worker-case-b', lease.fencingToken, { db: caseBDb });
      assert.equal(buildingResult.status, 'building');

      // 7. Persist a valid mocked build result
      const expectedImageId = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
      const expectedImageTag = `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`;
      const artifactData = {
        applicationId: app.id,
        commitSha: commit1Sha,
        imageTag: expectedImageTag,
        imageId: expectedImageId,
        buildDurationMs: 1450,
        logPath: path.join(logRoot, `${depId}.log`),
        platform: 'linux/arm64',
        buildType: 'dockerfile',
        buildPath: '.',
        dockerfilePath: 'Dockerfile'
      };

      // 8. Apply the fenced transition to built
      const builtResult = deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-case-b', lease.fencingToken, artifactData, { db: caseBDb });
      assert.equal(builtResult.status, 'built');

      // 9. Verify the committed SQLite status is built
      const depRow = caseBDb.prepare('SELECT status, image_tag, image_id, lease_owner FROM deployments WHERE id = ?').get(depId);
      assert.equal(depRow.status, 'built', 'Upgraded database must accept status = "built"');
      assert.notEqual(depRow.status, 'success');
      assert.equal(depRow.lease_owner, null);

      // 10. Verify the artifact exists with expected image ID
      const artifactRow = deploymentLeaseService.getDeploymentArtifact(depId, { db: caseBDb });
      assert.ok(artifactRow);
      assert.equal(artifactRow.image_id, expectedImageId);
      assert.equal(artifactRow.image_tag, expectedImageTag);

      // 11. Reopen the database
      caseBDb.close();
      const reopenedDb = new Database(caseBPath);
      reopenedDb.pragma('foreign_keys = ON');

      // 12. Verify status and artifact remain consistent
      const reopenedDep = reopenedDb.prepare('SELECT status, image_tag, image_id FROM deployments WHERE id = ?').get(depId);
      assert.equal(reopenedDep.status, 'built');
      assert.equal(reopenedDep.image_id, expectedImageId);

      const reopenedArtifact = deploymentLeaseService.getDeploymentArtifact(depId, { db: reopenedDb });
      assert.ok(reopenedArtifact);
      assert.equal(reopenedArtifact.image_id, expectedImageId);

      reopenedDb.close();
    } catch (err) {
      try { caseBDb.close(); } catch {}
      throw err;
    }
  });

  // ── 5. Uncertain Build Recovery & Crash Handling (Phase 4B2H Section 4) ──
  await t.test('5.1 Crash while queued: Expired queued claim is safely recovered within attempt limits', () => {
    const app = createApplication(
      { name: 'Queued Recovery App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, claim_attempts, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'queued', 1, 'dead-worker-1', 5, datetime('now', '-30 seconds'))
    `).run(depId, app.id, commit1Sha);

    const lease = deploymentLeaseService.acquireWorkerLease('recovering-worker', { db: testDb });
    const claim = deploymentLeaseService.claimNextDeployment('recovering-worker', lease.fencingToken, { db: testDb });

    assert.equal(claim.claimed, true);
    assert.equal(claim.deployment.id, depId);
    assert.equal(claim.deployment.claimAttempts, 2, 'Attempt count must be incremented on recovery');
    assert.equal(claim.deployment.leaseOwner, 'recovering-worker');

    deploymentLeaseService.releaseDeploymentClaim(depId, 'recovering-worker', lease.fencingToken, { db: testDb });
    deploymentLeaseService.releaseWorkerLease('recovering-worker', lease.fencingToken, { db: testDb });
  });

  await t.test('5.2 Crash while building: Expired building claim is NOT automatically reclaimed by queue worker', () => {
    const app = createApplication(
      { name: 'Crashed Building App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const crashedDepId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, claim_attempts, lease_owner, lease_token, lease_expires_at, started_at)
      VALUES (?, ?, ?, 'building', 1, 'dead-worker-building', 7, datetime('now', '-60 seconds'), datetime('now', '-120 seconds'))
    `).run(crashedDepId, app.id, commit1Sha);

    const lease = deploymentLeaseService.acquireWorkerLease('normal-worker', { db: testDb });

    // Normal queue worker only claims status = 'queued'
    const claim = deploymentLeaseService.claimNextDeployment('normal-worker', lease.fencingToken, { db: testDb });
    // If no other queued jobs exist, claim.claimed should be false or a different job
    if (claim.claimed) {
      assert.notEqual(claim.deployment.id, crashedDepId, 'Normal worker must NEVER claim a building job');
    } else {
      assert.equal(claim.claimed, false);
    }

    // Verify crashed deployment state is completely untouched
    const depCheck = testDb.prepare('SELECT status, lease_owner, claim_attempts FROM deployments WHERE id = ?').get(crashedDepId);
    assert.equal(depCheck.status, 'building', 'Job must remain in building status');
    assert.notEqual(depCheck.status, 'queued', 'Must NOT automatically reset to queued');
    assert.notEqual(depCheck.status, 'success', 'Must NOT mark successful');
    assert.notEqual(depCheck.status, 'failed', 'Must NOT mark failed without evidence');

    // Verify minimal read-only classification of uncertain building jobs
    const uncertainJobs = deploymentLeaseService.getUncertainBuildingDeployments({ db: testDb });
    const matching = uncertainJobs.find((j) => j.deploymentId === crashedDepId);
    assert.ok(matching, 'Uncertain building deployment must be detected by inspection query');
    assert.equal(matching.status, 'building');
    assert.equal(matching.isExpired, true);
    assert.equal(matching.hasCommittedArtifact, false);
    assert.equal(matching.safeToAutoRebuild, false, 'Must NOT be marked safe to auto-rebuild');
    assert.equal(matching.requiresManualReconciliation, true, 'Must require external reconciliation');
    assert.equal(matching.classification, 'UNCERTAIN_BUILD_CRASH');

    deploymentLeaseService.releaseWorkerLease('normal-worker', lease.fencingToken, { db: testDb });
  });

  await t.test('5.3 Crash after completed build artifact commit: Persisted built artifact is NOT rebuilt', () => {
    const app = createApplication(
      { name: 'Built App Not Rebuilt', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const builtDepId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, image_tag, image_id)
      VALUES (?, ?, ?, 'built', 'kpanel/built-tag:d-1', 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd')
    `).run(builtDepId, app.id, commit1Sha);

    const lease = deploymentLeaseService.acquireWorkerLease('worker-built-check', { db: testDb });
    const claim = deploymentLeaseService.claimNextDeployment('worker-built-check', lease.fencingToken, { db: testDb });

    if (claim.claimed) {
      assert.notEqual(claim.deployment.id, builtDepId, 'Built deployments must never be claimed by queue worker');
    }

    deploymentLeaseService.releaseWorkerLease('worker-built-check', lease.fencingToken, { db: testDb });
  });

  // ── 6. Fencing Token Enforcement, Stale Worker Protections & Artifact Integrity ──
  await t.test('6.1 Fencing token mismatch rejects transition and throws LEASE_LOST', () => {
    const fakeApp = createApplication(
      { name: 'Fencing App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const fakeDepId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, 'commit-fake', 'queued', 'worker-valid', 10, datetime('now', '+60 seconds'))
    `).run(fakeDepId, fakeApp.id);

    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'worker-valid', 10, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    // Stale token throws LEASE_LOST
    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilding(fakeDepId, 'worker-valid', 9, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'LEASE_LOST'
    );

    // Wrong owner throws LEASE_LOST
    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilding(fakeDepId, 'worker-impostor', 10, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'LEASE_LOST'
    );

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  await t.test('6.2 Stale worker whose lease expired cannot record built', () => {
    const app = createApplication(
      { name: 'Stale Built App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'building', 'stale-worker-1', 15, datetime('now', '-10 seconds'))
    `).run(depId, app.id, commit1Sha);

    // Global lock expired
    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'stale-worker-1', 15, datetime('now', '-10 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const artifactData = {
      applicationId: app.id,
      commitSha: commit1Sha,
      imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
      imageId: 'sha256:1111111111111111111111111111111111111111111111111111111111111111',
      buildDurationMs: 1000,
      logPath: '/tmp/test.log'
    };

    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilt(depId, 'stale-worker-1', 15, artifactData, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && (err.code === 'LEASE_LOST' || err.code === 'CLAIM_EXPIRED')
    );

    const depCheck = testDb.prepare('SELECT status FROM deployments WHERE id = ?').get(depId);
    assert.equal(depCheck.status, 'building', 'Status must not transition to built from stale worker');

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  await t.test('6.3 Stale worker whose lease expired cannot record failed', () => {
    const app = createApplication(
      { name: 'Stale Fail App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'building', 'stale-worker-2', 20, datetime('now', '-10 seconds'))
    `).run(depId, app.id, commit1Sha);

    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'stale-worker-2', 20, datetime('now', '-10 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const result = deploymentLeaseService.recordDeploymentFailed(depId, 'stale-worker-2', 20, 'Some error', null, { db: testDb });
    assert.equal(result.updated, false);

    const depCheck = testDb.prepare('SELECT status FROM deployments WHERE id = ?').get(depId);
    assert.equal(depCheck.status, 'building', 'Status must not transition to failed from stale worker');

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  await t.test('6.4 Late build success after cancellation is rejected', () => {
    const app = createApplication(
      { name: 'Late Success App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();

    // Worker was building, but deployment was cancelled by user
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'cancelled', 'worker-late', 25, datetime('now', '+60 seconds'))
    `).run(depId, app.id, commit1Sha);

    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'worker-late', 25, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const artifactData = {
      applicationId: app.id,
      commitSha: commit1Sha,
      imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
      imageId: 'sha256:2222222222222222222222222222222222222222222222222222222222222222',
      buildDurationMs: 800,
      logPath: '/tmp/test.log'
    };

    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-late', 25, artifactData, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'CLAIM_LOST'
    );

    const depCheck = testDb.prepare('SELECT status FROM deployments WHERE id = ?').get(depId);
    assert.equal(depCheck.status, 'cancelled', 'Cancelled status must not be overwritten by late build success');

    const artifact = deploymentLeaseService.getDeploymentArtifact(depId, { db: testDb });
    assert.equal(artifact, null, 'No artifact must be inserted for cancelled deployment');

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  await t.test('6.5 Artifact insert failure rolls back status transition', () => {
    const app = createApplication(
      { name: 'Rollback App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'building', 'worker-rollback', 30, datetime('now', '+60 seconds'))
    `).run(depId, app.id, commit1Sha);

    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'worker-rollback', 30, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    // Pre-insert an existing conflicting artifact for this deployment_id to force UNIQUE constraint failure
    testDb.prepare(`
      INSERT INTO deployment_build_artifacts (
        deployment_id, application_id, commit_sha, image_tag, image_id, build_duration_ms, log_path
      ) VALUES (?, ?, ?, 'pre-existing-tag', 'sha256:3333333333333333333333333333333333333333333333333333333333333333', 500, '/tmp/pre.log')
    `).run(depId, app.id, commit1Sha);

    const artifactData = {
      applicationId: app.id,
      commitSha: commit1Sha,
      imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
      imageId: 'sha256:4444444444444444444444444444444444444444444444444444444444444444',
      buildDurationMs: 900,
      logPath: '/tmp/test.log'
    };

    assert.throws(() => {
      deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-rollback', 30, artifactData, { db: testDb });
    });

    // Verify status transition was ROLLED BACK and remains 'building'
    const depCheck = testDb.prepare('SELECT status, image_tag, image_id FROM deployments WHERE id = ?').get(depId);
    assert.equal(depCheck.status, 'building', 'Status must roll back to building on artifact insert failure');
    assert.equal(depCheck.image_tag, null);
    assert.equal(depCheck.image_id, null);

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  await t.test('6.6 Strict artifact input validation: malformed imageId, wrong appId, wrong commitSha', () => {
    const app = createApplication(
      { name: 'Validation App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    const depId = crypto.randomUUID();

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status, lease_owner, lease_token, lease_expires_at)
      VALUES (?, ?, ?, 'building', 'worker-val', 35, datetime('now', '+60 seconds'))
    `).run(depId, app.id, commit1Sha);

    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (
        lock_name, owner_id, fencing_token, lease_expires_at
      ) VALUES (?, 'worker-val', 35, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    // 1. Malformed imageId (not sha256)
    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-val', 35, {
          applicationId: app.id,
          commitSha: commit1Sha,
          imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
          imageId: 'invalid-image-id',
          buildDurationMs: 100,
          logPath: '/tmp/log'
        }, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'INVALID_ARTIFACT_DATA'
    );

    // 2. Mismatched applicationId
    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-val', 35, {
          applicationId: 'completely-wrong-app-id',
          commitSha: commit1Sha,
          imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
          imageId: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
          buildDurationMs: 100,
          logPath: '/tmp/log'
        }, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'INVALID_ARTIFACT_DATA'
    );

    // 3. Mismatched commitSha
    assert.throws(
      () => {
        deploymentLeaseService.recordDeploymentBuilt(depId, 'worker-val', 35, {
          applicationId: app.id,
          commitSha: '0000000000000000000000000000000000000000',
          imageTag: `kpanel/app-${app.id}:d-${depId}-${commit1Sha.slice(0, 7)}`,
          imageId: 'sha256:5555555555555555555555555555555555555555555555555555555555555555',
          buildDurationMs: 100,
          logPath: '/tmp/log'
        }, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'INVALID_ARTIFACT_DATA'
    );

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  // ── 7. Competitor Takeover During Build Blocks Status Update ─────────
  await t.test('7. Lease takeover during build prevents original worker from committing built status', async () => {
    process.env.KPANEL_BUILD_EXECUTION_ENABLED = 'true';
    try {
      testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

      const app = createApplication(
        { name: 'Takeover App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: testDb }
      );

      testDb.prepare(`
        INSERT OR REPLACE INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

      const mockTokenFetch = async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          token: 'ghs_workerTokenTakeover',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        })
      });

      const mockSpawn = () => {
        testDb.prepare(`
          UPDATE deployment_worker_lock
          SET owner_id = 'competitor-usurper',
              fencing_token = fencing_token + 1,
              lease_expires_at = datetime('now', '+60 seconds')
          WHERE lock_name = ?
        `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

        return createMockChildProcess({ exitCode: 0, stdout: 'build step\n' });
      };

      await assert.rejects(
        async () => {
          await deploymentWorker.runOnce({
            db: testDb,
            workspaceRoot,
            logRoot,
            executeBuild: true,
            allowOverwrite: true,
            allowTestFixture: true,
            testFixtureUrl: `file://${fixtureRepoPath}`,
            appId: TEST_APP_ID,
            privateKey: testPrivateKeyPem,
            fetch: mockTokenFetch,
            enqueueBatch: false,
            spawn: mockSpawn,
            execFile: createMockExecFile()
          });
        },
        (err) => err instanceof DeploymentWorkerError && err.code === 'LEASE_LOST'
      );

      const depCheck = testDb.prepare('SELECT status, image_tag FROM deployments WHERE id = ?').get(jobId);
      assert.notEqual(depCheck.status, 'built');

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    }
  });

  // ── 8. Docker Build Failure Handling & Failure Log Persistence ──────
  await t.test('8. Docker build failure transitions status to failed and records failure reason and log', async () => {
    process.env.KPANEL_BUILD_EXECUTION_ENABLED = 'true';
    try {
      testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

      const app = createApplication(
        { name: 'Fail App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: testDb }
      );

      testDb.prepare(`
        INSERT OR REPLACE INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      const jobId = setupQueuedJob(app, commit1Sha, 'refs/heads/main');

      const mockTokenFetch = async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          token: 'ghs_workerTokenFail',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        })
      });

      const mockSpawn = () => {
        return createMockChildProcess({
          exitCode: 1,
          stderr: 'Error response from daemon: syntax error in Dockerfile\n'
        });
      };

      await assert.rejects(
        async () => {
          await deploymentWorker.runOnce({
            db: testDb,
            workspaceRoot,
            logRoot,
            executeBuild: true,
            allowOverwrite: true,
            allowTestFixture: true,
            testFixtureUrl: `file://${fixtureRepoPath}`,
            appId: TEST_APP_ID,
            privateKey: testPrivateKeyPem,
            fetch: mockTokenFetch,
            enqueueBatch: false,
            spawn: mockSpawn,
            execFile: createMockExecFile()
          });
        },
        (err) => err.code === 'BUILD_FAILED'
      );

      const depCheck = testDb.prepare('SELECT status, failure_reason, log_path, finished_at FROM deployments WHERE id = ?').get(jobId);
      assert.equal(depCheck.status, 'failed');
      assert.match(depCheck.failure_reason, /Docker build failed with exit code 1/);
      assert.ok(depCheck.finished_at);
      assert.ok(fs.existsSync(depCheck.log_path));

      const logText = readBuildLog(jobId, { logRoot });
      assert.match(logText, /syntax error in Dockerfile/);
      assert.match(logText, /BUILD FAILED: Docker exited with code 1/);
    } finally {
      delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    }
  });

  // ── 9. Caller Cancellation via AbortSignal During Build ─────────────
  await t.test('9. Caller AbortSignal during build aborts child process and throws OPERATION_CANCELLED', async () => {
    process.env.KPANEL_BUILD_EXECUTION_ENABLED = 'true';
    try {
      testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

      const app = createApplication(
        { name: 'Cancel App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
        { db: testDb }
      );

      testDb.prepare(`
        INSERT OR REPLACE INTO application_repositories (
          application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
        ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
      `).run(app.id);

      setupQueuedJob(app, commit1Sha, 'refs/heads/main');

      const mockTokenFetch = async () => ({
        ok: true,
        status: 201,
        text: async () => JSON.stringify({
          token: 'ghs_workerTokenCancel',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        })
      });

      const abortCtrl = new AbortController();
      let mockChildRef;
      const mockSpawn = () => {
        mockChildRef = createMockChildProcess({ exitCode: 0, delayMs: 400 });
        setTimeout(() => {
          abortCtrl.abort();
        }, 10);
        return mockChildRef;
      };

      const workerPromise = deploymentWorker.runOnce({
        db: testDb,
        workspaceRoot,
        logRoot,
        executeBuild: true,
        allowOverwrite: true,
        allowTestFixture: true,
        testFixtureUrl: `file://${fixtureRepoPath}`,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockTokenFetch,
        enqueueBatch: false,
        signal: abortCtrl.signal,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      });

      await assert.rejects(
        workerPromise,
        (err) => err.code === 'OPERATION_CANCELLED' || err.code === 'LEASE_LOST'
      );

      assert.ok(mockChildRef.killed, 'Child process must be killed on cancellation');
    } finally {
      delete process.env.KPANEL_BUILD_EXECUTION_ENABLED;
    }
  });

  // ── 10. Zero Container Launch, Routing Changes, Releases, or Daemon Calls ──
  await t.test('10. Zero container launch, routing changes, or releases during entire worker cycle', () => {
    const releases = testDb.prepare('SELECT * FROM releases').all();
    assert.equal(releases.length, 0, 'No releases must exist');

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });
});
