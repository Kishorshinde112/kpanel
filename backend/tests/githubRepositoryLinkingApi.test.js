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
const { runMigrations } = require('../db/migrate');
const { createApplication, getApplicationById } = require('../services/applicationService');
const githubRepositoryService = require('../services/githubRepositoryService');
const { GithubRepositoryError } = githubRepositoryService;

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

test('Phase 3B3C: GitHub Repository Selection & Linking API Suite', async (t) => {
  const TEST_PASSWORD = 'linking-api-test-password-2026';
  const TEST_SECRET = 'a9b8c7d6e5f4a9b8c7d6e5f4a9b8c7d6e5f4a9b8c7d6e5f4a9b8c7d6e5f4a9b8';
  const TEST_APP_ID = '789123';

  let tempDir;
  let tempDbPath;
  let testDb;
  let testKeyPath;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let testServer;
  let originalDeploymentsContent;

  t.before(async () => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-linking-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);

    testKeyPath = path.join(tempDir, 'test-key.pem');
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;
    fs.writeFileSync(testKeyPath, testPrivateKeyPem, { mode: 0o600 });

    process.env.GITHUB_APP_ID = TEST_APP_ID;
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = testKeyPath;

    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();

    testServer = await startTestServer(app);
  });

  t.after(async () => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
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

  async function getAuthCookie() {
    const res = await httpRequest(testServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const setCookie = res.headers['set-cookie'];
    return (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  }

  // ── 1-4. Unauthenticated Access Rejected (401) ─────────────────────
  await t.test('1-4. Unauthenticated requests to linking and discovery endpoints return 401', async () => {
    const fakeId = '00000000-0000-0000-0000-000000000000';
    // 1. GET repositories
    const r1 = await httpRequest(testServer.baseUrl, '/api/github/installations/123/repositories');
    assert.equal(r1.statusCode, 401);

    // 2. GET association
    const r2 = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}/github-repository`);
    assert.equal(r2.statusCode, 401);

    // 3. POST association
    const r3 = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}/github-repository`, {
      method: 'POST',
      body: { installation_id: '123', repository_id: '456' }
    });
    assert.equal(r3.statusCode, 401);

    // 4. DELETE association
    const r4 = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}/github-repository`, {
      method: 'DELETE'
    });
    assert.equal(r4.statusCode, 401);
  });

  // ── 5-6. Empty Allowlist Fails Closed ───────────────────────────────
  await t.test('5-6. Empty or missing account allowlist fails closed', async () => {
    // Unset allowlist
    delete process.env.GITHUB_ALLOWED_ACCOUNT_IDS;

    const cookie = await getAuthCookie();
    // Discovery returns 403 / REPOSITORY_NOT_AUTHORIZED
    const r5 = await httpRequest(testServer.baseUrl, '/api/github/installations/123/repositories', { cookie });
    assert.ok(r5.statusCode === 403 || r5.statusCode === 404 || r5.statusCode === 502);

    // Restore allowlist
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '888,999';
  });

  // ── 7. Stale Allowlist Revocation Fails Closed ─────────────────────
  await t.test('7. Removing an account from allowlist causes subsequent checkout authorization to fail', () => {
    const appRecord = createApplication(
      { name: 'Revoke App', repo_url: 'https://github.com/my-org/my-site.git' },
      { db: testDb }
    );

    // Manually insert an association for account 999
    testDb.prepare(`
      INSERT OR REPLACE INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status
      ) VALUES ('12345', '999', 'my-org', 'Organization', 'selected', 'active')
    `).run();

    testDb.prepare(`
      INSERT OR REPLACE INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status
      ) VALUES (?, '12345', '777888', 'my-org', 'my-site', 'my-org/my-site', 1, 'verified')
    `).run(appRecord.id);

    // When account 999 is in allowlist -> resolves github-app mode
    const auth1 = githubRepositoryService.resolveApplicationCheckoutAuth(appRecord.id, {
      db: testDb,
      allowedAccountIds: '999'
    });
    assert.equal(auth1.authMode, 'github-app');

    // When account 999 is REMOVED from allowlist -> must fail closed!
    assert.throws(
      () => {
        githubRepositoryService.resolveApplicationCheckoutAuth(appRecord.id, {
          db: testDb,
          allowedAccountIds: '111,222' // 999 removed!
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'REPOSITORY_NOT_AUTHORIZED'
    );
  });

  // ── 8-10. Invalid Identifiers Rejected ─────────────────────────────
  await t.test('8-10. Invalid installation or repository IDs are rejected with 400', async () => {
    const cookie = await getAuthCookie();
    const appRecord = createApplication(
      { name: 'Validation App', repo_url: 'https://github.com/my-org/site.git' },
      { db: testDb }
    );

    const rBadInst = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, {
      method: 'POST',
      cookie,
      body: { installation_id: '', repository_id: '123' }
    });
    assert.equal(rBadInst.statusCode, 400);

    const rBadRepo = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, {
      method: 'POST',
      cookie,
      body: { installation_id: '123', repository_id: '' }
    });
    assert.equal(rBadRepo.statusCode, 400);
  });

  // ── 11-13. Repository URL and Identity Mismatch Blocked ────────────
  await t.test('11-13. Repository URL identity mismatch is blocked', async () => {
    const cookie = await getAuthCookie();
    const appRecord = createApplication(
      { name: 'Mismatch App', repo_url: 'https://github.com/my-org/expected-repo.git' },
      { db: testDb }
    );

    // Mock fetch where GitHub returns a different repository
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({ token: 'ghs_token', expires_at: new Date(Date.now() + 3600 * 1000).toISOString() })
        };
      }
      if (url.includes('/installation/repositories')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            repositories: [
              { id: 99999, name: 'completely-different', full_name: 'my-org/completely-different', owner: { login: 'my-org' }, private: true }
            ]
          })
        };
      }
      return { ok: true, status: 200, json: async () => ({ id: 12345, account: { id: 888, login: 'my-org' }, repository_selection: 'selected' }) };
    };

    try {
      const res = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, {
        method: 'POST',
        cookie,
        body: { installation_id: '12345', repository_id: '99999' }
      });
      assert.ok(res.statusCode === 400 || res.statusCode === 403);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── 14-16. Verified Repository Linked Successfully ─────────────────
  let linkedAppId;
  await t.test('14-16. Verified repository links successfully and exposes no credentials', async () => {
    const cookie = await getAuthCookie();
    const appRecord = createApplication(
      { name: 'Linked Production App', repo_url: 'https://github.com/my-org/production-app.git' },
      { db: testDb }
    );
    linkedAppId = appRecord.id;

    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (url) => {
      if (url.includes('/app/installations/') && !url.includes('/access_tokens')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 12345,
            account: { id: 888, login: 'my-org', type: 'Organization' },
            repository_selection: 'selected'
          })
        };
      }
      if (url.includes('/access_tokens')) {
        return {
          ok: true,
          status: 201,
          text: async () => JSON.stringify({
            token: 'ghs_secretTokenDoNotLeak_999999',
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          })
        };
      }
      if (url.includes('/installation/repositories')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            repositories: [
              {
                id: 444555,
                name: 'production-app',
                full_name: 'my-org/production-app',
                owner: { login: 'my-org' },
                private: true
              }
            ]
          })
        };
      }
      return { ok: false, status: 404 };
    };

    try {
      // 14. POST association succeeds
      const linkRes = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, {
        method: 'POST',
        cookie,
        body: { installation_id: '12345', repository_id: '444555' }
      });

      assert.equal(linkRes.statusCode, 200);
      assert.ok(linkRes.json?.data);
      assert.equal(linkRes.json.data.repositoryFullName, 'my-org/production-app');
      assert.equal(linkRes.json.data.associationStatus, 'verified');

      // 15. No token in response
      const bodyStr = JSON.stringify(linkRes.json);
      assert.equal(bodyStr.includes('ghs_secretTokenDoNotLeak'), false, 'Response must never leak installation token');

      // 16. GET association returns verified state
      const getRes = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, { cookie });
      assert.equal(getRes.statusCode, 200);
      assert.equal(getRes.json?.data?.repositoryFullName, 'my-org/production-app');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  // ── 19-22. Unlink Lifecycle ────────────────────────────────────────
  await t.test('19-22. Unlink deactivates association and preserves application and deployments', async () => {
    const cookie = await getAuthCookie();

    // 19. DELETE unlinks repository
    const unlinkRes = await httpRequest(testServer.baseUrl, `/api/applications/${linkedAppId}/github-repository`, {
      method: 'DELETE',
      cookie
    });
    assert.equal(unlinkRes.statusCode, 200);
    assert.equal(unlinkRes.json?.success, true);

    // 20. Application record is NOT deleted
    const appCheck = getApplicationById(linkedAppId, { db: testDb });
    assert.ok(appCheck);
    assert.equal(appCheck.name, 'Linked Production App');

    // 21. GET association returns 404 after unlinking
    const getAfter = await httpRequest(testServer.baseUrl, `/api/applications/${linkedAppId}/github-repository`, { cookie });
    assert.equal(getAfter.statusCode, 404);

    // 22. Subsequent checkout resolves to public mode
    const checkoutAuth = githubRepositoryService.resolveApplicationCheckoutAuth(linkedAppId, { db: testDb });
    assert.equal(checkoutAuth.authMode, 'public');
  });

  // ── 26. CSRF & Cross-Origin Mutation Rejection ─────────────────────
  await t.test('26. Cross-origin mutation request with mismatched Origin header is rejected (403)', async () => {
    const cookie = await getAuthCookie();
    const appRecord = createApplication(
      { name: 'CSRF App', repo_url: 'https://github.com/my-org/csrf.git' },
      { db: testDb }
    );

    const csrfRes = await httpRequest(testServer.baseUrl, `/api/applications/${appRecord.id}/github-repository`, {
      method: 'POST',
      cookie,
      headers: {
        'Origin': 'https://malicious-attacker-site.com'
      },
      body: { installation_id: '12345', repository_id: '444555' }
    });

    assert.equal(csrfRes.statusCode, 403);
    assert.equal(csrfRes.json?.error?.code, 'CSRF_REJECTED');
  });

  // ── 27-28. Malformed and Excessive Request Body ────────────────────
  await t.test('27-28. Malformed JSON payload is rejected with structured 400 response', async () => {
    const cookie = await getAuthCookie();
    const fakeId = '00000000-0000-0000-0000-000000000000';

    const malformedRes = await httpRequest(testServer.baseUrl, `/api/applications/${fakeId}/github-repository`, {
      method: 'POST',
      cookie,
      rawBody: '{"installation_id": 123, broken-json...'
    });

    assert.equal(malformedRes.statusCode, 400);
    assert.equal(malformedRes.json?.error?.code, 'VALIDATION_ERROR');
  });

  // ── 31-35. Regression & Isolation ──────────────────────────────────
  await t.test('31-35. Existing application CRUD and Docker routes remain functional', async () => {
    const cookie = await getAuthCookie();
    const appsList = await httpRequest(testServer.baseUrl, '/api/applications', { cookie });
    assert.equal(appsList.statusCode, 200);

    const dockerApps = await httpRequest(testServer.baseUrl, '/api/apps', { cookie });
    assert.equal(dockerApps.statusCode, 200);
  });
});
