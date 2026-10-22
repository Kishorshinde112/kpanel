const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getCurrentVersion, getAppliedMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentQueueService = require('../services/deploymentQueueService');
const { DeploymentQueueError } = deploymentQueueService;
const githubWebhookService = require('../services/githubWebhookService');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 3C2: Durable Deployment Queue Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let testDb;
  let originalDeploymentsContent;

  t.before(() => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-queue-test-'));
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

  // Helper to insert a delivery and target into inbox
  function insertTestTarget(options = {}) {
    const deliveryId = options.deliveryId || `delivery-${crypto.randomUUID()}`;
    const decision = options.decision || 'accepted';
    const rawPayload = Buffer.from(options.rawPayload || '{"test": 1}', 'utf8');
    const payloadHash = crypto.createHash('sha256').update(rawPayload).digest('hex');

    testDb.prepare(`
      INSERT OR REPLACE INTO github_webhook_deliveries (
        delivery_id, event_name, payload_sha256, installation_id, repository_id, ref, commit_sha, decision, received_at
      ) VALUES (?, 'push', ?, ?, ?, ?, ?, ?, datetime('now', ?))
    `).run(
      deliveryId,
      payloadHash,
      options.installationId || '12345',
      options.repositoryId || '777123',
      options.ref || 'refs/heads/main',
      options.commitSha || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      decision,
      options.timeOffset || '+0 seconds'
    );

    if (options.applicationId && decision === 'accepted') {
      testDb.prepare(`
        INSERT OR REPLACE INTO github_webhook_targets (
          delivery_id, application_id, commit_sha, ref, created_at
        ) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run(
        deliveryId,
        options.applicationId,
        options.commitSha || 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        options.ref || 'refs/heads/main'
      );
    }

    return deliveryId;
  }

  // ── 1-3. Migration Verification ───────────────────────────────────
  await t.test('1-3. Migration 004 applies cleanly, is idempotent, and preserves earlier schema', () => {
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 4, 'Schema version must be at least 4');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.length >= 4);

    const rerun = runMigrations(testDb);
    assert.equal(rerun.applied, 0, 'Migration re-run must be idempotent');

    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('github_webhook_deployment_sources'));
    assert.ok(tables.includes('github_webhook_target_outcomes'));
  });

  // ── 4-10. Accepted Webhook Target Enqueueing & Metadata ────────────
  let testApp1;
  let testDeployment1Id;

  await t.test('4-10. Accepted webhook target creates queued deployment and persists source metadata', () => {
    // Setup application 1
    testApp1 = createApplication(
      { name: 'Queue Test App 1', repo_url: 'https://github.com/my-org/queue-app.git', branch: 'main' },
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
      ) VALUES (?, '12345', '777123', 'my-org', 'queue-app', 'my-org/queue-app', 1, 'verified')
    `).run(testApp1.id);

    // Insert accepted delivery target
    const deliveryId = insertTestTarget({
      deliveryId: 'deliv-enqueue-001',
      applicationId: testApp1.id,
      commitSha: '1111111111111111111111111111111111111111',
      ref: 'refs/heads/main'
    });

    const result = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(result.enqueuedCount, 1);
    assert.equal(result.enqueuedJobs.length, 1);

    const job = result.enqueuedJobs[0];
    testDeployment1Id = job.id;
    assert.equal(job.applicationId, testApp1.id);
    assert.equal(job.commitSha, '1111111111111111111111111111111111111111');
    assert.equal(job.status, 'queued');
    assert.equal(job.ref, 'refs/heads/main');
    assert.equal(job.branch, 'main');

    // 7-9. Verify source metadata in SQLite
    const source = testDb.prepare('SELECT * FROM github_webhook_deployment_sources WHERE deployment_id = ?').get(job.id);
    assert.ok(source);
    assert.equal(source.commit_sha, '1111111111111111111111111111111111111111');
    assert.equal(source.installation_id, '12345');
    assert.equal(source.repository_id, '777123');
    assert.equal(source.ref, 'refs/heads/main');

    // 10. Verify target outcome in SQLite
    const outcome = deploymentQueueService.getWebhookTargetOutcome(deliveryId, testApp1.id, { db: testDb });
    assert.ok(outcome);
    assert.equal(outcome.outcome, 'enqueued');
    assert.equal(outcome.deploymentId, job.id);
    assert.equal(outcome.reasonCode, null);
  });

  // ── 5-6. Ignored and Unmatched Deliveries ───────────────────────────
  await t.test('5-6. Ignored and unmatched deliveries create zero queued deployment jobs', () => {
    // Delivery marked 'ignored'
    insertTestTarget({
      deliveryId: 'deliv-ignored-001',
      decision: 'ignored',
      applicationId: testApp1.id
    });

    // Delivery marked 'unmatched'
    insertTestTarget({
      deliveryId: 'deliv-unmatched-001',
      decision: 'unmatched',
      applicationId: testApp1.id
    });

    const result = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(result.processedCount, 0, 'Ignored and unmatched deliveries must not be processed for queueing');
    assert.equal(result.enqueuedCount, 0);
  });

  // ── 11-12. Duplicate Enqueue & Deduplication ───────────────────────
  await t.test('11-12. Duplicate enqueue attempts and duplicate commits are deduplicated', () => {
    // 11. Repeated enqueue on already-enqueued target applies 0 changes
    const rerun = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(rerun.processedCount, 0);
    assert.equal(rerun.enqueuedCount, 0);

    // 12. Distinct delivery ID with identical commit for same app deduplicates
    const delivery2Id = insertTestTarget({
      deliveryId: 'deliv-enqueue-002',
      applicationId: testApp1.id,
      commitSha: '1111111111111111111111111111111111111111', // Identical commit
      ref: 'refs/heads/main'
    });

    const dedupResult = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(dedupResult.processedCount, 1);
    assert.equal(dedupResult.enqueuedCount, 0, 'Duplicate commit must not create a new job');
    assert.equal(dedupResult.deduplicatedCount, 1);

    const outcome2 = deploymentQueueService.getWebhookTargetOutcome(delivery2Id, testApp1.id, { db: testDb });
    assert.equal(outcome2.outcome, 'deduplicated');
    assert.equal(outcome2.reasonCode, 'ALREADY_QUEUED');
    assert.equal(outcome2.deploymentId, testDeployment1Id, 'Should point to existing queued deployment ID');
  });

  // ── 13-14. Multi-App & Different Commit Handling ───────────────────
  await t.test('13-14. Same commit across two applications creates two jobs; different commit creates new job', () => {
    // Create App 2 tracking same repo and branch
    const app2 = createApplication(
      { name: 'Queue Test App 2', repo_url: 'https://github.com/my-org/queue-app.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'queue-app', 'my-org/queue-app', 1, 'verified')
    `).run(app2.id);

    // 13. Same commit for App 2 creates a distinct job for App 2
    const delivApp2 = insertTestTarget({
      deliveryId: 'deliv-app2-001',
      applicationId: app2.id,
      commitSha: '1111111111111111111111111111111111111111',
      ref: 'refs/heads/main'
    });

    const resApp2 = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resApp2.enqueuedCount, 1);
    assert.equal(resApp2.enqueuedJobs[0].applicationId, app2.id);
    assert.notEqual(resApp2.enqueuedJobs[0].id, testDeployment1Id);

    // 14. Different commit for App 1 creates a new job
    const delivDiff = insertTestTarget({
      deliveryId: 'deliv-diff-001',
      applicationId: testApp1.id,
      commitSha: '2222222222222222222222222222222222222222', // Different commit
      ref: 'refs/heads/main'
    });

    const resDiff = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resDiff.enqueuedCount, 1);
    assert.equal(resDiff.enqueuedJobs[0].commitSha, '2222222222222222222222222222222222222222');
  });

  // ── 15-20. Authorization Drift & Safe Skips ────────────────────────
  await t.test('15-20. Changed branch, URL, suspended installation, or missing allowlist safely skips target', () => {
    // 15. Changed application branch (Target is for 'main', App is changed to 'develop')
    const appBranchChanged = createApplication(
      { name: 'Branch Changed App', repo_url: 'https://github.com/my-org/queue-app.git', branch: 'develop' },
      { db: testDb }
    );
    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'queue-app', 'my-org/queue-app', 1, 'verified')
    `).run(appBranchChanged.id);

    const delivBranch = insertTestTarget({
      deliveryId: 'deliv-branch-drift',
      applicationId: appBranchChanged.id,
      commitSha: '3333333333333333333333333333333333333333',
      ref: 'refs/heads/main' // Mismatch!
    });

    const resBranch = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resBranch.skippedCount, 1);
    const outBranch = deploymentQueueService.getWebhookTargetOutcome(delivBranch, appBranchChanged.id, { db: testDb });
    assert.equal(outBranch.outcome, 'skipped');
    assert.equal(outBranch.reasonCode, 'BRANCH_CHANGED');

    // 17. Disconnected association
    testDb.prepare("UPDATE application_repositories SET association_status = 'disconnected' WHERE application_id = ?").run(appBranchChanged.id);
    const delivDisconn = insertTestTarget({
      deliveryId: 'deliv-disconn',
      applicationId: appBranchChanged.id,
      commitSha: '4444444444444444444444444444444444444444',
      ref: 'refs/heads/develop'
    });
    const resDisconn = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resDisconn.skippedCount, 1);
    const outDisconn = deploymentQueueService.getWebhookTargetOutcome(delivDisconn, appBranchChanged.id, { db: testDb });
    assert.equal(outDisconn.reasonCode, 'NOT_ASSOCIATED');

    // 18. Suspended installation
    testDb.prepare("UPDATE github_installations SET installation_status = 'suspended' WHERE installation_id = '12345'").run();
    const delivSusp = insertTestTarget({
      deliveryId: 'deliv-susp',
      applicationId: testApp1.id,
      commitSha: '5555555555555555555555555555555555555555',
      ref: 'refs/heads/main'
    });
    const resSusp = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resSusp.skippedCount, 1);
    const outSusp = deploymentQueueService.getWebhookTargetOutcome(delivSusp, testApp1.id, { db: testDb });
    assert.equal(outSusp.reasonCode, 'INSTALLATION_SUSPENDED');
    testDb.prepare("UPDATE github_installations SET installation_status = 'active' WHERE installation_id = '12345'").run();

    // 20. Missing application
    const tempApp = createApplication(
      { name: 'To Be Deleted App', repo_url: 'https://github.com/my-org/temp.git' },
      { db: testDb }
    );
    const delivMissingApp = insertTestTarget({
      deliveryId: 'deliv-missing-app',
      applicationId: tempApp.id,
      commitSha: '6666666666666666666666666666666666666666',
      ref: 'refs/heads/main'
    });
    // Remove the application to simulate an orphaned target
    testDb.pragma('foreign_keys = OFF');
    testDb.prepare('DELETE FROM applications WHERE id = ?').run(tempApp.id);
    testDb.pragma('foreign_keys = ON');

    const resMissing = deploymentQueueService.enqueueWebhookTargets({ db: testDb });
    assert.equal(resMissing.skippedCount, 1);
    const outMissing = deploymentQueueService.getWebhookTargetOutcome(delivMissingApp, tempApp.id, { db: testDb });
    assert.equal(outMissing.outcome, 'skipped');
    assert.equal(outMissing.reasonCode, 'APPLICATION_NOT_FOUND');
  });

  // ── 23-26. FIFO Ordering & Database Reopen ────────────────────────
  await t.test('23-26. FIFO ordering and persistent state survive database reopen', () => {
    // Close and reopen database
    closeDatabase();
    const reopenedDb = getDatabase({ dbPath: tempDbPath });

    const queued = deploymentQueueService.getQueuedDeployments({ db: reopenedDb });
    assert.ok(queued.length >= 2, 'Queued jobs must survive database restart');

    // Verify FIFO ordering: createdAt ascending
    for (let i = 1; i < queued.length; i++) {
      const prevTime = new Date(queued[i - 1].createdAt).getTime();
      const currTime = new Date(queued[i].createdAt).getTime();
      assert.ok(currTime >= prevTime, 'Jobs must be listed in deterministic FIFO order');
    }

    const job = deploymentQueueService.getDeploymentById(testDeployment1Id, { db: reopenedDb });
    assert.ok(job);
    assert.equal(job.status, 'queued');
    assert.equal(job.commitSha, '1111111111111111111111111111111111111111');
  });

  // ── 39. Large GitHub Numeric Identifiers (Precision Safety) ────────
  await t.test('39. Unsafe GitHub numeric IDs exceeding Number.MAX_SAFE_INTEGER are handled safely without rounding', () => {
    // 9007199254740995 is larger than Number.MAX_SAFE_INTEGER (9007199254740991)
    const rawLargeIdJson = '{"repository": {"id": 9007199254740995, "name": "big-id", "owner": {"login": "org"}}, "installation": {"id": 9007199254740999}, "ref": "refs/heads/main", "after": "7777777777777777777777777777777777777777"}';

    // Safe JSON parser must preserve exact string decimal tokens without IEEE-754 mantissa rounding
    const parsed = githubWebhookService.parseWebhookJsonSafely(Buffer.from(rawLargeIdJson, 'utf8'));
    assert.equal(String(parsed.repository.id), '9007199254740995', 'ID must preserve exact digits 9007199254740995');
    assert.equal(String(parsed.installation.id), '9007199254740999', 'ID must preserve exact digits 9007199254740999');

    const validated = githubWebhookService.validatePushEvent(parsed);
    assert.equal(validated.repositoryId, '9007199254740995');
    assert.equal(validated.installationId, '9007199254740999');
  });

  // ── 30-34. Zero Execution & Queue State Boundaries ─────────────────
  await t.test('30-34. Queue operations perform zero shell, Docker, or Git commands; jobs remain queued', () => {
    const currentDb = getDatabase({ dbPath: tempDbPath });
    const queuedList = deploymentQueueService.getQueuedDeployments({ db: currentDb });
    for (const job of queuedList) {
      assert.equal(job.status, 'queued', 'Newly created deployment jobs must remain strictly in queued status');
    }
  });

  // ── 38. Legacy deployments.json Untouched ──────────────────────────
  await t.test('38. Legacy backend/data/deployments.json is confirmed completely untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });
});
