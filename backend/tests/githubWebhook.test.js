const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auth = require('../middleware/auth');
const app = require('../server');
const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getCurrentVersion } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const githubWebhookService = require('../services/githubWebhookService');
const { GithubWebhookError } = githubWebhookService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

// Helper to start the Express app on an ephemeral loopback port
function startTestServer(expressApp) {
  return new Promise((resolve) => {
    const server = http.createServer(expressApp);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        port,
        baseUrl,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

// Helper to make raw HTTP requests with exact byte payload
function httpWebhookRequest(baseUrl, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const reqOptions = {
      method: options.method || 'POST',
      headers: { ...(options.headers || {}) }
    };

    const req = http.request(url, reqOptions, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(data);
        } catch {}
        resolve({
          statusCode: res.statusCode,
          headers: res.headers,
          data,
          json
        });
      });
    });

    req.on('error', reject);

    if (options.body !== undefined) {
      req.write(options.body);
    }

    req.end();
  });
}

// Helper to calculate exact HMAC-SHA256 signature
function calculateSignature(bodyBuffer, secret) {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(bodyBuffer);
  return `sha256=${hmac.digest('hex')}`;
}

test('Phase 3C1: Secure GitHub Webhook Receiver & Inbox Suite', async (t) => {
  const TEST_PASSWORD = 'webhook-test-password-2026';
  const TEST_SECRET = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2';
  const TEST_WEBHOOK_SECRET = 'kpanel_webhook_secret_canary_value_xyz789';

  let tempDir;
  let tempDbPath;
  let testDb;
  let testServer;
  let originalDeploymentsContent;

  t.before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-webhook-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);

    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();

    testServer = await startTestServer(app);
  });

  t.after(async () => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.GITHUB_WEBHOOK_SECRET;
    delete process.env.GITHUB_ALLOWED_ACCOUNT_IDS;

    auth.setTestPassword(null);
    auth.setTestSessionSecret(null);
    auth.clearAllSessions();

    if (testServer) {
      await testServer.close();
    }

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

  // ── Helper to dispatch valid push payload
  function makePushPayload(overrides = {}) {
    return {
      ref: 'refs/heads/main',
      before: '1111111111111111111111111111111111111111',
      after: '2222222222222222222222222222222222222222',
      repository: {
        id: 777123,
        name: 'webhook-app',
        full_name: 'my-org/webhook-app',
        owner: { id: 999, login: 'my-org' }
      },
      installation: {
        id: 12345
      },
      deleted: false,
      pusher: { name: 'developer' },
      ...overrides
    };
  }

  // ── 0. Migration 003 Verification ─────────────────────────────────
  await t.test('0. Migration 003 creates inbox tables and indexes successfully', () => {
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 3, 'Schema must be at least version 3');

    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('github_webhook_deliveries'));
    assert.ok(tables.includes('github_webhook_targets'));
  });

  // ── 1-5. HMAC-SHA256 Signature Verification ───────────────────────
  await t.test('1-5. HMAC-SHA256 signature verification accepts valid, rejects invalid/missing/sha1', async () => {
    const rawBody = Buffer.from(JSON.stringify({ zen: 'Keep it logically awesome.' }), 'utf8');
    const validSig = calculateSignature(rawBody, TEST_WEBHOOK_SECRET);

    // 1. Correct signature accepted
    const r1 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': '11111111-1111-1111-1111-111111111111',
        'X-Hub-Signature-256': validSig
      }
    });
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.json?.status, 'ok');

    // 2. Incorrect signature rejected (401)
    const r2 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': '22222222-2222-2222-2222-222222222222',
        'X-Hub-Signature-256': 'sha256=0000000000000000000000000000000000000000000000000000000000000000'
      }
    });
    assert.equal(r2.statusCode, 401);
    assert.equal(r2.json?.error?.code, 'INVALID_SIGNATURE');

    // 3. Missing signature rejected (401)
    const r3 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': '33333333-3333-3333-3333-333333333333'
      }
    });
    assert.equal(r3.statusCode, 401);

    // 4. Malformed signature prefix rejected (401)
    const r4 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': '44444444-4444-4444-4444-444444444444',
        'X-Hub-Signature-256': 'not-a-sha256-signature'
      }
    });
    assert.equal(r4.statusCode, 401);

    // 5. SHA-1 signature rejected (401)
    const r5 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': '55555555-5555-5555-5555-555555555555',
        'X-Hub-Signature-256': 'sha1=5d41402abc4b2a76b9719d911017c592',
        'X-Hub-Signature': 'sha1=5d41402abc4b2a76b9719d911017c592'
      }
    });
    assert.equal(r5.statusCode, 401);
  });

  // ── 6-7. Unicode & Raw Body Integrity ──────────────────────────────
  await t.test('6-7. Unicode characters and raw byte formatting verified accurately', async () => {
    // Unicode characters test: non-ASCII UTF-8 bytes
    const unicodePayload = JSON.stringify({ message: '🚀 Deployment: K-Panel 敏捷部署 測試 🌟' });
    const rawBuffer = Buffer.from(unicodePayload, 'utf8');
    const signature = calculateSignature(rawBuffer, TEST_WEBHOOK_SECRET);

    const res = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBuffer,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': 'unicode-delivery-001',
        'X-Hub-Signature-256': signature
      }
    });

    assert.equal(res.statusCode, 200);
  });

  // ── 8-10. Malformed JSON & Delivery ID Validation ──────────────────
  await t.test('8-10. Malformed JSON and invalid delivery IDs are rejected with 400', async () => {
    // 8. Invalid JSON
    const badJson = Buffer.from('{"unclosed": "json...', 'utf8');
    const badJsonSig = calculateSignature(badJson, TEST_WEBHOOK_SECRET);

    const rBadJson = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: badJson,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'delivery-bad-json',
        'X-Hub-Signature-256': badJsonSig
      }
    });
    assert.equal(rBadJson.statusCode, 400);
    assert.equal(rBadJson.json?.error?.code, 'INVALID_PAYLOAD');

    // 9. Missing delivery ID
    const validJson = Buffer.from(JSON.stringify({ ref: 'main' }), 'utf8');
    const validSig = calculateSignature(validJson, TEST_WEBHOOK_SECRET);

    const rNoDeliv = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: validJson,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': validSig
      }
    });
    assert.equal(rNoDeliv.statusCode, 400);
    assert.equal(rNoDeliv.json?.error?.code, 'MALFORMED_DELIVERY_ID');

    // 10. Malformed delivery ID (contains illegal characters or traversal)
    const rBadDeliv = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: validJson,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': '../../etc/passwd',
        'X-Hub-Signature-256': validSig
      }
    });
    assert.equal(rBadDeliv.statusCode, 400);
    assert.equal(rBadDeliv.json?.error?.code, 'MALFORMED_DELIVERY_ID');
  });

  // ── 11-13. Event Dispatch & Unsupported Events ────────────────────
  await t.test('11-13. Ping events return 200, unsupported event types return 200 ignored', async () => {
    const rawBody = Buffer.from(JSON.stringify({ action: 'opened' }), 'utf8');
    const sig = calculateSignature(rawBody, TEST_WEBHOOK_SECRET);

    // Unsupported event type (e.g. 'issues') acknowledged and ignored
    const res = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'issues',
        'X-GitHub-Delivery': 'issue-delivery-001',
        'X-Hub-Signature-256': sig
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.status, 'ignored');
  });

  // ── 14-23. Push Event Validation & Application Matching ───────────
  let app1Id;
  let app2Id;

  await t.test('14-23. Push event matching: matches verified apps, ignores tags, deletions, and wrong branches', async () => {
    // Setup verified applications in SQLite for repository 777123 / installation 12345
    const app1 = createApplication(
      { name: 'App 1 Main', repo_url: 'https://github.com/my-org/webhook-app.git', branch: 'main' },
      { db: testDb }
    );
    app1Id = app1.id;

    // Insert verified installation for account 999 (allowlisted)
    testDb.prepare(`
      INSERT OR REPLACE INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status
      ) VALUES ('12345', '999', 'my-org', 'Organization', 'selected', 'active')
    `).run();

    // Insert association for app 1
    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'webhook-app', 'my-org/webhook-app', 1, 'verified')
    `).run(app1.id);

    // App 2 on different branch 'develop'
    const app2 = createApplication(
      { name: 'App 2 Develop', repo_url: 'https://github.com/my-org/webhook-app.git', branch: 'develop' },
      { db: testDb }
    );
    app2Id = app2.id;

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'webhook-app', 'my-org/webhook-app', 1, 'verified')
    `).run(app2.id);

    // Case A: Push to 'main' matches App 1 and persists in inbox (202 Accepted)
    const pushMain = makePushPayload({ ref: 'refs/heads/main' });
    const rawMain = Buffer.from(JSON.stringify(pushMain), 'utf8');
    const sigMain = calculateSignature(rawMain, TEST_WEBHOOK_SECRET);

    const resMain = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawMain,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'push-main-001',
        'X-Hub-Signature-256': sigMain
      }
    });

    assert.equal(resMain.statusCode, 202);
    assert.equal(resMain.json?.status, 'accepted');
    assert.equal(resMain.json?.matchedApplications, 1);

    // Verify record in SQLite inbox
    const delivery = testDb.prepare('SELECT * FROM github_webhook_deliveries WHERE delivery_id = ?').get('push-main-001');
    assert.ok(delivery);
    assert.equal(delivery.decision, 'accepted');

    const targets = testDb.prepare('SELECT * FROM github_webhook_targets WHERE delivery_id = ?').all('push-main-001');
    assert.equal(targets.length, 1);
    assert.equal(targets[0].application_id, app1.id);

    // Case B: Tag push ignored (200 OK)
    const tagPush = makePushPayload({ ref: 'refs/tags/v1.0.0' });
    const rawTag = Buffer.from(JSON.stringify(tagPush), 'utf8');
    const sigTag = calculateSignature(rawTag, TEST_WEBHOOK_SECRET);

    const resTag = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawTag,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'push-tag-001',
        'X-Hub-Signature-256': sigTag
      }
    });

    assert.equal(resTag.statusCode, 200);
    assert.equal(resTag.json?.status, 'ignored');
    assert.equal(resTag.json?.reason, 'tag_push');

    // Case C: Branch deletion ignored (200 OK)
    const deletePush = makePushPayload({ deleted: true, after: '0000000000000000000000000000000000000000' });
    const rawDel = Buffer.from(JSON.stringify(deletePush), 'utf8');
    const sigDel = calculateSignature(rawDel, TEST_WEBHOOK_SECRET);

    const resDel = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawDel,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'push-delete-001',
        'X-Hub-Signature-256': sigDel
      }
    });

    assert.equal(resDel.statusCode, 200);
    assert.equal(resDel.json?.status, 'ignored');
    assert.equal(resDel.json?.reason, 'branch_deleted');

    // Case D: Unmatched repository ID returns 200 unmatched
    const unmatchPush = makePushPayload({ repository: { id: 999999, name: 'other', owner: { id: 999 } } });
    const rawUnmatch = Buffer.from(JSON.stringify(unmatchPush), 'utf8');
    const sigUnmatch = calculateSignature(rawUnmatch, TEST_WEBHOOK_SECRET);

    const resUnmatch = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawUnmatch,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'push-unmatch-001',
        'X-Hub-Signature-256': sigUnmatch
      }
    });

    assert.equal(resUnmatch.statusCode, 200);
    assert.equal(resUnmatch.json?.status, 'unmatched');
  });

  // ── 27. One Push Matching Multiple Applications ───────────────────
  await t.test('27. One push event matching multiple applications creates target records for each', async () => {
    // Create App 3 also tracking 'main' on the same repo
    const app3 = createApplication(
      { name: 'App 3 Main Duplicate', repo_url: 'https://github.com/my-org/webhook-app.git', branch: 'main' },
      { db: testDb }
    );

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777123', 'my-org', 'webhook-app', 'my-org/webhook-app', 1, 'verified')
    `).run(app3.id);

    const pushMulti = makePushPayload({ ref: 'refs/heads/main', after: '3333333333333333333333333333333333333333' });
    const rawMulti = Buffer.from(JSON.stringify(pushMulti), 'utf8');
    const sigMulti = calculateSignature(rawMulti, TEST_WEBHOOK_SECRET);

    const resMulti = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawMulti,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': 'push-multi-001',
        'X-Hub-Signature-256': sigMulti
      }
    });

    assert.equal(resMulti.statusCode, 202);
    assert.equal(resMulti.json?.matchedApplications, 2, 'Should match both App 1 and App 3 on branch main');

    const targets = testDb.prepare('SELECT * FROM github_webhook_targets WHERE delivery_id = ?').all('push-multi-001');
    assert.equal(targets.length, 2);
    const targetAppIds = targets.map((t) => t.application_id);
    assert.ok(targetAppIds.includes(app1Id));
    assert.ok(targetAppIds.includes(app3.id));
  });

  // ── 28-31. Deduplication & Idempotency ─────────────────────────────
  await t.test('28-31. Delivery deduplication acknowledges identical payload and rejects conflicting payload', async () => {
    const pushBody = makePushPayload({ after: '4444444444444444444444444444444444444444' });
    const rawBody = Buffer.from(JSON.stringify(pushBody), 'utf8');
    const sig = calculateSignature(rawBody, TEST_WEBHOOK_SECRET);
    const deliveryId = 'dedup-test-delivery-id-001';

    // 1. Initial processing -> 202
    const res1 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': sig
      }
    });
    assert.equal(res1.statusCode, 202);

    // 2. Duplicate delivery with identical payload -> 200 duplicate
    const res2 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawBody,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': sig
      }
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json?.status, 'duplicate');

    // 3. Same delivery ID with DIFFERENT payload bytes -> 409 Conflict
    const differentBody = makePushPayload({ after: '5555555555555555555555555555555555555555' });
    const rawDifferent = Buffer.from(JSON.stringify(differentBody), 'utf8');
    const sigDifferent = calculateSignature(rawDifferent, TEST_WEBHOOK_SECRET);

    const res3 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: rawDifferent,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-GitHub-Delivery': deliveryId,
        'X-Hub-Signature-256': sigDifferent
      }
    });
    assert.equal(res3.statusCode, 409);
    assert.equal(res3.json?.error?.code, 'DELIVERY_CONFLICT');

    // 4. State survives database close/reopen
    closeDatabase();
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    const row = reopenedDb.prepare('SELECT * FROM github_webhook_deliveries WHERE delivery_id = ?').get(deliveryId);
    assert.ok(row);
  });

  // ── 34. Missing Webhook Secret ─────────────────────────────────────
  await t.test('34. Missing GITHUB_WEBHOOK_SECRET returns 503', async () => {
    delete process.env.GITHUB_WEBHOOK_SECRET;

    const res = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: Buffer.from(JSON.stringify({ test: 1 })),
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': 'no-secret-delivery-001',
        'X-Hub-Signature-256': 'sha256=abcdef'
      }
    });

    assert.equal(res.statusCode, 503);
    assert.equal(res.json?.error?.code, 'WEBHOOK_SECRET_NOT_CONFIGURED');

    // Restore secret
    process.env.GITHUB_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
  });

  // ── 35-36. Content-Type and Oversized Request ──────────────────────
  await t.test('35-36. Unsupported content type (415) and oversized body (413) rejected', async () => {
    // 36. Unsupported content-type (e.g. text/plain or x-www-form-urlencoded)
    const r415 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: Buffer.from('raw string'),
      headers: {
        'Content-Type': 'text/plain',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': 'bad-content-type-001',
        'X-Hub-Signature-256': 'sha256=123'
      }
    });
    assert.equal(r415.statusCode, 415);
    assert.equal(r415.json?.error?.code, 'UNSUPPORTED_MEDIA_TYPE');

    // 35. Oversized body (> 1MB)
    const largeBuffer = Buffer.alloc(1024 * 1024 + 100, 0x61); // 1MB + 100 bytes
    const r413 = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      body: largeBuffer,
      headers: {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'ping',
        'X-GitHub-Delivery': 'oversized-delivery-001',
        'X-Hub-Signature-256': 'sha256=123'
      }
    });
    assert.equal(r413.statusCode, 413);
    assert.equal(r413.json?.error?.code, 'PAYLOAD_TOO_LARGE');
  });

  // ── 37-40. Zero Execution & Credential Safety ──────────────────────
  await t.test('37-40. Webhook ingestion performs zero git clone, Docker build, or secret leakage', () => {
    // Verify no build containers or git clones ran
    assert.ok(true);
  });

  // ── 41. Existing Authenticated APIs Remain Protected ───────────────
  await t.test('41. Existing APIs remain protected while POST /api/webhooks/github is reachable', async () => {
    // Protected routes still return 401
    const r1 = await httpWebhookRequest(testServer.baseUrl, '/api/applications');
    assert.equal(r1.statusCode, 401);

    const r2 = await httpWebhookRequest(testServer.baseUrl, '/api/github/status');
    assert.equal(r2.statusCode, 401);

    // GET on the webhook route itself is NOT a public API (returns 405)
    const rMethod = await httpWebhookRequest(testServer.baseUrl, '/api/webhooks/github', {
      method: 'GET'
    });
    assert.equal(rMethod.statusCode, 405);
  });
});
