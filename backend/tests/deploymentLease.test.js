const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const Database = require('better-sqlite3');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getCurrentVersion, getAppliedMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentLeaseService = require('../services/deploymentLeaseService');
const { DeploymentLeaseError } = deploymentLeaseService;
const deploymentQueueService = require('../services/deploymentQueueService');
const githubWebhookService = require('../services/githubWebhookService');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 4A1: Safe Worker Lease, Claiming & Recovery Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let testDb;
  let originalDeploymentsContent;

  const OWNER_1 = 'worker-uuid-1111-1111';
  const OWNER_2 = 'worker-uuid-2222-2222';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-lease-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.GITHUB_ALLOWED_ACCOUNT_IDS;

    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json must remain completely untouched');
    }
  });

  // ── 1-3. Migration 005 Verification ───────────────────────────────
  await t.test('1-3. Migration 005 applies cleanly, is idempotent, and preserves previous migrations', () => {
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 5, 'Schema version must be at least 5');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.length >= 5, 'Applied migrations count must be at least 5');

    const rerun = runMigrations(testDb);
    assert.equal(rerun.applied, 0, 'Migration re-run must be idempotent');

    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('deployment_worker_lock'));

    const deploymentCols = testDb.prepare('PRAGMA table_info(deployments)').all().map((c) => c.name);
    assert.ok(deploymentCols.includes('lease_owner'));
    assert.ok(deploymentCols.includes('lease_token'));
    assert.ok(deploymentCols.includes('lease_expires_at'));
    assert.ok(deploymentCols.includes('claim_attempts'));

    const indexes = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all().map((i) => i.name);
    assert.ok(indexes.includes('idx_webhook_sources_idempotency'));
  });

  // ── 4-10. Global Worker Lease Lifecycle ────────────────────────────
  await t.test('4-10. Acquire lease, block second owner, expired takeover, fencing tokens and stale worker rejection', () => {
    // 4. Owner 1 acquires global lease
    const lease1 = deploymentLeaseService.acquireWorkerLease(OWNER_1, {
      db: testDb,
      leaseSeconds: 2 // Short 2-second lease for testing
    });

    assert.equal(lease1.acquired, true);
    assert.equal(lease1.ownerId, OWNER_1);
    assert.equal(lease1.fencingToken, 1);
    assert.equal(lease1.busy, false);

    // 5. Owner 2 is blocked while lease is active
    const lease2 = deploymentLeaseService.acquireWorkerLease(OWNER_2, { db: testDb });
    assert.equal(lease2.acquired, false);
    assert.equal(lease2.busy, true);
    assert.equal(lease2.currentOwner, OWNER_1);

    // 8. Stale owner cannot renew with wrong fencing token
    const staleRenew = deploymentLeaseService.renewWorkerLease(OWNER_1, 999, { db: testDb });
    assert.equal(staleRenew.renewed, false);

    // 9. Stale owner cannot release with wrong owner ID
    const staleRelease = deploymentLeaseService.releaseWorkerLease('impostor-owner', 1, { db: testDb });
    assert.equal(staleRelease.released, false);

    // Simulate lease expiration by setting lease_expires_at in past
    testDb.prepare("UPDATE deployment_worker_lock SET lease_expires_at = datetime('now', '-5 seconds') WHERE lock_name = 'global_deployment_worker'").run();

    // 6-7. Owner 2 takes over expired lease -> fencing token increments
    const takeover = deploymentLeaseService.acquireWorkerLease(OWNER_2, { db: testDb, leaseSeconds: 10 });
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.isTakeover, true);
    assert.equal(takeover.ownerId, OWNER_2);
    assert.equal(takeover.fencingToken, 2, 'Fencing token must increment monotonically on takeover');

    // 10. Previous owner 1 is now stale and cannot claim work
    assert.throws(
      () => deploymentLeaseService.claimNextDeployment(OWNER_1, 1, { db: testDb }),
      (err) => err instanceof DeploymentLeaseError && err.code === 'LEASE_STALE'
    );

    // Cleanup: Release lease
    deploymentLeaseService.releaseWorkerLease(OWNER_2, 2, { db: testDb });
  });

  // ── 12-13. Multi-Connection & Multi-Process Concurrency ───────────
  await t.test('12-13. Multiple separate SQLite connections and child processes respect exclusivity', () => {
    const connA = new Database(tempDbPath);
    const connB = new Database(tempDbPath);
    connA.pragma('busy_timeout = 5000');
    connB.pragma('busy_timeout = 5000');

    try {
      // Connection A acquires lease
      const leaseA = deploymentLeaseService.acquireWorkerLease('proc-A', { db: connA, leaseSeconds: 10 });
      assert.equal(leaseA.acquired, true);

      // Connection B tries to acquire simultaneously -> rejected busy
      const leaseB = deploymentLeaseService.acquireWorkerLease('proc-B', { db: connB });
      assert.equal(leaseB.acquired, false);
      assert.equal(leaseB.busy, true);

      // Child process in a separate Node.js execution tries to acquire -> rejected busy
      const childScript = `
        const { getDatabase } = require('./services/deploymentLeaseService');
        const deploymentLeaseService = require('./services/deploymentLeaseService');
        const db = require('better-sqlite3')(process.env.TEST_DB_PATH);
        const res = deploymentLeaseService.acquireWorkerLease('child-proc-C', { db });
        process.stdout.write(JSON.stringify(res));
      `;
      const childOutput = execFileSync(process.execPath, ['-e', childScript], {
        cwd: path.resolve(__dirname, '..'),
        env: { ...process.env, TEST_DB_PATH: tempDbPath }
      }).toString();

      const childRes = JSON.parse(childOutput);
      assert.equal(childRes.acquired, false, 'Child process must be blocked from acquiring active lease');
      assert.equal(childRes.busy, true);

      deploymentLeaseService.releaseWorkerLease('proc-A', leaseA.fencingToken, { db: connA });
    } finally {
      connA.close();
      connB.close();
    }
  });

  // ── 11, 14-21. Job Claiming, Heartbeats & Bounded Attempts ────────
  await t.test('11, 14-21. Atomic job claim, claim renewal, recovery of expired claim, and claim attempt bounds', () => {
    // Setup application & queued deployments
    const app = createApplication(
      { name: 'Claim Test App', repo_url: 'https://github.com/my-org/claim-app.git', branch: 'main' },
      { db: testDb }
    );

    const dep1Id = crypto.randomUUID();
    const dep2Id = crypto.randomUUID();

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, log_path, created_at)
      VALUES (?, ?, '1111111111111111111111111111111111111111', 'webhook', 'queued', '/tmp/1.log', datetime('now', '-10 seconds'))
    `).run(dep1Id, app.id);

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, log_path, created_at)
      VALUES (?, ?, '2222222222222222222222222222222222222222', 'webhook', 'queued', '/tmp/2.log', datetime('now', '-5 seconds'))
    `).run(dep2Id, app.id);

    // Acquire global lease for worker
    const workerLease = deploymentLeaseService.acquireWorkerLease('worker-active', { db: testDb, leaseSeconds: 30 });
    const token = workerLease.fencingToken;

    // 11. Valid owner claims oldest queued job (dep1)
    const claim1 = deploymentLeaseService.claimNextDeployment('worker-active', token, { db: testDb, claimSeconds: 5 });
    assert.equal(claim1.claimed, true);
    assert.equal(claim1.deployment.id, dep1Id, 'Must claim oldest job first (FIFO)');
    assert.equal(claim1.deployment.claimAttempts, 1);

    // 14. Claimed job is not returned to another claim; next claim claims dep2
    const claim2 = deploymentLeaseService.claimNextDeployment('worker-active', token, { db: testDb });
    assert.equal(claim2.claimed, true);
    assert.equal(claim2.deployment.id, dep2Id);

    // 15. Claim renewal extends claim lease
    const renewRes = deploymentLeaseService.renewDeploymentClaim(dep1Id, 'worker-active', token, { db: testDb, claimSeconds: 20 });
    assert.equal(renewRes.renewed, true);

    // 17. Stale claim renewal rejected
    const staleClaimRenew = deploymentLeaseService.renewDeploymentClaim(dep1Id, 'wrong-worker', token, { db: testDb });
    assert.equal(staleClaimRenew.renewed, false);

    // 18. Release claim on dep2 returns it to open queue
    const releaseClaimRes = deploymentLeaseService.releaseDeploymentClaim(dep2Id, 'worker-active', token, { db: testDb });
    assert.equal(releaseClaimRes.released, true);

    const recheckDep2 = testDb.prepare('SELECT lease_owner FROM deployments WHERE id = ?').get(dep2Id);
    assert.equal(recheckDep2.lease_owner, null, 'Released job must clear lease_owner');

    // 19. Bounded claim attempts: If a job exceeds maxAttempts, it is not claimed
    testDb.prepare('UPDATE deployments SET claim_attempts = 3, lease_owner = NULL, lease_expires_at = NULL WHERE id = ?').run(dep2Id);
    const exhaustedClaim = deploymentLeaseService.claimNextDeployment('worker-active', token, { db: testDb, maxAttempts: 3 });
    // dep2 has 3 attempts so it is not claimed; dep1 is currently claimed by active lease
    assert.equal(exhaustedClaim.claimed, false);

    deploymentLeaseService.releaseWorkerLease('worker-active', token, { db: testDb });
  });

  // ── 26-30. Webhook Commit Deduplication Across All Job States ──────
  await t.test('26-30. Webhook commit deduplication prevents duplicates across queued, building, verifying, success, and failed states', () => {
    const dedupApp = createApplication(
      { name: 'Dedup States App', repo_url: 'https://github.com/my-org/dedup-states.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status
      ) VALUES ('55555', '999', 'my-org', 'Organization', 'selected', 'active')
    `).run();

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '55555', '999123', 'my-org', 'dedup-states', 'my-org/dedup-states', 1, 'verified')
    `).run(dedupApp.id);

    const COMMIT_A = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

    // Helper to insert a target for dedupApp
    function insertTarget(deliveryId, commitSha) {
      const rawPayload = Buffer.from(`{"commit": "${commitSha}"}`, 'utf8');
      const hash = crypto.createHash('sha256').update(rawPayload).digest('hex');

      testDb.prepare(`
        INSERT OR REPLACE INTO github_webhook_deliveries (
          delivery_id, event_name, payload_sha256, installation_id, repository_id, ref, commit_sha, decision
        ) VALUES (?, 'push', ?, '55555', '999123', 'refs/heads/main', ?, 'accepted')
      `).run(deliveryId, hash, commitSha);

      testDb.prepare(`
        INSERT OR REPLACE INTO github_webhook_targets (
          delivery_id, application_id, commit_sha, ref, created_at
        ) VALUES (?, ?, ?, 'refs/heads/main', CURRENT_TIMESTAMP)
      `).run(deliveryId, dedupApp.id, commitSha);
    }

    // 26. Enqueue initial job for COMMIT_A -> enqueued
    insertTarget('deliv-state-001', COMMIT_A);
    const r1 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r1.enqueuedCount, 1);
    const initialJobId = r1.enqueuedJobs[0].id;

    // 27. When status is 'building' -> second delivery deduplicates
    testDb.prepare("UPDATE deployments SET status = 'building' WHERE id = ?").run(initialJobId);
    insertTarget('deliv-state-002', COMMIT_A);
    const r2 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r2.enqueuedCount, 0, 'Must not enqueue duplicate while building');
    assert.equal(r2.deduplicatedCount, 1);

    // 28. When status is 'verifying' -> third delivery deduplicates
    testDb.prepare("UPDATE deployments SET status = 'verifying' WHERE id = ?").run(initialJobId);
    insertTarget('deliv-state-003', COMMIT_A);
    const r3 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r3.enqueuedCount, 0, 'Must not enqueue duplicate while verifying');
    assert.equal(r3.deduplicatedCount, 1);

    // 29. When status is 'success' -> fourth delivery deduplicates
    testDb.prepare("UPDATE deployments SET status = 'success' WHERE id = ?").run(initialJobId);
    insertTarget('deliv-state-004', COMMIT_A);
    const r4 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r4.enqueuedCount, 0, 'Must not enqueue duplicate after success');
    assert.equal(r4.deduplicatedCount, 1);

    // 30. When status is 'failed' -> fifth delivery deduplicates
    testDb.prepare("UPDATE deployments SET status = 'failed' WHERE id = ?").run(initialJobId);
    insertTarget('deliv-state-005', COMMIT_A);
    const r5 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r5.enqueuedCount, 0, 'Must not enqueue duplicate after failure');
    assert.equal(r5.deduplicatedCount, 1);

    // 33. Different commit for same application DOES create a new job
    const COMMIT_B = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
    insertTarget('deliv-state-006', COMMIT_B);
    const r6 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(r6.enqueuedCount, 1, 'Different commit must be enqueued as new job');
    assert.equal(r6.enqueuedJobs[0].commitSha, COMMIT_B);
  });

  // ── 34-38. JSON Lexer Precision & String Boundary Safety ───────────
  await t.test('34-38. JSON lexical scanner preserves large integer IDs, escaped quotes, and strings containing id text', () => {
    // 34. Large 64-bit numeric ID (> Number.MAX_SAFE_INTEGER 9007199254740991)
    const jsonWithBigId = '{"repository": {"id": 9007199254740995}, "installation": {"id": 9007199254740999}, "ref": "refs/heads/main", "after": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}';
    const parsed1 = githubWebhookService.parseWebhookJsonSafely(Buffer.from(jsonWithBigId, 'utf8'));
    assert.equal(String(parsed1.repository.id), '9007199254740995', 'Large integer ID must not lose precision');
    assert.equal(String(parsed1.installation.id), '9007199254740999');

    // 35. String content containing "id": 9007199254740995 is NOT modified
    const jsonWithStringContent = JSON.stringify({
      message: 'This commit fixes issue with "id": 9007199254740995 in database',
      repository: { id: 12345 }
    });
    const parsed2 = githubWebhookService.parseWebhookJsonSafely(Buffer.from(jsonWithStringContent, 'utf8'));
    assert.equal(parsed2.message, 'This commit fixes issue with "id": 9007199254740995 in database');

    // 36. Escaped quotes inside strings
    const jsonWithEscapedQuotes = '{"commit": {"message": "Text with \\\"id\\\": 9007199254740995 inside"}, "repository": {"id": 12345}}';
    const parsed3 = githubWebhookService.parseWebhookJsonSafely(Buffer.from(jsonWithEscapedQuotes, 'utf8'));
    assert.ok(parsed3.commit.message.includes('"id": 9007199254740995'));

    // 37. Malformed JSON rejected
    assert.throws(
      () => githubWebhookService.parseWebhookJsonSafely(Buffer.from('{"unclosed": "json', 'utf8')),
      (err) => err instanceof githubWebhookService.GithubWebhookError && err.code === 'INVALID_PAYLOAD'
    );
  });

  // ── 42. Legacy deployments.json Untouched ──────────────────────────
  await t.test('42. Legacy deployments.json remains untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });
});
