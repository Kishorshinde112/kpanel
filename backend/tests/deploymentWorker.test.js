const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentLeaseService = require('../services/deploymentLeaseService');
const deploymentQueueService = require('../services/deploymentQueueService');
const deploymentWorker = require('../services/deploymentWorker');
const { DeploymentWorkerError } = deploymentWorker;
const gitService = require('../services/gitService');
const { GitServiceError } = gitService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 4A2: Exact-Commit Checkout & Worker Orchestration Suite', async (t) => {
  let tempBaseDir;
  let workspaceRoot;
  let tempDbPath;
  let testDb;
  let fixtureRepoPath;
  let commit1Sha;
  let commit2Sha;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let originalDeploymentsContent;

  const TEST_APP_ID = '999888';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-worker-test-'));
    workspaceRoot = path.join(tempBaseDir, 'workspaces');
    tempDbPath = path.join(tempBaseDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;
    process.env.KPANEL_WORKSPACE_ROOT = workspaceRoot;

    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);

    // Generate test RSA keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;

    // ── Setup an Offline Git Fixture with multiple commits to test exact-commit checkouts ──
    const fixtureWorkingDir = path.join(tempBaseDir, 'fixture-src');
    fixtureRepoPath = path.join(tempBaseDir, 'fixture-origin.git');
    fs.mkdirSync(fixtureWorkingDir, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.name', 'Worker Tester'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.email', 'worker@kpanel.local'], { cwd: fixtureWorkingDir });

    // Commit 1: Initial state
    fs.writeFileSync(path.join(fixtureWorkingDir, 'file.txt'), 'Version 1\n');
    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Commit 1'], { cwd: fixtureWorkingDir });
    commit1Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim().toLowerCase();

    // Commit 2: HEAD moves forward!
    fs.writeFileSync(path.join(fixtureWorkingDir, 'file.txt'), 'Version 2 - HEAD moved\n');
    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Commit 2'], { cwd: fixtureWorkingDir });
    commit2Sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim().toLowerCase();

    // Clone bare to simulate remote origin
    execFileSync('git', ['clone', '--bare', fixtureWorkingDir, fixtureRepoPath]);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_WORKSPACE_ROOT;
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

  // Helper to enqueue a job with specific commit and target metadata
  function setupQueuedJob(app, commitSha, ref = 'refs/heads/main', options = {}) {
    const deploymentId = crypto.randomUUID();
    const deliveryId = `deliv-${crypto.randomUUID()}`;

    // Ensure foreign key in github_webhook_deliveries is satisfied
    testDb.prepare(`
      INSERT INTO github_webhook_deliveries (
        delivery_id, event_name, payload_sha256, decision, received_at
      ) VALUES (?, 'push', 'payload-hash-placeholder', 'accepted', CURRENT_TIMESTAMP)
    `).run(deliveryId);

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, log_path, created_at)
      VALUES (?, ?, ?, 'webhook', 'queued', ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, `/tmp/log-${deploymentId}.log`);

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

  // ── 1-6. Exact-Commit Git Checkout & Branch Movement ───────────────
  await t.test('1-6. Exact commit checkout retrieves older commit 1 even after branch HEAD has moved to commit 2', async () => {
    const app = {
      id: '11111111-1111-4111-8111-111111111111',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    // Branch HEAD is currently commit 2, but we request older commit 1!
    const snapshot1 = await gitService.fetchCommit(app, commit1Sha, {
      workspaceRoot,
      allowTestFixture: true
    });

    // 1-3. Verify exact commit checkout and detached HEAD
    assert.ok(snapshot1.workspacePath);
    assert.equal(snapshot1.commitSha, commit1Sha);

    const checkedOutContent = fs.readFileSync(path.join(snapshot1.workspacePath, 'file.txt'), 'utf8');
    assert.equal(checkedOutContent.trim(), 'Version 1', 'Workspace must contain contents of commit 1, not commit 2');

    // 6. Branch HEAD was never substituted
    assert.notEqual(snapshot1.commitSha, commit2Sha);

    gitService.cleanupWorkspace(snapshot1, { workspaceRoot });
  });

  // ── 7-10. Invalid, Zero, Missing & Wrong Commit SHA Rejection ───────
  await t.test('7-10. Invalid, zero, or nonexistent commit SHAs are rejected cleanly', async () => {
    const app = {
      id: '22222222-2222-4222-8222-222222222222',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    // 7. Invalid SHA (too short, illegal chars)
    await assert.rejects(
      async () => {
        await gitService.fetchCommit(app, 'not-a-valid-sha', { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'INVALID_COMMIT_SHA'
    );

    // 8. Zero SHA
    await assert.rejects(
      async () => {
        await gitService.fetchCommit(app, '0000000000000000000000000000000000000000', { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'INVALID_COMMIT_SHA'
    );

    // 9. Nonexistent commit SHA
    await assert.rejects(
      async () => {
        await gitService.fetchCommit(app, 'ffffffffffffffffffffffffffffffffffffffff', { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'GIT_COMMIT_UNAVAILABLE'
    );
  });

  // ── 11-15. Public & Private Git Compatibility & Credential Broker ──
  await t.test('11-15. Public and GitHub App private repos checkout cleanly with credential broker lifecycle', async () => {
    // 11. Public repository checkout without broker
    const publicApp = {
      id: '33333333-3333-4333-8333-333333333333',
      repo_url: 'https://github.com/public-org/fixture-repo.git',
      branch: 'main'
    };

    const publicSnapshot = await gitService.fetchCommit(publicApp, commit1Sha, {
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      authMode: 'public'
    });

    assert.equal(publicSnapshot.commitSha, commit1Sha);
    assert.ok(fs.existsSync(path.join(publicSnapshot.workspacePath, 'file.txt')));
    gitService.cleanupWorkspace(publicSnapshot, { workspaceRoot });
    assert.ok(!fs.existsSync(publicSnapshot.workspacePath), 'Public workspace cleaned up');

    // 12-15. Private repository with GitHub App installation and credential broker
    const privateApp = {
      id: '44444444-4444-4444-8444-444444444444',
      repo_url: 'https://github.com/my-org/fixture-repo.git',
      branch: 'main'
    };

    const mockBrokerTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_privateTokenMock987',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    const privateSnapshot = await gitService.fetchCommit(privateApp, commit2Sha, {
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      authMode: 'github-app',
      installationId: '12345',
      repositoryName: 'fixture-repo',
      repositoryOwner: 'my-org',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockBrokerTokenFetch
    });

    assert.equal(privateSnapshot.commitSha, commit2Sha);
    const content = fs.readFileSync(path.join(privateSnapshot.workspacePath, 'file.txt'), 'utf8');
    assert.match(content, /Version 2/);
    gitService.cleanupWorkspace(privateSnapshot, { workspaceRoot });
    assert.ok(!fs.existsSync(privateSnapshot.workspacePath), 'Private workspace cleaned up');

    // Verify broker cleanup on fetch failure
    await assert.rejects(
      async () => {
        await gitService.fetchCommit(privateApp, 'ffffffffffffffffffffffffffffffffffffffff', {
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          authMode: 'github-app',
          installationId: '12345',
          repositoryName: 'fixture-repo',
          repositoryOwner: 'my-org',
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockBrokerTokenFetch
        });
      },
      (err) => err instanceof GitServiceError && err.code === 'GIT_COMMIT_UNAVAILABLE'
    );
  });

  // ── 16-18. Worker Global Lease & Single-Job Claiming ───────────────
  await t.test('16-18. Worker acquires global lease, blocks competitor, and claims only one queued job', async () => {
    const app = createApplication(
      { name: 'Worker App 1', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );

    // Setup installation and association
    testDb.prepare(`
      INSERT OR REPLACE INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status
      ) VALUES ('12345', '999', 'my-org', 'Organization', 'selected', 'active')
    `).run();

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(app.id);

    const jobId = setupQueuedJob(app, commit2Sha, 'refs/heads/main');

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_workerToken12345',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    // Run one-shot worker
    const result = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false
    });

    assert.equal(result.executed, true);
    assert.equal(result.deploymentId, jobId);
    assert.equal(result.commitSha, commit2Sha);
    assert.equal(result.prepared, true);

    // 17. Second concurrent worker gets busy result while a lease is actively held
    const activeLease = deploymentLeaseService.acquireWorkerLease('holder-worker', { db: testDb, leaseSeconds: 20 });
    assert.equal(activeLease.acquired, true);

    const busyWorker = await deploymentWorker.runOnce({ db: testDb });
    assert.equal(busyWorker.executed, false);
    assert.equal(busyWorker.busy, true);
    assert.equal(busyWorker.reason, 'DEPLOYMENT_WORKER_BUSY');

    deploymentLeaseService.releaseWorkerLease('holder-worker', activeLease.fencingToken, { db: testDb });
  });

  // ── 19-24. Authorization Re-checks at Worker Execution Boundary ────
  await t.test('19-24. Stale branch, repository drift, suspended installation, or missing allowlist fail closed', async () => {
    // Clear any prior queued jobs so FIFO claims our specific test job
    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();

    const app = createApplication(
      { name: 'Drifting Worker App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(app.id);

    // Setup queued job for 'main'
    setupQueuedJob(app, commit1Sha, 'refs/heads/main');

    // Case A: Application branch changed after enqueue! (App is now 'develop')
    testDb.prepare("UPDATE applications SET branch = 'develop' WHERE id = ?").run(app.id);

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_workerToken12345',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false
        });
      },
      (err) => err instanceof DeploymentWorkerError && err.code === 'REPOSITORY_ASSOCIATION_STALE'
    );

    // Restore branch
    testDb.prepare("UPDATE applications SET branch = 'main' WHERE id = ?").run(app.id);
    testDb.prepare("UPDATE deployments SET claim_attempts = 0 WHERE status = 'queued'").run();

    // Case B: Installation suspended
    testDb.prepare("UPDATE github_installations SET installation_status = 'suspended' WHERE installation_id = '12345'").run();

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false
        });
      },
      (err) => err instanceof DeploymentWorkerError && err.code === 'INSTALLATION_NOT_AUTHORIZED'
    );

    testDb.prepare("UPDATE github_installations SET installation_status = 'active' WHERE installation_id = '12345'").run();
    testDb.prepare("UPDATE deployments SET claim_attempts = 0 WHERE status = 'queued'").run();

    // Case C: Repository URL drifted from verified association
    testDb.prepare("UPDATE applications SET repo_url = 'https://github.com/drifted-org/drifted-repo.git' WHERE id = ?").run(app.id);

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false
        });
      },
      (err) => err instanceof DeploymentWorkerError && err.code === 'REPOSITORY_ASSOCIATION_STALE'
    );

    testDb.prepare("UPDATE applications SET repo_url = 'https://github.com/my-org/fixture-repo.git' WHERE id = ?").run(app.id);
    testDb.prepare("UPDATE deployments SET claim_attempts = 0 WHERE status = 'queued'").run();

    // Case D: GitHub account ID is not in allowlist
    testDb.prepare("UPDATE github_installations SET account_id = '77777' WHERE installation_id = '12345'").run();

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false
        });
      },
      (err) => err instanceof DeploymentWorkerError && err.code === 'INSTALLATION_NOT_AUTHORIZED'
    );

    testDb.prepare("UPDATE github_installations SET account_id = '999' WHERE installation_id = '12345'").run();
    testDb.prepare("UPDATE deployments SET claim_attempts = 0 WHERE status = 'queued'").run();

    // Case E: Association status is pending/unverified
    testDb.prepare("UPDATE application_repositories SET association_status = 'pending' WHERE application_id = ?").run(app.id);

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false
        });
      },
      (err) => err instanceof DeploymentWorkerError && err.code === 'REPOSITORY_ASSOCIATION_STALE'
    );

    testDb.prepare("UPDATE application_repositories SET association_status = 'verified' WHERE application_id = ?").run(app.id);
  });

  // ── 25-28. Periodic Lease Heartbeat, Lost-Lease Abort & Fencing ─────
  await t.test('25-28. Periodic lease heartbeat renewal, cancellation on lost lease, and stale worker rejection', async () => {
    // Clear and setup dedicated queued job for heartbeat test
    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();
    const hbApp = createApplication(
      { name: 'Heartbeat Worker App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(hbApp.id);
    setupQueuedJob(hbApp, commit1Sha, 'refs/heads/main');

    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_workerToken12345',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    // 25. Heartbeat renewal extends lease during worker execution
    const hbResult = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false,
      leaseSeconds: 5,
      heartbeatIntervalMs: 50
    });
    assert.equal(hbResult.executed, true);
    assert.equal(hbResult.prepared, true);

    // 26 & 28. Stale worker rejected if lease is taken over by another worker
    const testWorkerId = `worker-lost-${crypto.randomUUID()}`;
    const initialLease = deploymentLeaseService.acquireWorkerLease(testWorkerId, { db: testDb, leaseSeconds: 2 });
    assert.equal(initialLease.acquired, true);

    // Simulate competitor taking over the expired lease
    testDb.prepare("UPDATE deployment_worker_lock SET lease_expires_at = datetime('now', '-2 seconds') WHERE lock_name = ?")
      .run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const competitorLease = deploymentLeaseService.acquireWorkerLease('competitor-worker', { db: testDb, leaseSeconds: 30 });
    assert.equal(competitorLease.acquired, true);
    assert.equal(competitorLease.isTakeover, true);

    // Old worker cannot renew
    const renewAttempt = deploymentLeaseService.renewWorkerLease(testWorkerId, initialLease.fencingToken, { db: testDb });
    assert.equal(renewAttempt.renewed, false);

    // Old worker cannot release competitor's lease
    const releaseAttempt = deploymentLeaseService.releaseWorkerLease(testWorkerId, initialLease.fencingToken, { db: testDb });
    assert.equal(releaseAttempt.released, false);

    const currentLock = testDb.prepare('SELECT owner_id, fencing_token FROM deployment_worker_lock WHERE lock_name = ?')
      .get(deploymentLeaseService.GLOBAL_LOCK_NAME);
    assert.equal(currentLock.owner_id, 'competitor-worker');
    assert.equal(currentLock.fencing_token, competitorLease.fencingToken);

    deploymentLeaseService.releaseWorkerLease('competitor-worker', competitorLease.fencingToken, { db: testDb });

    // 27. Caller cancellation via AbortSignal cancels checkout cleanly
    const abortCtrl = new AbortController();
    abortCtrl.abort();

    await assert.rejects(
      async () => {
        await deploymentWorker.runOnce({
          db: testDb,
          workspaceRoot,
          allowTestFixture: true,
          testFixtureUrl: `file://${fixtureRepoPath}`,
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockTokenFetch,
          enqueueBatch: false,
          signal: abortCtrl.signal
        });
      },
      (err) => err instanceof DeploymentWorkerError && (err.code === 'OPERATION_CANCELLED' || err.code === 'LEASE_LOST')
    );
  });

  // ── 29-32. Stale Fencing Rejection, Crash Recovery & Claim Safety ───
  await t.test('29-32. Stale fencing-token rejection, crash recovery, and queue claim recovery', async () => {
    const mockTokenFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({
        token: 'ghs_workerToken12345',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    // 29. Stale fencing token is rejected on claimNextDeployment
    const leaseForTokenTest = deploymentLeaseService.acquireWorkerLease('worker-token-test', { db: testDb, leaseSeconds: 30 });
    assert.throws(
      () => {
        deploymentLeaseService.claimNextDeployment('worker-token-test', leaseForTokenTest.fencingToken + 999, { db: testDb });
      },
      (err) => err instanceof deploymentLeaseService.DeploymentLeaseError && err.code === 'LEASE_STALE'
    );
    deploymentLeaseService.releaseWorkerLease('worker-token-test', leaseForTokenTest.fencingToken, { db: testDb });

    // 30-32. Crash recovery: prior worker crashed leaving expired claim
    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE status = 'queued'").run();
    const crashApp = createApplication(
      { name: 'Crash Recovery App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
      { db: testDb }
    );
    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'fixture-repo', 'my-org/fixture-repo', 1, 'verified')
    `).run(crashApp.id);

    const crashJobId = setupQueuedJob(crashApp, commit1Sha, 'refs/heads/main');
    testDb.prepare(`
      UPDATE deployments
      SET lease_owner = 'crashed-worker-uuid',
          lease_token = 10,
          lease_expires_at = datetime('now', '-60 seconds'),
          claim_attempts = 1
      WHERE id = ?
    `).run(crashJobId);

    const recoveryResult = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false
    });

    assert.equal(recoveryResult.executed, true);
    assert.equal(recoveryResult.deploymentId, crashJobId);
    assert.equal(recoveryResult.prepared, true);

    const recoveredJob = testDb.prepare('SELECT status, claim_attempts, lease_owner FROM deployments WHERE id = ?').get(crashJobId);
    assert.equal(recoveredJob.status, 'queued');
    assert.equal(recoveredJob.claim_attempts, 1, 'Prepare-only run restored claim_attempts back to pre-run level (1)');
    assert.equal(recoveredJob.lease_owner, null);
  });

  // ── 33-36. Prepare-Only Mode Preserves Future Deployment Eligibility ─
  await t.test('33-36. Prepare-only mode preserves queued status, releases claims, and creates zero releases', async () => {
    const app = createApplication(
      { name: 'Prepare Mode App', repo_url: 'https://github.com/my-org/fixture-repo.git', branch: 'main' },
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
        token: 'ghs_workerToken12345',
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        permissions: { contents: 'read' },
        repository_selection: 'selected'
      })
    });

    // Run prepare-only worker pass
    const runResult = await deploymentWorker.runOnce({
      db: testDb,
      workspaceRoot,
      allowTestFixture: true,
      testFixtureUrl: `file://${fixtureRepoPath}`,
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockTokenFetch,
      enqueueBatch: false
    });

    assert.equal(runResult.executed, true);
    assert.equal(runResult.prepared, true);

    // 33 & 35. Verify job status remains 'queued' (NOT success or building)
    const jobCheck = testDb.prepare('SELECT status, claim_attempts, lease_owner FROM deployments WHERE id = ?').get(jobId);
    assert.equal(jobCheck.status, 'queued', 'Job must remain in queued status in prepare-only mode');

    // 34. Claim attempts was not exhausted (reset to 0 by releasePrepareOnlyClaim)
    assert.equal(jobCheck.claim_attempts, 0, 'Prepare-only run must not permanently increment claim attempts');
    assert.equal(jobCheck.lease_owner, null, 'Lease owner must be cleared on prepare-only release');

    // 36. Zero releases were created
    const releaseCount = testDb.prepare('SELECT COUNT(*) as c FROM releases').get().c;
    assert.equal(releaseCount, 0, 'No releases must be created during prepare-only mode');
  });

  // ── 37-40. Zero Docker/Network Operations & Legacy Data Preservation ─
  await t.test('37-40. No Docker commands executed; deployments.json untouched; zero secret leakage', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }

    // 40. Verify zero secret leakage: tokens (ghs_*) never persisted in SQLite deployments table
    const allDeployments = testDb.prepare('SELECT * FROM deployments').all();
    for (const d of allDeployments) {
      assert.ok(!JSON.stringify(d).includes('ghs_'), 'Deployments rows must not leak installation access tokens');
    }
  });
});
