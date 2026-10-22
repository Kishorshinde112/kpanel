const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const crypto = require('node:crypto');

const auth = require('../middleware/auth');
const app = require('../server');

// Helper to start the Express app on an ephemeral port
function startTestServer() {
  return new Promise((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      const baseUrl = `http://127.0.0.1:${port}`;
      resolve({
        server,
        baseUrl,
        close: () => new Promise((res) => server.close(res))
      });
    });
  });
}

// Helper to send HTTP requests to test server
function request(baseUrl, path, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const reqOptions = {
      method: options.method || 'GET',
      headers: options.headers || {}
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

test('Authentication Module & Middleware Suite', async (t) => {
  const TEST_PASSWORD = 'kpanel-test-password-2026';
  const TEST_SECRET = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  let testEnv;

  t.before(async () => {
    auth.setTestPassword(TEST_PASSWORD);
    auth.setTestSessionSecret(TEST_SECRET);
    auth.clearAllSessions();
    testEnv = await startTestServer();
  });

  t.after(async () => {
    auth.setTestPassword(null);
    auth.setTestSessionSecret(null);
    auth.clearAllSessions();
    if (testEnv) {
      await testEnv.close();
    }
  });

  t.beforeEach(() => {
    auth.clearAllSessions();
    auth.setTestPassword(TEST_PASSWORD);
  });

  await t.test('1. No cookie → 401 on protected route', async () => {
    const res = await request(testEnv.baseUrl, '/api/stats');
    assert.equal(res.statusCode, 401, 'Expected 401 Unauthorized for unauthenticated request');
    assert.equal(res.json?.error, 'Unauthorized');
  });

  await t.test('2. Invalid cookie → 401', async () => {
    const res = await request(testEnv.baseUrl, '/api/stats', {
      cookie: 'kp_session=fake_invalid_token_12345.abcdef'
    });
    assert.equal(res.statusCode, 401, 'Expected 401 for invalid cookie token');
  });

  await t.test('3. Valid login → authenticated API request succeeds', async () => {
    // Attempt valid login
    const loginRes = await request(testEnv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });

    assert.equal(loginRes.statusCode, 200, 'Expected 200 OK for valid login');
    assert.equal(loginRes.json?.success, true);

    const setCookie = loginRes.headers['set-cookie'];
    assert.ok(setCookie, 'Expected Set-Cookie header on successful login');

    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    assert.ok(cookieStr.includes('kp_session='), 'Cookie should contain kp_session');
    assert.ok(cookieStr.includes('HttpOnly'), 'Cookie should be HttpOnly');
    assert.ok(cookieStr.includes('SameSite=Strict'), 'Cookie should be SameSite=Strict');

    // Extract cookie value for subsequent request
    const cookieVal = cookieStr.split(';')[0];

    // Access protected route with cookie
    const statsRes = await request(testEnv.baseUrl, '/api/stats', {
      cookie: cookieVal
    });
    assert.equal(statsRes.statusCode, 200, 'Protected route should succeed with valid session cookie');
    assert.ok(statsRes.json?.cpu !== undefined || statsRes.json?.memory !== undefined);
  });

  await t.test('4. Logout → previous session invalid', async () => {
    // 1. Log in
    const loginRes = await request(testEnv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
    const cookieVal = cookieStr.split(';')[0];

    // Verify session works
    const check1 = await request(testEnv.baseUrl, '/api/stats', { cookie: cookieVal });
    assert.equal(check1.statusCode, 200);

    // 2. Log out
    const logoutRes = await request(testEnv.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: cookieVal
    });
    assert.equal(logoutRes.statusCode, 200);
    assert.equal(logoutRes.json?.success, true);

    const logoutCookie = logoutRes.headers['set-cookie'];
    const logoutCookieStr = Array.isArray(logoutCookie) ? logoutCookie[0] : logoutCookie;
    assert.ok(logoutCookieStr.includes('Max-Age=0'), 'Logout should clear cookie with Max-Age=0');

    // 3. Verify previous session is now invalid
    const check2 = await request(testEnv.baseUrl, '/api/stats', { cookie: cookieVal });
    assert.equal(check2.statusCode, 401, 'Logged out session must return 401');
  });

  await t.test('5. Tampered token → 401 without crashing', async () => {
    // Create valid session first
    const { signed } = auth.createSession();

    // Maliciously tamper with the signature (shortened, modified, different lengths)
    const tamperedCases = [
      signed + 'x',                         // Extra char
      signed.slice(0, -5),                  // Truncated sig
      signed.replace(/[a-f0-9]/, 'z'),       // Corrupted hex
      signed.split('.')[0] + '.0000',        // Shortened wrong sig
      'not-a-token',                         // No dot
      '.',                                   // Only dot
      'a.b.c.d',                             // Multiple dots
      'token.wronglengthsignature'           // Arbitrary text
    ];

    for (const tampered of tamperedCases) {
      const res = await request(testEnv.baseUrl, '/api/stats', {
        cookie: `kp_session=${encodeURIComponent(tampered)}`
      });
      assert.equal(res.statusCode, 401, `Tampered token '${tampered}' must safely return 401`);
    }
  });

  await t.test('6. Missing password configuration → fails closed', async () => {
    // Temporarily unset password configuration
    auth.setTestPassword('');

    // 1. Status endpoint should report unconfigured and unauthenticated
    const statusRes = await request(testEnv.baseUrl, '/api/auth/status');
    assert.equal(statusRes.statusCode, 200);
    assert.equal(statusRes.json?.authenticated, false);
    assert.equal(statusRes.json?.configured, false);

    // 2. Login should fail closed
    const loginRes = await request(testEnv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: 'any-password' }
    });
    assert.equal(loginRes.statusCode, 401, 'Login must fail when password is not configured');

    // 3. Protected endpoint must reject access
    const protectedRes = await request(testEnv.baseUrl, '/api/stats');
    assert.equal(protectedRes.statusCode, 401, 'Protected route must return 401 when password is not configured');

    // Restore password
    auth.setTestPassword(TEST_PASSWORD);
  });

  await t.test('7. Health endpoint remains publicly accessible', async () => {
    const res = await request(testEnv.baseUrl, '/api/health');
    assert.equal(res.statusCode, 200, 'Health endpoint must be public');
    assert.equal(res.json?.status, 'ok');
    assert.equal(res.json?.service, 'kpanel-backend');
  });

  await t.test('8. Unauthenticated terminal execution → 401', async () => {
    const res = await request(testEnv.baseUrl, '/api/terminal/exec', {
      method: 'POST',
      body: { command: 'whoami' }
    });
    assert.equal(res.statusCode, 401, 'Terminal execution without auth must return 401');
  });

  await t.test('9. Unauthenticated container deletion → 401', async () => {
    const res = await request(testEnv.baseUrl, '/api/apps/non-existent-container-id', {
      method: 'DELETE'
    });
    assert.equal(res.statusCode, 401, 'Container deletion without auth must return 401');
  });

  await t.test('10. Unauthenticated blueprint deployment → 401', async () => {
    const res = await request(testEnv.baseUrl, '/api/blueprints/deploy', {
      method: 'POST',
      body: { blueprintId: 'wordpress', appName: 'test-wp' }
    });
    assert.equal(res.statusCode, 401, 'Blueprint deployment without auth must return 401');
  });

  await t.test('11. Authentication status correctly reflects the session', async () => {
    // 1. Initial status -> unauthenticated
    const res1 = await request(testEnv.baseUrl, '/api/auth/status');
    assert.equal(res1.statusCode, 200);
    assert.equal(res1.json?.authenticated, false);
    assert.equal(res1.json?.configured, true);

    // 2. Perform login
    const loginRes = await request(testEnv.baseUrl, '/api/auth/login', {
      method: 'POST',
      body: { password: TEST_PASSWORD }
    });
    const setCookie = loginRes.headers['set-cookie'];
    const cookieVal = (Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];

    // 3. Status with valid cookie -> authenticated
    const res2 = await request(testEnv.baseUrl, '/api/auth/status', {
      cookie: cookieVal
    });
    assert.equal(res2.statusCode, 200);
    assert.equal(res2.json?.authenticated, true);
    assert.equal(res2.json?.configured, true);

    // 4. Logout and check status -> unauthenticated
    await request(testEnv.baseUrl, '/api/auth/logout', {
      method: 'POST',
      cookie: cookieVal
    });

    const res3 = await request(testEnv.baseUrl, '/api/auth/status', {
      cookie: cookieVal
    });
    assert.equal(res3.statusCode, 200);
    assert.equal(res3.json?.authenticated, false);
  });

  await t.test('12. Unknown API routes must not bypass authentication', async () => {
    const res = await request(testEnv.baseUrl, '/api/random-unknown-endpoint-xyz');
    assert.equal(res.statusCode, 401, 'Unknown API route must return 401 for unauthenticated request');
  });

  await t.test('13. Unit tests: safeComparePasswords and length checks', () => {
    assert.equal(auth.safeComparePasswords('correct', 'correct'), true);
    assert.equal(auth.safeComparePasswords('wrong', 'correct'), false);
    assert.equal(auth.safeComparePasswords('short', 'much-longer-expected-password'), false);
    assert.equal(auth.safeComparePasswords('', 'correct'), false);
    assert.equal(auth.safeComparePasswords('correct', ''), false);
    assert.equal(auth.safeComparePasswords(null, 'correct'), false);
    assert.equal(auth.safeComparePasswords('correct', null), false);
    assert.equal(auth.safeComparePasswords(undefined, undefined), false);
  });

  await t.test('14. Unit tests: parseCookies edge cases', () => {
    assert.deepEqual(auth.parseCookies({ headers: {} }), {});
    assert.deepEqual(auth.parseCookies({ headers: { cookie: '' } }), {});

    const parsed = auth.parseCookies({
      headers: { cookie: 'kp_session=abc.123; other=hello%20world; malformed=%ZZ' }
    });
    assert.equal(parsed.kp_session, 'abc.123');
    assert.equal(parsed.other, 'hello world');
    assert.equal(parsed.malformed, '%ZZ', 'Malformed URI component must not throw');
  });

  await t.test('15. Unit tests: Bearer token authorization header support', async () => {
    const { signed } = auth.createSession();
    const res = await request(testEnv.baseUrl, '/api/stats', {
      headers: {
        'Authorization': `Bearer ${signed}`
      }
    });
    assert.equal(res.statusCode, 200, 'Bearer authorization header should be accepted');
  });

  await t.test('16. Unit tests: HTTPS Reverse Proxy Cookie Secure Flag', () => {
    const reqDirect = { secure: false, headers: {} };
    assert.equal(auth.isSecureConnection(reqDirect), false);

    const reqTraefikHttps = { secure: false, headers: { 'x-forwarded-proto': 'https' } };
    assert.equal(auth.isSecureConnection(reqTraefikHttps), true);

    const reqTraefikHttp = { secure: false, headers: { 'x-forwarded-proto': 'http' } };
    assert.equal(auth.isSecureConnection(reqTraefikHttp), false);

    const cookieHttp = auth.getCookieHeader('tok.sig', false);
    assert.ok(!cookieHttp.includes('Secure'), 'HTTP cookie must not have Secure flag');

    const cookieHttps = auth.getCookieHeader('tok.sig', true);
    assert.ok(cookieHttps.includes('Secure'), 'HTTPS cookie must have Secure flag');
  });
});
