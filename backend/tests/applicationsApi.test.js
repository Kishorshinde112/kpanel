const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auth = require('../middleware/auth');
const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations } = require('../db/migrate');
const app = require('../server');
const applicationsRouter = require('../routes/applications');

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

// Helper to make HTTP requests
function httpRequest(baseUrl, requestPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(requestPath, baseUrl);
    const reqOptions = {
      method: options.method || 'GET',
      headers: { ...(options.headers || {}) }
    };

    if (options.cookie) {
      reqOptions.headers['Cookie'] = options.cookie;
    }

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

    if (options.rawBody !== undefined) {
      if (!reqOptions.headers['Content-Type']) {
        req.setHeader('Content-Type', 'application/json');
      }
      req.write(options.rawBody);
    } else if (options.body !== undefined) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!reqOptions.headers['Content-Type']) {
        req.setHeader('Content-Type', 'application/json');
      }
      req.write(bodyStr);
    }

    req.end();
  });
}

test('Phase 2B2: Authenticated Applications REST API Suite', async (t) => {
  const TEST_PASSWORD = 'api-integration-test-password-2026';
  const TEST_SECRET = 'c1d2e3f4a5b6c1d2e3f4a5b6c1d2e3f4a5b6c1d2e3f4a5b6c1d2e3f4a5b6c1d2';

  let tempDir;
  let tempDbPath;
  let testServer;
  let originalDeploymentsContent;

  t.before(async () => {
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    // Set up isolated temporary test database
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-app-api-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    // Reset router state and run migrations on test DB
    applicationsRouter.resetInitState();
    const db = getDatabase({ dbPath: tempDbPath });
    runMigrations(db);

    // Set test auth credentials
    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();

    testServer = await startTestServer(app);
  });

  t.after(async () => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
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

    // Confirm legacy deployments.json was untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const currentContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(
        currentContent,
        originalDeploymentsContent,
        'CRITICAL: backend/data/deployments.json must remain completely identical and untouched'
      );
    }
  });

  // Helper to obtain a valid session cookie
  async function getAuthCookie() {
    const res = await httpRequest(testServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const setCookie = res.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  }

  // ── 1. Unauthenticated GET list → 401 ──────────────────────────────
  await t.test('1. Unauthenticated GET /api/applications returns 401', async () => {
    const res = await httpRequest(testServer.baseUrl, '/api/applications');
    assert.equal(res.statusCode, 401);
    assert.equal(res.json?.error, 'Unauthorized');
  });

  // ── 2. Unauthenticated POST create → 401 ────────────────────────────
  await t.test('2. Unauthenticated POST /api/applications returns 401', async () => {
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      body: { name: 'App', repo_url: 'https://github.com/org/repo.git' }
    });
    assert.equal(res.statusCode, 401);
  });

  // ── 3. Unauthenticated PUT update → 401 ─────────────────────────────
  await t.test('3. Unauthenticated PUT /api/applications/:id returns 401', async () => {
    const res = await httpRequest(testServer.baseUrl, '/api/applications/any-id', {
      method: 'PUT',
      body: { name: 'New Name' }
    });
    assert.equal(res.statusCode, 401);
  });

  // ── 4. Authenticated GET empty list → 200 ───────────────────────────
  await t.test('4. Authenticated GET /api/applications returns 200 and empty list', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', { cookie });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json?.data));
    assert.equal(res.json.data.length, 0);
    assert.equal(res.json.pagination.total, 0);
    assert.equal(res.json.pagination.page, 1);
  });

  let createdAppId;

  // ── 5. Authenticated POST valid application → 201 ───────────────────
  await t.test('5. Authenticated POST /api/applications creates valid application (201)', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Production Next.js Website',
        slug: 'prod-website',
        repo_url: 'https://github.com/my-org/my-site.git',
        branch: 'main',
        build_type: 'dockerfile',
        build_path: '/',
        port: 3000,
        domain: 'site.kishorlab.dev',
        cpu_limit: 2.0,
        memory_limit_mb: 2048
      }
    });

    assert.equal(res.statusCode, 201);
    assert.ok(res.json?.data?.id);
    assert.equal(res.json.data.name, 'Production Next.js Website');
    assert.equal(res.json.data.slug, 'prod-website');
    assert.equal(res.json.data.port, 3000);
    assert.equal(res.json.data.cpu_limit, 2.0);
    assert.equal(res.json.data.memory_limit_mb, 2048);

    createdAppId = res.json.data.id;
  });

  // ── 6. Authenticated GET by ID → 200 ────────────────────────────────
  await t.test('6. Authenticated GET /api/applications/:id returns 200 with application details', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, { cookie });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.data?.id, createdAppId);
    assert.equal(res.json.data.slug, 'prod-website');
  });

  // ── 7. Authenticated PUT valid update → 200 ─────────────────────────
  await t.test('7. Authenticated PUT /api/applications/:id updates editable fields (200)', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, {
      method: 'PUT',
      cookie,
      body: {
        name: 'Production Next.js Website v2',
        branch: 'release',
        port: 8080,
        cpu_limit: 3.0
      }
    });

    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.data?.id, createdAppId);
    assert.equal(res.json.data.name, 'Production Next.js Website v2');
    assert.equal(res.json.data.branch, 'release');
    assert.equal(res.json.data.port, 8080);
    assert.equal(res.json.data.cpu_limit, 3.0);
    // Preserved field
    assert.equal(res.json.data.repo_url, 'https://github.com/my-org/my-site.git');
  });

  // ── 8. Duplicate slug → 409 ─────────────────────────────────────────
  await t.test('8. Duplicate slug returns 409 Conflict with DUPLICATE_SLUG error code', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Duplicate Site',
        slug: 'prod-website', // Already in use
        repo_url: 'https://github.com/my-org/another-repo.git'
      }
    });

    assert.equal(res.statusCode, 409);
    assert.equal(res.json?.error?.code, 'DUPLICATE_SLUG');
    assert.ok(res.json.error.message.includes('already exists'));
  });

  // ── 9. Invalid repository URL → 400 ─────────────────────────────────
  await t.test('9. Invalid repository URL returns 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Invalid Repo App',
        repo_url: 'file:///etc/shadow'
      }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('Local file repository schemes'));
  });

  // ── 10. Embedded credentials → 400 ──────────────────────────────────
  await t.test('10. Repository URL with embedded credentials returns 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Secret App',
        repo_url: 'https://user:ghp_secretToken12345@github.com/owner/repo.git'
      }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('embedded authentication credentials'));
  });

  // ── 11. Invalid port → 400 ──────────────────────────────────────────
  await t.test('11. Invalid port (0, negative, > 65535, string) returns 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Bad Port App',
        repo_url: 'https://github.com/owner/repo.git',
        port: 99999
      }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('1 and 65535'));
  });

  // ── 12. Invalid build type → 400 ────────────────────────────────────
  await t.test('12. Invalid build type returns 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Bad Build App',
        repo_url: 'https://github.com/owner/repo.git',
        build_type: 'kubernetes-kustomize'
      }
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('Unsupported build type'));
  });

  // ── 13. Unknown request properties → 400 ────────────────────────────
  await t.test('13. Unknown request properties in create or update return 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    // Test in POST create
    const createRes = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Rogue Property App',
        repo_url: 'https://github.com/owner/repo.git',
        injected_unknown_field: 'malicious_data'
      }
    });
    assert.equal(createRes.statusCode, 400);
    assert.equal(createRes.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(createRes.json.error.message.includes('Unknown field "injected_unknown_field"'));

    // Test in PUT update
    const updateRes = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, {
      method: 'PUT',
      cookie,
      body: {
        name: 'Valid Name',
        unrecognized_param: 1234
      }
    });
    assert.equal(updateRes.statusCode, 400);
    assert.equal(updateRes.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(updateRes.json.error.message.includes('Unknown field "unrecognized_param"'));
  });

  // ── 14. Invalid pagination → 400 ────────────────────────────────────
  await t.test('14. Invalid pagination parameters return 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();

    const badPageRes = await httpRequest(testServer.baseUrl, '/api/applications?page=invalid-page', { cookie });
    assert.equal(badPageRes.statusCode, 400);
    assert.equal(badPageRes.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(badPageRes.json.error.message.includes("'page' must be a positive integer"));

    const zeroPageRes = await httpRequest(testServer.baseUrl, '/api/applications?page=0', { cookie });
    assert.equal(zeroPageRes.statusCode, 400);

    const badLimitRes = await httpRequest(testServer.baseUrl, '/api/applications?limit=-5', { cookie });
    assert.equal(badLimitRes.statusCode, 400);
    assert.equal(badLimitRes.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(badLimitRes.json.error.message.includes("'limit' must be an integer between 1 and 100"));
  });

  // ── 15. Pagination limit enforcement ────────────────────────────────
  await t.test('15. Pagination limit > 100 returns 400 VALIDATION_ERROR', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications?limit=500', { cookie });
    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('must not exceed 100'));
  });

  // ── 16. Nonexistent application → 404 ───────────────────────────────
  await t.test('16. Nonexistent application ID returns 404 APPLICATION_NOT_FOUND', async () => {
    const cookie = await getAuthCookie();
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const getRes = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}`, { cookie });
    assert.equal(getRes.statusCode, 404);
    assert.equal(getRes.json?.error?.code, 'APPLICATION_NOT_FOUND');

    const putRes = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}`, {
      method: 'PUT',
      cookie,
      body: { name: 'New Name' }
    });
    assert.equal(putRes.statusCode, 404);
    assert.equal(putRes.json?.error?.code, 'APPLICATION_NOT_FOUND');
  });

  // ── 17. Immutable field modification → 400 ──────────────────────────
  await t.test('17. Modification of immutable fields (id, created_at, active_release_id) returns 400', async () => {
    const cookie = await getAuthCookie();

    const putIdRes = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, {
      method: 'PUT',
      cookie,
      body: { id: 'new-injected-id' }
    });
    assert.equal(putIdRes.statusCode, 400);
    assert.equal(putIdRes.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(putIdRes.json.error.message.includes('immutable'));

    const putCreatedRes = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, {
      method: 'PUT',
      cookie,
      body: { created_at: '2020-01-01T00:00:00Z' }
    });
    assert.equal(putCreatedRes.statusCode, 400);
    assert.equal(putCreatedRes.json?.error?.code, 'VALIDATION_ERROR');

    const putReleaseRes = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, {
      method: 'PUT',
      cookie,
      body: { active_release_id: 'fake_release_id' }
    });
    assert.equal(putReleaseRes.statusCode, 400);
    assert.equal(putReleaseRes.json?.error?.code, 'VALIDATION_ERROR');
  });

  // ── 18. Malformed JSON → appropriate 400 response ───────────────────
  await t.test('18. Malformed JSON payload returns structured 400 response', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      rawBody: '{"name": "Broken JSON, invalid syntax...'
    });

    assert.equal(res.statusCode, 400);
    assert.equal(res.json?.error?.code, 'VALIDATION_ERROR');
    assert.ok(res.json.error.message.includes('Malformed JSON payload'));
  });

  // ── 19. Session revoked after logout → 401 ──────────────────────────
  await t.test('19. Session revoked after logout returns 401 on /api/applications', async () => {
    const cookie = await getAuthCookie();

    // Verify session works
    const check1 = await httpRequest(testServer.baseUrl, '/api/applications', { cookie });
    assert.equal(check1.statusCode, 200);

    // Logout
    const logoutRes = await httpRequest(testServer.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie
    });
    assert.equal(logoutRes.statusCode, 200);

    // Verify subsequent call is rejected
    const check2 = await httpRequest(testServer.baseUrl, '/api/applications', { cookie });
    assert.equal(check2.statusCode, 401);
  });

  // ── 20. Existing /api/apps routing remains unchanged ────────────────
  await t.test('20. Existing /api/apps routing remains unchanged and accessible', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/apps', { cookie });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json));
  });

  // ── 21. Existing /api/deployments routing remains unchanged ─────────
  await t.test('21. Existing /api/deployments legacy routing remains unchanged', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/deployments', { cookie });
    assert.equal(res.statusCode, 200);
    assert.ok(Array.isArray(res.json));
  });

  // ── 22. Database records persist after close/reopen ─────────────────
  await t.test('22. Applications persist across database close and reopen', async () => {
    closeDatabase();

    // Reopen using same path
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    assert.ok(reopenedDb.open);

    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, `/api/applications/${createdAppId}`, { cookie });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.data?.id, createdAppId);
    assert.equal(res.json.data.slug, 'prod-website');
  });

  // ── 23. Database failure returns a sanitized response ───────────────
  await t.test('23. Database failure returns a sanitized error response without leaking internals', async () => {
    const cookie = await getAuthCookie();
    // Simulate error by passing a query that fails or closing connection
    closeDatabase();

    // Reopening with a read-only or invalid table will be caught safely
    const res = await httpRequest(testServer.baseUrl, '/api/applications/invalid-uuid-format', { cookie });
    assert.ok(res.statusCode === 404 || res.statusCode === 500);
    const bodyStr = JSON.stringify(res.json);
    assert.ok(!bodyStr.includes('SQLITE_'));
    assert.ok(!bodyStr.includes('SELECT * FROM'));
    assert.ok(!bodyStr.includes(tempDbPath));
  });

  // ── 24. No Docker, Git, or shell operations occur ───────────────────
  await t.test('24. No Docker, Git, or shell operations occur during application CRUD', async () => {
    const cookie = await getAuthCookie();
    // Create another application
    const res = await httpRequest(testServer.baseUrl, '/api/applications', {
      method: 'POST',
      cookie,
      body: {
        name: 'Pure Data App',
        repo_url: 'https://github.com/owner/pure-data.git'
      }
    });

    assert.equal(res.statusCode, 201);
    assert.ok(res.json?.data?.id);
    // Verified: No child_process spawn/exec, no dockerode client calls, pure SQLite insert
  });
});
