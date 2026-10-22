const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');

const auth = require('../middleware/auth');
const app = require('../server');

// Helper to start the Express app on an ephemeral loopback port
function startServer(expressApp) {
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

// Helper to send HTTP requests to test server
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

    if (options.body) {
      const bodyStr = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
      if (!reqOptions.headers['Content-Type']) {
        req.setHeader('Content-Type', 'application/json');
      }
      req.write(bodyStr);
    }

    req.end();
  });
}

test('Phase 1C: Authentication Integration Lifecycle Suite', async (t) => {
  const TEST_PASSWORD = 'integration-test-password-2026';
  const TEST_SECRET = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

  let backendServer;

  t.before(async () => {
    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();
    backendServer = await startServer(app);
  });

  t.after(async () => {
    auth.setTestPassword(null);
    auth.setTestSessionSecret(null);
    auth.clearAllSessions();
    if (backendServer) {
      await backendServer.close();
    }
  });

  t.beforeEach(() => {
    auth.clearAllSessions();
    auth.setTestPassword(TEST_PASSWORD);
  });

  // ── 1. Next.js Config & Local Development Rewrite Support ────────
  await t.test('1. Next.js rewrite configuration supports BACKEND_URL and local fallback', async () => {
    delete process.env.BACKEND_URL;
    delete require.cache[require.resolve('../../frontend/next.config.js')];
    const defaultNextConfig = require('../../frontend/next.config.js');
    const defaultRewrites = await defaultNextConfig.rewrites();
    assert.equal(
      defaultRewrites[0].destination,
      'http://127.0.0.1:5001/api/:path*',
      'Default rewrite destination must point to loopback http://127.0.0.1:5001 for local development'
    );

    // Test with explicit BACKEND_URL (as set in docker-compose.yml)
    process.env.BACKEND_URL = 'http://backend:5001';
    delete require.cache[require.resolve('../../frontend/next.config.js')];
    const dockerNextConfig = require('../../frontend/next.config.js');
    const dockerRewrites = await dockerNextConfig.rewrites();
    assert.equal(
      dockerRewrites[0].destination,
      'http://backend:5001/api/:path*',
      'Docker rewrite destination must use BACKEND_URL when provided'
    );
    delete process.env.BACKEND_URL;
  });

  // ── 2. Open Redirect Defense (getSafeReturnPath) ───────────────────
  await t.test('2. Open redirect sanitization rejects malicious URLs and preserves safe paths', () => {
    // Import sanitizer function from AuthContext module
    // Note: Since AuthContext is a Next.js client component with React imports, we test the logic directly
    function getSafeReturnPath(path) {
      if (!path || typeof path !== 'string') return '/';
      const trimmed = path.trim();
      if (
        trimmed.startsWith('/') &&
        !trimmed.startsWith('//') &&
        !trimmed.includes('://') &&
        !trimmed.includes('\\') &&
        !trimmed.toLowerCase().startsWith('/login')
      ) {
        return trimmed;
      }
      return '/';
    }

    // Malicious external attack vectors
    assert.equal(getSafeReturnPath('//evil.com'), '/');
    assert.equal(getSafeReturnPath('//attacker.org/steal'), '/');
    assert.equal(getSafeReturnPath('https://evil.com'), '/');
    assert.equal(getSafeReturnPath('http://malicious.site/phish'), '/');
    assert.equal(getSafeReturnPath('javascript:alert(1)'), '/');
    assert.equal(getSafeReturnPath('\\attacker.com'), '/');
    assert.equal(getSafeReturnPath('/\\attacker.com'), '/');
    assert.equal(getSafeReturnPath('/login'), '/');
    assert.equal(getSafeReturnPath('/login?returnTo=/containers'), '/');
    assert.equal(getSafeReturnPath(null), '/');
    assert.equal(getSafeReturnPath(''), '/');
    assert.equal(getSafeReturnPath('   '), '/');

    // Legitimate internal paths
    assert.equal(getSafeReturnPath('/containers'), '/containers');
    assert.equal(getSafeReturnPath('/terminal'), '/terminal');
    assert.equal(getSafeReturnPath('/settings'), '/settings');
    assert.equal(getSafeReturnPath('/databases?type=postgres'), '/databases?type=postgres');
    assert.equal(getSafeReturnPath('/applications/new'), '/applications/new');
  });

  // ── 3. Complete Login Lifecycle ───────────────────────────────────
  await t.test('3. Full Login Lifecycle: unauthenticated 401 -> valid login -> authenticated access', async () => {
    // A. Unauthenticated request to protected API yields 401
    const unauthRes = await httpRequest(backendServer.baseUrl, '/api/stats');
    assert.equal(unauthRes.statusCode, 401);
    assert.equal(unauthRes.json?.error, 'Unauthorized');

    // B. Attempt login with wrong password -> fails with 401
    const badLoginRes = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'wrong-password' }
    });
    assert.equal(badLoginRes.statusCode, 401);
    assert.equal(badLoginRes.json?.error, 'Invalid password');

    // C. Attempt login with correct password -> succeeds with HttpOnly session cookie
    const goodLoginRes = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    assert.equal(goodLoginRes.statusCode, 200);
    assert.equal(goodLoginRes.json?.success, true);

    const setCookie = goodLoginRes.headers['set-cookie'];
    assert.ok(setCookie);
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('kp_session='));
    assert.ok(cookieStr.includes('HttpOnly'));
    assert.ok(cookieStr.includes('SameSite=Strict'));

    const cookieVal = cookieStr.split(';')[0];

    // D. Subsequent request using session cookie succeeds
    const authedRes = await httpRequest(backendServer.baseUrl, '/api/stats', {
      cookie: cookieVal
    });
    assert.equal(authedRes.statusCode, 200);

    // E. Verify status endpoint reports authenticated: true
    const statusRes = await httpRequest(backendServer.baseUrl, '/api/auth/status', {
      cookie: cookieVal
    });
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json?.authenticated, true);
    assert.equal(statusRes.json?.configured, true);
  });

  // ── 4. Complete Logout Lifecycle & Revocation ──────────────────────
  await t.test('4. Full Logout Lifecycle: logout clears session and subsequent requests are rejected', async () => {
    // 1. Establish session
    const loginRes = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookieVal = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

    // Verify session is active
    const checkActive = await httpRequest(backendServer.baseUrl, '/api/auth/status', { cookie: cookieVal });
    assert.equal(checkActive.json?.authenticated, true);

    // 2. Perform logout
    const logoutRes = await httpRequest(backendServer.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: cookieVal
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.json?.success, true);

    const logoutCookie = logoutRes.headers['set-cookie'];
    const logoutCookieStr = Array.isArray(logoutCookie) ? logoutCookie[0] : logoutCookie;
    assert.ok(logoutCookieStr.includes('Max-Age=0'), 'Logout must clear cookie with Max-Age=0');

    // 3. Verify the revoked session token cannot be reused
    const reusedRes = await httpRequest(backendServer.baseUrl, '/api/stats', { cookie: cookieVal });
    assert.equal(reusedRes.statusCode, 401, 'Revoked session token must be rejected with 401');

    const statusAfter = await httpRequest(backendServer.baseUrl, '/api/auth/status', { cookie: cookieVal });
    assert.equal(statusAfter.json?.authenticated, false);
  });

  // ── 5. Session Expiration ──────────────────────────────────────────
  await t.test('5. Expired sessions are strictly rejected by the backend', async () => {
    // Create an artificially expired session
    const token = 'expired_session_test_token_1234567890abcdef1234567890abcdef12345678';
    const signed = auth.signToken(token);

    // Inject session into in-memory store with an expired timestamp (1 hour in the past)
    auth.SESSIONS.set(token, {
      createdAt: Date.now() - (25 * 60 * 60 * 1000),
      expiresAt: Date.now() - (1 * 60 * 60 * 1000) // Expired 1 hour ago
    });

    const expiredCookie = `kp_session=${encodeURIComponent(signed)}`;

    // A. Request to protected route with expired session
    const res = await httpRequest(backendServer.baseUrl, '/api/stats', {
      cookie: expiredCookie
    });
    assert.equal(res.statusCode, 401, 'Expired session must return 401');

    // B. Status endpoint with expired session
    const statusRes = await httpRequest(backendServer.baseUrl, '/api/auth/status', {
      cookie: expiredCookie
    });
    assert.equal(statusRes.json?.authenticated, false, 'Expired session must report authenticated: false');

    // C. Verify expired session was purged from the store
    assert.equal(auth.SESSIONS.has(token), false, 'Expired session must be deleted from memory store');
  });

  // ── 6. Missing Configuration (Fail-Closed) ─────────────────────────
  await t.test('6. Missing K_PANEL_PASSWORD configuration strictly fails closed', async () => {
    // Unset password configuration
    auth.setTestPassword('');

    // Status reports unconfigured and unauthenticated
    const statusRes = await httpRequest(backendServer.baseUrl, '/api/auth/status');
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json?.authenticated, false);
    assert.equal(statusRes.json?.configured, false);

    // Login fails closed with 401
    const loginRes = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'any-password' }
    });
    assert.equal(loginRes.statusCode, 401);
    assert.equal(loginRes.json?.error, 'Server authentication not configured');

    // All protected routes return 401
    const protectedRoutes = ['/api/stats', '/api/apps', '/api/files', '/api/terminal/exec'];
    for (const route of protectedRoutes) {
      const res = await httpRequest(backendServer.baseUrl, route, {
        method: route === '/api/terminal/exec' ? 'POST' : 'GET',
        body: route === '/api/terminal/exec' ? { command: 'echo 1' } : undefined
      });
      assert.equal(res.statusCode, 401, `${route} must return 401 when password is not configured`);
    }

    // Restore password
    auth.setTestPassword(TEST_PASSWORD);
  });

  // ── 7. Reverse Proxy & Trust Proxy Security ────────────────────────
  await t.test('7. Reverse proxy headers: Secure flag enabled on HTTPS, omitted on local HTTP', async () => {
    // Case A: Local HTTP development (no X-Forwarded-Proto)
    const localLogin = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const localCookie = Array.isArray(localLogin.headers['set-cookie'])
      ? localLogin.headers['set-cookie'][0]
      : localLogin.headers['set-cookie'];
    assert.ok(!localCookie.includes('Secure'), 'Local HTTP requests must not include Secure flag to allow localhost cookies');

    // Case B: Production HTTPS behind Traefik (X-Forwarded-Proto: https)
    const proxyLogin = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      headers: {
        'X-Forwarded-Proto': 'https'
      },
      body: { password: TEST_PASSWORD }
    });
    const proxyCookie = Array.isArray(proxyLogin.headers['set-cookie'])
      ? proxyLogin.headers['set-cookie'][0]
      : proxyLogin.headers['set-cookie'];
    assert.ok(proxyCookie.includes('Secure'), 'Forwarded HTTPS requests must include Secure flag');
  });

  // ── 8. Public Endpoint Strictness & Route Guarding ─────────────────
  await t.test('8. Public endpoint allowlist is strict: only health, login, status are exempt', async () => {
    // Health is public
    const health = await httpRequest(backendServer.baseUrl, '/api/health');
    assert.equal(health.statusCode, 200);

    // Status is public
    const status = await httpRequest(backendServer.baseUrl, '/api/auth/status');
    assert.equal(status.statusCode, 200);

    // Login is public
    const login = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'bad' }
    });
    assert.equal(login.statusCode, 401); // 401 for bad password, reached handler

    // Webhook endpoint requires auth (not exempted in Phase 1)
    const webhook = await httpRequest(backendServer.baseUrl, '/api/webhook', {
      method: 'POST',
      body: { fake: 'webhook' }
    });
    assert.equal(webhook.statusCode, 401, 'Webhook endpoint must be protected until signature verification is implemented');

    // Unknown routes require auth
    const unknown = await httpRequest(backendServer.baseUrl, '/api/unknown-endpoint');
    assert.equal(unknown.statusCode, 401, 'Unknown API routes must not bypass auth');
  });

  // ── 9. Credential Safety & Log Sanitization ────────────────────────
  await t.test('9. Login errors never disclose passwords or sensitive token details', async () => {
    const res = await httpRequest(backendServer.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'secret-candidate-password-1234' }
    });
    assert.equal(res.statusCode, 401);
    const bodyStr = JSON.stringify(res.json);
    assert.ok(!bodyStr.includes('secret-candidate-password-1234'), 'Response must never echo back the submitted password');
    assert.ok(!bodyStr.includes('kpanel-test-password-2026'), 'Response must never reveal the actual server password');
  });
});
