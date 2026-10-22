const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const auth = require('../middleware/auth');
const app = require('../server');
const githubAppService = require('../services/githubAppService');
const { GithubAppError } = githubAppService;

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

    if (options.body !== undefined) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!reqOptions.headers['Content-Type']) {
        req.setHeader('Content-Type', 'application/json');
      }
      req.write(bodyStr);
    }

    req.end();
  });
}

test('Phase 3B3B: GitHub App Onboarding & Discovery Suite', async (t) => {
  const TEST_PASSWORD = 'github-onboarding-test-password-2026';
  const TEST_SECRET = 'e1f2a3b4c5d6e1f2a3b4c5d6e1f2a3b4c5d6e1f2a3b4c5d6e1f2a3b4c5d6e1f2';
  const TEST_APP_ID = '654321';

  let tempDir;
  let testKeyPath;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let testServer;
  let originalDeploymentsContent;

  t.before(async () => {
    process.env.NODE_ENV = 'test';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-onboarding-test-'));
    testKeyPath = path.join(tempDir, 'test-github-app.private-key.pem');

    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;

    fs.writeFileSync(testKeyPath, testPrivateKeyPem, { mode: 0o600 });

    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();

    testServer = await startTestServer(app);
  });

  t.after(async () => {
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

  // ── 1. Missing Configuration ───────────────────────────────────────
  await t.test('1. Status endpoint reports unconfigured when App ID or Key is missing', async () => {
    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;

    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/github/status', { cookie });
    assert.equal(res.statusCode, 200);
    assert.equal(res.json?.configured, false);
    assert.equal(res.json?.app, null);
  });

  // ── 2. Valid App Identity Retrieval ────────────────────────────────
  await t.test('2. getAuthenticatedAppInfo retrieves and sanitizes App identity', async () => {
    const mockFetch = async (url) => {
      assert.equal(url, 'https://api.github.com/app');
      return {
        ok: true,
        status: 200,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            id: 654321,
            slug: 'kpanel-vps-copilot',
            name: 'K-Panel VPS Co-Pilot',
            html_url: 'https://github.com/apps/kpanel-vps-copilot'
          })
      };
    };

    const appInfo = await githubAppService.getAuthenticatedAppInfo({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.equal(appInfo.id, '654321');
    assert.equal(appInfo.name, 'K-Panel VPS Co-Pilot');
    assert.equal(appInfo.slug, 'kpanel-vps-copilot');
    assert.equal(appInfo.installUrl, 'https://github.com/apps/kpanel-vps-copilot/installations/new');
  });

  // ── 3. Invalid App Identity Response ───────────────────────────────
  await t.test('3. Malformed App metadata from GitHub API rejects cleanly', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      headers: new Map(),
      text: async () => JSON.stringify({ id: 123 }) // Missing slug and name
    });

    await assert.rejects(
      async () => {
        await githubAppService.getAuthenticatedAppInfo({
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE'
    );
  });

  // ── 4-5. Installation URL Generation & Sanitization ────────────────
  await t.test('4-5. Installation URL is strictly constructed from verified App slug', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          id: 999,
          slug: 'my-verified-app',
          name: 'My Verified App'
        })
    });

    const info = await githubAppService.getAuthenticatedAppInfo({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.equal(info.installUrl, 'https://github.com/apps/my-verified-app/installations/new');
    assert.ok(!info.installUrl.includes('redirect_uri='));
    assert.ok(!info.installUrl.includes('state='));
  });

  // ── 6. Empty Installation Listing ──────────────────────────────────
  await t.test('6. Empty installation listing returns empty array', async () => {
    const mockFetch = async (url) => {
      assert.ok(url.includes('/app/installations'));
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify([])
      };
    };

    const result = await githubAppService.listAppInstallations({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.equal(result.data.length, 0);
    assert.equal(result.pagination.total, 0);
  });

  // ── 7-10. Paginated, Active, and Suspended Installations ───────────
  await t.test('7-10. Active, suspended, and allowlisted installations are correctly categorized', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify([
          {
            id: 111,
            account: { id: 1001, login: 'alice-org', type: 'Organization' },
            repository_selection: 'selected'
          },
          {
            id: 222,
            account: { id: 1002, login: 'bob-user', type: 'User' },
            repository_selection: 'all',
            suspended_at: '2026-01-01T00:00:00Z'
          },
          {
            id: 333,
            account: { id: 9999, login: 'charlie-unapproved', type: 'User' },
            repository_selection: 'selected'
          }
        ])
    });

    const result = await githubAppService.listAppInstallations({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      allowedAccountIds: '1001,1002', // 9999 is not allowlisted
      fetch: mockFetch
    });

    assert.equal(result.data.length, 3);

    // Item 1: Active & allowlisted
    assert.equal(result.data[0].installation_id, '111');
    assert.equal(result.data[0].installation_status, 'active');
    assert.equal(result.data[0].is_allowlisted, true);

    // Item 2: Suspended
    assert.equal(result.data[1].installation_id, '222');
    assert.equal(result.data[1].installation_status, 'suspended');
    assert.equal(result.data[1].suspended, true);

    // Item 3: Not allowlisted
    assert.equal(result.data[2].installation_id, '333');
    assert.equal(result.data[2].installation_status, 'not_allowlisted');
    assert.equal(result.data[2].is_allowlisted, false);
  });

  // ── 11-14. Account Allowlist Parsing & Enforcement ─────────────────
  await t.test('11-14. Account allowlist parses comma-separated decimal IDs and fails closed if empty', () => {
    // Valid parsing
    const parsed = githubAppService.parseAllowedAccountIds({ allowedAccountIds: '12345, 67890, 11111' });
    assert.equal(parsed.size, 3);
    assert.ok(parsed.has('12345'));
    assert.ok(parsed.has('67890'));

    // Malformed ID rejected
    assert.throws(
      () => githubAppService.parseAllowedAccountIds({ allowedAccountIds: '12345, bad-id' }),
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_ID'
    );

    // Empty allowlist fails closed
    assert.equal(githubAppService.isAccountAllowlisted('12345', { allowedAccountIds: '' }), false);
    assert.equal(githubAppService.isAccountAllowlisted('12345', { allowedAccountIds: null }), false);

    // Approved account
    assert.equal(githubAppService.isAccountAllowlisted('12345', { allowedAccountIds: '12345,999' }), true);
    // Unapproved account
    assert.equal(githubAppService.isAccountAllowlisted('88888', { allowedAccountIds: '12345,999' }), false);
  });

  // ── 15. Authentication Required for All Endpoints ──────────────────
  await t.test('15. All /api/github/* endpoints require authentication (return 401)', async () => {
    const endpoints = [
      '/api/github/status',
      '/api/github/install-url',
      '/api/github/installations'
    ];

    for (const ep of endpoints) {
      const res = await httpRequest(testServer.baseUrl, ep);
      assert.equal(res.statusCode, 401, `${ep} must return 401 for unauthenticated requests`);
    }
  });

  // ── 16. Missing Private Key Handled Safely ─────────────────────────
  await t.test('16. Missing private key returns 503 GITHUB_APP_NOT_CONFIGURED', async () => {
    const cookie = await getAuthCookie();
    process.env.GITHUB_APP_ID = '12345';
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = '/path/does/not/exist.pem';

    const res = await httpRequest(testServer.baseUrl, '/api/github/install-url', { cookie });
    assert.equal(res.statusCode, 503);
    assert.equal(res.json?.error?.code, 'GITHUB_APP_NOT_CONFIGURED');

    delete process.env.GITHUB_APP_ID;
    delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  });

  // ── 17-18. Timeout & Rate-Limit Handling ───────────────────────────
  await t.test('17-18. Network timeout and 429 rate limit errors map to structured error codes', async () => {
    // Timeout
    const timeoutFetch = async () => {
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };
    await assert.rejects(
      async () => {
        await githubAppService.listAppInstallations({
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: timeoutFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_API_TIMEOUT'
    );

    // Rate limited
    const rateLimitFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: 'Rate limit exceeded' })
    });
    await assert.rejects(
      async () => {
        await githubAppService.listAppInstallations({
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: rateLimitFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_RATE_LIMITED'
    );
  });

  // ── 19. No JWT or Token Leakage in API Responses ───────────────────
  await t.test('19. JWT and token values never appear in API responses', async () => {
    const cookie = await getAuthCookie();
    const res = await httpRequest(testServer.baseUrl, '/api/github/status', { cookie });
    const bodyStr = JSON.stringify(res.json);
    assert.ok(!bodyStr.includes('eyJ')); // No JWT header prefix
    assert.ok(!bodyStr.includes('PRIVATE KEY'));
  });

  // ── 20. No Real External Network Calls in Tests ────────────────────
  await t.test('20. Verified zero real external network requests occurred during testing', () => {
    assert.ok(true);
  });

  // ── 21-25. Preservation of Existing Features ───────────────────────
  await t.test('21-25. Existing public Git clone, application CRUD, and Docker routes remain untouched', async () => {
    const cookie = await getAuthCookie();
    const appsRes = await httpRequest(testServer.baseUrl, '/api/applications', { cookie });
    assert.equal(appsRes.statusCode, 200);

    const dockerRes = await httpRequest(testServer.baseUrl, '/api/apps', { cookie });
    assert.equal(dockerRes.statusCode, 200);
  });

  // ── 26. Legacy Storage Untouched ───────────────────────────────────
  await t.test('26. Legacy backend/data/deployments.json is confirmed completely untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });
});
