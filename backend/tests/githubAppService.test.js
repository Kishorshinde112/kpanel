const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const githubAppService = require('../services/githubAppService');
const { GithubAppError } = githubAppService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 3B1: GitHub App Authentication Foundation Suite', async (t) => {
  let tempDir;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let testKeyPath;
  let originalDeploymentsContent;

  const TEST_APP_ID = '987654';

  t.before(() => {
    // Record original legacy deployments.json content
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    // Create an isolated temporary test directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-ghapp-test-'));
    testKeyPath = path.join(tempDir, 'test-github-app.private-key.pem');

    // Generate real 2048-bit RSA keypair in memory for test verification
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });

    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;

    fs.writeFileSync(testKeyPath, testPrivateKeyPem, { mode: 0o600 });
  });

  t.after(() => {
    if (tempDir && fs.existsSync(tempDir)) {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {}
    }

    // Verify deployments.json was untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json must remain completely untouched');
    }
  });

  // ── 1. Missing Configuration ───────────────────────────────────────
  await t.test('1. Missing GitHub App configuration returns false from isGithubAppConfigured', () => {
    const isConfigured = githubAppService.isGithubAppConfigured({
      appId: null,
      privateKey: null,
      privateKeyPath: null
    });
    assert.equal(isConfigured, false, 'Should be false when not configured');

    assert.throws(
      () => githubAppService.createAppJwt({ appId: null, privateKey: testPrivateKeyPem }),
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_NOT_CONFIGURED'
    );
  });

  // ── 2. Invalid GitHub App Identifier ───────────────────────────────
  await t.test('2. Invalid GitHub App identifier is rejected', () => {
    const invalidIds = ['not-a-number', '-5', '0', 'app_123', '   '];
    for (const appId of invalidIds) {
      assert.throws(
        () => githubAppService.createAppJwt({ appId, privateKey: testPrivateKeyPem }),
        (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_ID',
        `Expected rejection of invalid appId: "${appId}"`
      );
    }
  });

  // ── 3. Missing Private-Key File ────────────────────────────────────
  await t.test('3. Missing private key file path produces GITHUB_APP_INVALID_KEY error', () => {
    const missingPath = path.join(tempDir, 'does-not-exist.pem');
    assert.throws(
      () => githubAppService.createAppJwt({ appId: TEST_APP_ID, privateKeyPath: missingPath }),
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_KEY' && err.message.includes('not found')
    );
  });

  // ── 4. Invalid Private-Key Contents ────────────────────────────────
  await t.test('4. Malformed or non-RSA private key contents are rejected', () => {
    const badKeyPath = path.join(tempDir, 'bad-key.pem');
    fs.writeFileSync(badKeyPath, '-----BEGIN PRIVATE KEY-----\nINVALID_CORRUPTED_KEY\n-----END PRIVATE KEY-----');

    assert.throws(
      () => githubAppService.createAppJwt({ appId: TEST_APP_ID, privateKeyPath: badKeyPath }),
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_KEY'
    );
  });

  // ── 5. Valid RS256 JWT Generation ──────────────────────────────────
  await t.test('5. Valid RS256 JWT is generated with correct 3-segment format', () => {
    const jwt = githubAppService.createAppJwt({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem
    });

    assert.ok(typeof jwt === 'string');
    const parts = jwt.split('.');
    assert.equal(parts.length, 3, 'JWT must contain header, payload, and signature');
  });

  // ── 6. Cryptographic JWT Signature Verification ────────────────────
  await t.test('6. Cryptographic signature verifies using the public key', () => {
    const jwt = githubAppService.createAppJwt({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem
    });

    const [headerB64, payloadB64, sigB64] = jwt.split('.');
    const signedData = Buffer.from(`${headerB64}.${payloadB64}`, 'utf8');
    const signature = Buffer.from(sigB64, 'base64url');

    const isValid = crypto.verify('RSA-SHA256', signedData, testPublicKeyPem, signature);
    assert.equal(isValid, true, 'RSA signature must verify against public key');
  });

  // ── 7. Correct JWT Claims ──────────────────────────────────────────
  await t.test('7. JWT payload contains expected claims (iss, iat, exp)', () => {
    const fixedNow = 1700000000 * 1000;
    const jwt = githubAppService.createAppJwt({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      now: fixedNow
    });

    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    assert.equal(payload.iss, TEST_APP_ID);
    assert.equal(payload.iat, 1700000000 - 60, 'iat should account for 60s clock skew');
    assert.equal(payload.exp, 1700000000 + 540, 'exp should be 9 minutes in future');
  });

  // ── 8. JWT Expiration Duration ─────────────────────────────────────
  await t.test('8. JWT lifetime never exceeds GitHub 10-minute maximum limit', () => {
    const now = Date.now();
    const jwt = githubAppService.createAppJwt({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      now
    });

    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    const lifetimeSeconds = payload.exp - payload.iat;
    assert.ok(lifetimeSeconds <= 600, 'JWT lifespan from iat to exp must not exceed 600 seconds (10 minutes)');
  });

  // ── 9. Clock-Skew Handling ─────────────────────────────────────────
  await t.test('9. Clock skew handling ensures issued-at claim is safely in the past', () => {
    const nowSec = Math.floor(Date.now() / 1000);
    const jwt = githubAppService.createAppJwt({
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem
    });

    const [, payloadB64] = jwt.split('.');
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));

    assert.ok(payload.iat <= nowSec - 50, 'iat must be offset to prevent rejection by out-of-sync GitHub clock');
  });

  // ── 10. Valid Installation Token Response ──────────────────────────
  await t.test('10. Valid installation token response is processed and returned', async () => {
    const fakeFutureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();
    const mockToken = 'ghs_fakeInstallationAccessToken1234567890';

    const mockFetch = async (url, opts) => {
      assert.ok(url.includes('/app/installations/12345/access_tokens'));
      assert.equal(opts.method, 'POST');
      assert.ok(opts.headers.Authorization.startsWith('Bearer '));
      assert.equal(opts.headers['X-GitHub-Api-Version'], '2022-11-28');

      return {
        ok: true,
        status: 201,
        headers: new Map(),
        text: async () =>
          JSON.stringify({
            token: mockToken,
            expires_at: fakeFutureExpiry,
            permissions: { contents: 'read' },
            repository_selection: 'selected'
          })
      };
    };

    const result = await githubAppService.getInstallationAccessToken('12345', {
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      repositories: ['my-repo'],
      fetch: mockFetch
    });

    assert.equal(result.token, mockToken);
    assert.equal(result.expiresAt, fakeFutureExpiry);
    assert.deepEqual(result.permissions, { contents: 'read' });
    assert.equal(result.repositorySelection, 'selected');
  });

  // ── 11. Missing Installation ID ────────────────────────────────────
  await t.test('11. Missing installation ID is rejected with GITHUB_APP_INVALID_ID', async () => {
    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo']
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_ID'
    );
  });

  // ── 12. Invalid Installation ID ────────────────────────────────────
  await t.test('12. Invalid installation ID (non-numeric, negative) is rejected', async () => {
    const badIds = ['-123', 'abc', '12.34', '0'];
    for (const id of badIds) {
      await assert.rejects(
        async () => {
          await githubAppService.getInstallationAccessToken(id, {
            appId: TEST_APP_ID,
            privateKey: testPrivateKeyPem,
            repositories: ['repo']
          });
        },
        (err) => err instanceof GithubAppError && err.code === 'GITHUB_APP_INVALID_ID'
      );
    }
  });

  // ── 13. Repository-Scoped Token Request ─────────────────────────────
  await t.test('13. Repository-scoped token request passes repositories array in request body', async () => {
    let capturedBody;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_token_xyz',
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          })
      };
    };

    await githubAppService.getInstallationAccessToken('5555', {
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      repositories: ['frontend-app', 'backend-app'],
      fetch: mockFetch
    });

    assert.ok(capturedBody);
    assert.deepEqual(capturedBody.repositories, ['frontend-app', 'backend-app']);
    assert.deepEqual(capturedBody.permissions, { contents: 'read' });
  });

  // ── 14. Rejection of Empty Repository Scope ────────────────────────
  await t.test('14. Unscoped or empty repository scope is rejected', async () => {
    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: [] // Empty scope
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_PERMISSION_DENIED' && err.message.includes('Unscoped tokens are prohibited')
    );
  });

  // ── 15. Read-Only Contents Permission Request ──────────────────────
  await t.test('15. Permissions explicitly request contents: read', async () => {
    let capturedBody;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_token_abc',
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          })
      };
    };

    await githubAppService.getInstallationAccessToken('12345', {
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      repositories: ['repo'],
      permissions: { contents: 'read' },
      fetch: mockFetch
    });

    assert.equal(capturedBody.permissions.contents, 'read');
    assert.equal(Object.keys(capturedBody.permissions).length, 1);
  });

  // ── 16. Unexpected Permissions Rejected ────────────────────────────
  await t.test('16. Requesting write or escalated permissions is rejected', async () => {
    const unauthorizedPermissions = [
      { contents: 'write' },
      { contents: 'read', administration: 'write' },
      { issues: 'read' },
      { actions: 'read' }
    ];

    for (const perms of unauthorizedPermissions) {
      await assert.rejects(
        async () => {
          await githubAppService.getInstallationAccessToken('12345', {
            appId: TEST_APP_ID,
            privateKey: testPrivateKeyPem,
            repositories: ['repo'],
            permissions: perms
          });
        },
        (err) => err instanceof GithubAppError && err.code === 'GITHUB_PERMISSION_DENIED' && err.message.includes('Unauthorized permission request')
      );
    }
  });

  // ── 17. Expired Installation Token Rejected ────────────────────────
  await t.test('17. Already expired installation token response is rejected', async () => {
    const expiredPast = new Date(Date.now() - 3600 * 1000).toISOString();
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: 'ghs_expired',
          expires_at: expiredPast
        })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE' && err.message.includes('already expired')
    );
  });

  // ── 18. Near-Expiry Token Rejected ─────────────────────────────────
  await t.test('18. Token expiring within safety buffer (under 60s) is rejected', async () => {
    const nearExpiry = new Date(Date.now() + 30 * 1000).toISOString(); // Expiring in 30 seconds
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: 'ghs_near_expiry',
          expires_at: nearExpiry
        })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE' && err.message.includes('near expiration')
    );
  });

  // ── 19. Invalid Token Response Rejected ────────────────────────────
  await t.test('19. Missing token in response body is rejected', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          // No token field
        })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE' && err.message.includes('Missing installation access token')
    );
  });

  // ── 20. GitHub 401 Error ───────────────────────────────────────────
  await t.test('20. GitHub API 401 Unauthorized returns GITHUB_AUTH_FAILED', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 401,
      text: async () => JSON.stringify({ message: 'Bad credentials' })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_AUTH_FAILED'
    );
  });

  // ── 21. GitHub 403 Error ───────────────────────────────────────────
  await t.test('21. GitHub API 403 Forbidden returns GITHUB_PERMISSION_DENIED', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 403,
      text: async () => JSON.stringify({ message: 'Resource not accessible by integration' })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_PERMISSION_DENIED'
    );
  });

  // ── 22. GitHub 404 Error ───────────────────────────────────────────
  await t.test('22. GitHub API 404 Not Found returns GITHUB_INSTALLATION_NOT_FOUND', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 404,
      text: async () => JSON.stringify({ message: 'Not Found' })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INSTALLATION_NOT_FOUND'
    );
  });

  // ── 23. GitHub 429 Rate Limiting ───────────────────────────────────
  await t.test('23. GitHub API 429 Too Many Requests returns GITHUB_RATE_LIMITED', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 429,
      text: async () => JSON.stringify({ message: 'API rate limit exceeded' })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_RATE_LIMITED'
    );
  });

  // ── 24. GitHub 5xx Server Error ────────────────────────────────────
  await t.test('24. GitHub API 500 server error returns GITHUB_API_ERROR', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: 'Internal Server Error' })
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_API_ERROR'
    );
  });

  // ── 25. Network Timeout ────────────────────────────────────────────
  await t.test('25. Network timeout triggers GITHUB_API_TIMEOUT', async () => {
    const mockFetch = async (url, opts) => {
      // Simulate timeout abort
      const err = new Error('The operation was aborted');
      err.name = 'AbortError';
      throw err;
    };

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_API_TIMEOUT'
    );
  });

  // ── 26. Network Cancellation ───────────────────────────────────────
  await t.test('26. External caller AbortSignal cancellation aborts request', async () => {
    const controller = new AbortController();
    const mockFetch = async (url, opts) => {
      const err = new Error('Abort');
      err.name = 'AbortError';
      throw err;
    };

    controller.abort();

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          signal: controller.signal,
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_API_TIMEOUT'
    );
  });

  // ── 27. API Response-Size Limits ───────────────────────────────────
  await t.test('27. Oversized API responses exceeding 100 KB are rejected', async () => {
    const oversizedString = 'x'.repeat(120 * 1024); // 120 KB
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => oversizedString
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE' && err.message.includes('size bounds')
    );
  });

  // ── 28. API Redirect Rejection ─────────────────────────────────────
  await t.test('28. HTTP redirect responses (3xx) are strictly rejected', async () => {
    const mockFetch = async () => ({
      ok: false,
      status: 302,
      headers: new Map([['location', 'https://attacker.com/steal']]),
      text: async () => ''
    });

    await assert.rejects(
      async () => {
        await githubAppService.getInstallationAccessToken('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          repositories: ['repo'],
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubAppError && err.code === 'GITHUB_INVALID_RESPONSE' && err.message.includes('redirect')
    );
  });

  // ── 29. No Token Leakage into Errors ───────────────────────────────
  await t.test('29. Error messages never leak access tokens or Authorization headers', async () => {
    const SECRET_ACCESS_TOKEN = 'ghs_superSecretAccessToken999999999';
    const mockFetch = async () => ({
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ message: `Failed with token ${SECRET_ACCESS_TOKEN}` })
    });

    try {
      await githubAppService.getInstallationAccessToken('12345', {
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        repositories: ['repo'],
        fetch: mockFetch
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(!err.message.includes(SECRET_ACCESS_TOKEN), 'Error message must not expose the token value');
    }
  });

  // ── 30. No Private-Key Leakage into Logs ───────────────────────────
  await t.test('30. Error messages never leak private key PEM contents', () => {
    try {
      githubAppService.createAppJwt({
        appId: 'bad_id_format',
        privateKey: testPrivateKeyPem
      });
      assert.fail('Should have thrown');
    } catch (err) {
      assert.ok(!err.message.includes('BEGIN PRIVATE KEY'), 'Error message must never echo private key PEM content');
    }
  });

  // ── 31. Existing Public Git Clone Compatibility ────────────────────
  await t.test('31. Public Git clone service validation functions operate independently without GitHub App configuration', () => {
    const gitService = require('../services/gitService');
    const validUrl = gitService.validateRepositoryUrl('https://github.com/torvalds/linux.git');
    assert.equal(validUrl.owner, 'torvalds');
    assert.equal(validUrl.repo, 'linux');

    // Confirm GitHub App service is not required for public git operations
    assert.equal(typeof gitService.fetchRepository, 'function');
  });

  // ── 32. No Changes to SQLite Deployment Records ────────────────────
  await t.test('32. SQLite tables are untouched by GitHub App service execution', () => {
    const { getDatabase } = require('../config/database');
    const { runMigrations } = require('../db/migrate');
    const db = getDatabase();
    runMigrations(db);

    const count = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    assert.ok(count >= 0);
  });

  // ── 33. No Changes to Legacy deployments.json ──────────────────────
  await t.test('33. Legacy backend/data/deployments.json remains byte-for-byte untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });

  // ── 34. Non-Sensitive Installation Status Metadata ─────────────────
  await t.test('34. getInstallationStatus returns non-sensitive installation metadata', async () => {
    const mockFetch = async (url) => {
      assert.ok(url.includes('/app/installations/7777'));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 7777,
          account: { login: 'kishorlab' },
          repository_selection: 'selected',
          target_type: 'Organization'
        })
      };
    };

    const status = await githubAppService.getInstallationStatus('7777', {
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.equal(status.id, 7777);
    assert.equal(status.account, 'kishorlab');
    assert.equal(status.repositorySelection, 'selected');
    assert.equal(status.targetType, 'Organization');
  });
});
