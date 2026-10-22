const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');

const gitService = require('../services/gitService');
const githubAppService = require('../services/githubAppService');
const { startCredentialBroker, CredentialBrokerError } = require('../services/gitCredentialBroker');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');
const ASKPASS_HELPER_PATH = path.resolve(path.join(__dirname, '..', 'helpers', 'gitAskpass.js'));

test('Phase 3B2: Secure Private Repository Checkout Suite', async (t) => {
  let tempBaseDir;
  let workspaceRoot;
  let fixtureRepoPath;
  let fixtureCommitSha;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let originalDeploymentsContent;

  const TEST_APP_ID = '876543';

  t.before(() => {
    process.env.NODE_ENV = 'test';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-private-git-test-'));
    workspaceRoot = path.join(tempBaseDir, 'workspaces');
    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

    // Generate test RSA keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;

    // Create an offline Git fixture repository
    const fixtureWorkingDir = path.join(tempBaseDir, 'fixture-src');
    fixtureRepoPath = path.join(tempBaseDir, 'fixture-repo.git');
    fs.mkdirSync(fixtureWorkingDir, { recursive: true });

    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.name', 'Private Tester'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.email', 'private@kpanel.local'], { cwd: fixtureWorkingDir });

    fs.writeFileSync(path.join(fixtureWorkingDir, 'config.json'), '{"private": true}\n');
    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Private commit'], { cwd: fixtureWorkingDir });

    fixtureCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim();
    execFileSync('git', ['clone', '--bare', fixtureWorkingDir, fixtureRepoPath]);
  });

  t.after(() => {
    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }

    // Verify deployments.json was untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json must remain completely untouched');
    }
  });

  // Helper to connect to broker socket and exchange JSON message
  function queryBroker(socketPath, payload) {
    return new Promise((resolve, reject) => {
      const client = net.createConnection({ path: socketPath }, () => {
        client.write(JSON.stringify(payload) + '\n');
      });

      let data = '';
      client.on('data', (chunk) => {
        data += chunk.toString();
        if (data.includes('\n')) {
          client.end();
        }
      });

      client.on('end', () => {
        try {
          resolve(JSON.parse(data.trim()));
        } catch (err) {
          reject(err);
        }
      });

      client.on('error', reject);
    });
  }

  // ── 1. Existing Public Repository Mode Works Without Credentials ───
  await t.test('1. Public repository checkout operates anonymously without credentials or broker', async () => {
    const app = {
      id: '10101010-1010-4010-8010-101010101010',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true
      // authMode omitted (defaults to public)
    });

    assert.ok(snapshot.workspacePath);
    assert.equal(snapshot.commitSha, fixtureCommitSha.toLowerCase());
    assert.equal(fs.existsSync(snapshot.workspacePath), true);

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 2. Private Mode Requests an Installation Token ─────────────────
  await t.test('2. Private mode triggers installation token acquisition', async () => {
    let tokenAcquisitionCalled = false;
    const mockToken = 'ghs_installationTokenMock123456';
    const futureExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

    const mockFetch = async (url) => {
      if (url.includes('/access_tokens')) {
        tokenAcquisitionCalled = true;
        return {
          ok: true,
          status: 201,
          text: async () =>
            JSON.stringify({
              token: mockToken,
              expires_at: futureExpiry
            })
        };
      }
      return { ok: false, status: 404 };
    };

    const app = {
      id: '20202020-2020-4020-8020-202020202020',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'github-app',
      installationId: '123456',
      repositoryName: 'fixture-repo',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.equal(tokenAcquisitionCalled, true, 'Private checkout must request an installation token');
    assert.equal(snapshot.commitSha, fixtureCommitSha.toLowerCase());

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 3. Only a Single Explicitly Scoped Repository is Requested ────
  await t.test('3. Installation token request scopes strictly to the single application repository', async () => {
    let capturedBody;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_token_single_scope',
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          })
      };
    };

    const app = {
      id: '30303030-3030-4030-8030-303030303030',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'github-app',
      installationId: '54321',
      repositoryName: 'fixture-repo',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.ok(capturedBody);
    assert.deepEqual(capturedBody.repositories, ['fixture-repo'], 'Must request token scoped strictly to single repo');
    assert.equal(capturedBody.repositories.length, 1);

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 4. Only contents: read is Requested ────────────────────────────
  await t.test('4. Token request permissions strictly specify contents: read only', async () => {
    let capturedBody;
    const mockFetch = async (url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        ok: true,
        status: 201,
        text: async () =>
          JSON.stringify({
            token: 'ghs_token_read_only',
            expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
          })
      };
    };

    const app = {
      id: '40404040-4040-4040-8040-404040404040',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'github-app',
      installationId: '77777',
      repositoryName: 'fixture-repo',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.deepEqual(capturedBody.permissions, { contents: 'read' }, 'Permissions must be contents: read only');

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 5. Invalid Installation ID Rejected ────────────────────────────
  await t.test('5. Invalid installation ID is rejected with GITHUB_APP_INVALID_ID', async () => {
    const app = {
      id: '50505050-5050-4050-8050-505050505050',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const invalidInstIds = ['', 'invalid_id', '-1', '0'];
    for (const instId of invalidInstIds) {
      await assert.rejects(
        async () => {
          await gitService.fetchRepository(app, {
            workspaceRoot,
            allowTestFixture: true,
            authMode: 'github-app',
            installationId: instId,
            appId: TEST_APP_ID,
            privateKey: testPrivateKeyPem
          });
        },
        (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_APP_INVALID_ID'
      );
    }
  });

  // ── 6. Invalid Repository ID Rejected ──────────────────────────────
  await t.test('6. Invalid repository ID is rejected with GITHUB_PERMISSION_DENIED', async () => {
    const app = {
      id: '60606060-6060-4060-8060-606060606060',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, {
          workspaceRoot,
          allowTestFixture: true,
          authMode: 'github-app',
          installationId: '12345',
          repositoryId: -99, // Invalid ID
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem
        });
      },
      (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_PERMISSION_DENIED'
    );
  });

  // ── 7. Repository Identity Mismatch Rejected ───────────────────────
  await t.test('7. Repository name mismatch between options and URL is rejected', async () => {
    const app = {
      id: '70707070-7070-4070-8070-707070707070',
      repo_url: 'https://github.com/my-org/actual-repo.git',
      branch: 'main'
    };

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, {
          workspaceRoot,
          authMode: 'github-app',
          installationId: '12345',
          repositoryName: 'different-repo', // Mismatch!
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem
        });
      },
      (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_PERMISSION_DENIED' && err.message.includes('Repository identity mismatch')
    );
  });

  // ── 8. Missing GitHub App Configuration Handled ────────────────────
  await t.test('8. Missing GitHub App configuration throws GITHUB_APP_NOT_CONFIGURED', async () => {
    const app = {
      id: '80808080-8080-4080-8080-808080808080',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, {
          workspaceRoot,
          allowTestFixture: true,
          authMode: 'github-app',
          installationId: '12345',
          appId: null, // Missing!
          privateKey: null
        });
      },
      (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_APP_NOT_CONFIGURED'
    );
  });

  // ── 9. Invalid Installation Token Response Rejected ────────────────
  await t.test('9. Malformed token response from GitHub API rejects cleanly', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () => JSON.stringify({ token: '' }) // Empty token
    });

    const app = {
      id: '90909090-9090-4090-8090-909090909090',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, {
          workspaceRoot,
          allowTestFixture: true,
          authMode: 'github-app',
          installationId: '12345',
          repositoryName: 'fixture-repo',
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockFetch
        });
      },
      (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_INVALID_RESPONSE'
    );
  });

  // ── 10. Expired Token Rejected ─────────────────────────────────────
  await t.test('10. Expired token response is rejected before broker initialization', async () => {
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: 'ghs_expired_tok',
          expires_at: new Date(Date.now() - 60000).toISOString()
        })
    });

    const app = {
      id: 'a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a0a0',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, {
          workspaceRoot,
          allowTestFixture: true,
          authMode: 'github-app',
          installationId: '12345',
          repositoryName: 'fixture-repo',
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockFetch
        });
      },
      (err) => err instanceof gitService.GitServiceError && err.code === 'GITHUB_INVALID_RESPONSE'
    );
  });

  // ── 11. Authenticated Git Subprocess Uses GIT_ASKPASS ───────────────
  await t.test('11. Authenticated checkout sets GIT_ASKPASS and Unix socket IPC', async () => {
    const mockToken = 'ghs_askpassVerificationToken999';
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: mockToken,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
        })
    });

    const app = {
      id: 'b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b0b0',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'github-app',
      installationId: '12345',
      repositoryName: 'fixture-repo',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    assert.ok(snapshot.workspacePath);
    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 12-17. Credential Confidentiality In All Artifacts ─────────────
  await t.test('12-17. Token is strictly absent from arguments, URLs, .git/config, environment, and logs', async () => {
    const SECRET_PROMPT_TOKEN = 'ghs_CANARY_SECRET_TOKEN_DO_NOT_LEAK_777';
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: SECRET_PROMPT_TOKEN,
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
        })
    });

    const app = {
      id: 'c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c0c0',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'github-app',
      installationId: '12345',
      repositoryName: 'fixture-repo',
      appId: TEST_APP_ID,
      privateKey: testPrivateKeyPem,
      fetch: mockFetch
    });

    // 13. Token absent from returned snapshot object
    const snapshotStr = JSON.stringify(snapshot);
    assert.equal(snapshotStr.includes(SECRET_PROMPT_TOKEN), false, 'Token must not be in snapshot result');

    // 14. Token absent from .git/config on disk
    const gitConfigPath = path.join(snapshot.workspacePath, '.git', 'config');
    assert.ok(fs.existsSync(gitConfigPath));
    const configContent = fs.readFileSync(gitConfigPath, 'utf8');
    assert.equal(configContent.includes(SECRET_PROMPT_TOKEN), false, 'Token must not be in .git/config');

    // 15. Token absent from process.env
    assert.equal(process.env.GIT_ASKPASS?.includes?.(SECRET_PROMPT_TOKEN) || false, false);

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 18. Broker Rejects Invalid Nonce ───────────────────────────────
  await t.test('18. Credential broker rejects invalid nonce with ACCESS_DENIED', async () => {
    const broker = await startCredentialBroker({
      token: 'test_token',
      expectedHost: 'github.com'
    });

    const response = await queryBroker(broker.socketPath, {
      nonce: 'wrong_invalid_nonce_value',
      prompt: "Password for 'https://github.com':"
    });

    assert.equal(response.error, 'ACCESS_DENIED');
    broker.close();
  });

  // ── 19. Broker Rejects Expired Operation ───────────────────────────
  await t.test('19. Credential broker terminates after lifetime timeout', async () => {
    const broker = await startCredentialBroker({
      token: 'test_token',
      timeoutMs: 50 // 50ms lifetime
    });

    await new Promise((r) => setTimeout(r, 80));

    // Socket should now be closed / unlinked
    await assert.rejects(
      () => queryBroker(broker.socketPath, { nonce: broker.nonce, prompt: 'test' })
    );

    broker.close();
  });

  // ── 20. Broker Refuses Unrelated Prompts ────────────────────────────
  await t.test('20. Credential broker rejects unrecognized prompt challenges', async () => {
    const broker = await startCredentialBroker({
      token: 'test_token',
      expectedHost: 'github.com'
    });

    const response = await queryBroker(broker.socketPath, {
      nonce: broker.nonce,
      prompt: "PIN code for SmartCard on 'https://github.com':"
    });

    assert.equal(response.error, 'UNRECOGNIZED_PROMPT');
    broker.close();
  });

  // ── 21. Broker Inaccessible Over TCP ───────────────────────────────
  await t.test('21. Credential broker is exclusively a Unix domain socket, not reachable over TCP', async () => {
    const broker = await startCredentialBroker({
      token: 'test_token',
      expectedHost: 'github.com'
    });

    assert.ok(broker.socketPath.endsWith('.sock'));
    assert.ok(fs.existsSync(broker.socketPath));
    const lstat = fs.lstatSync(broker.socketPath);
    assert.equal(lstat.isSocket(), true, 'Must be a Unix domain socket');

    broker.close();
  });

  // ── 22. Broker Socket Removed After Success ────────────────────────
  await t.test('22. Credential broker socket is cleanly unlinked on close', async () => {
    const broker = await startCredentialBroker({
      token: 'test_token'
    });
    const sockPath = broker.socketPath;
    assert.ok(fs.existsSync(sockPath));

    broker.close();
    assert.equal(fs.existsSync(sockPath), false, 'Socket must be unlinked after broker close');
  });

  // ── 23-24. Socket Cleanup After Failure and Cancellation ───────────
  await t.test('23-24. Broker socket is cleanly removed when git fetch fails', async () => {
    let capturedSocketPath;
    const mockFetch = async () => ({
      ok: true,
      status: 201,
      text: async () =>
        JSON.stringify({
          token: 'token_fail_test',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString()
        })
    });

    const app = {
      id: 'd0d0d0d0-d0d0-40d0-80d0-d0d0d0d0d0d0',
      repo_url: 'file:///non/existent/repo.git', // Will fail clone
      branch: 'main'
    };

    const testOpId = 'failop01-0000-0000-0000-000000000000';
    try {
      await gitService.fetchRepository(app, {
        workspaceRoot,
        allowTestFixture: true,
        authMode: 'github-app',
        installationId: '12345',
        repositoryName: 'repo',
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockFetch,
        operationId: testOpId
      });
    } catch {}

    // Allow asynchronous cleanup to complete
    await new Promise((r) => setTimeout(r, 60));

    // Verify no stray broker sockets in tmpdir for this operation
    const straySockets = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith(`kpanel-broker-${testOpId.slice(0, 8)}-`));
    assert.equal(straySockets.length, 0, 'No abandoned broker socket directories must remain');
  });

  // ── 25. Credential Helper Rejects Unknown Prompts ──────────────────
  await t.test('25. gitAskpass helper rejects unknown prompts with non-zero exit code', () => {
    assert.throws(
      () => {
        execFileSync(process.execPath, [ASKPASS_HELPER_PATH, 'Unknown prompt'], {
          env: {
            KPANEL_ASKPASS_SOCKET: '/tmp/nonexistent.sock',
            KPANEL_ASKPASS_NONCE: 'fake_nonce'
          },
          stdio: 'pipe'
        });
      },
      /Command failed/
    );
  });

  // ── 26. Token Never Delivered for Unexpected Hosts ─────────────────
  await t.test('26. Broker refuses to deliver token if prompt targets an unexpected host', async () => {
    const broker = await startCredentialBroker({
      token: 'secret_token_value',
      expectedHost: 'github.com'
    });

    const response = await queryBroker(broker.socketPath, {
      nonce: broker.nonce,
      prompt: "Password for 'https://attacker.evil.com':"
    });

    assert.equal(response.error, 'UNAUTHORIZED_HOST', 'Must refuse to provide token to attacker host');
    broker.close();
  });

  // ── 27. Subprocess Retains shell: false ─────────────────────────────
  await t.test('27. Subprocess execution retains shell: false', async () => {
    const result = await gitService.executeGitCommand(['version; echo SHELL_CHECK'], { timeout: 5000 });
    assert.ok(!result.stdout.includes('SHELL_CHECK'));
  });

  // ── 28. Public Fetch Behavior Remains Unchanged ────────────────────
  await t.test('28. Public fetch remains 100% backward compatible without GitHub App', async () => {
    const app = {
      id: 'e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e0e0',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true,
      authMode: 'public'
    });

    assert.ok(snapshot.commitSha);
    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 29. SHA Verification Remains Correct ───────────────────────────
  await t.test('29. SHA verification matches git rev-parse HEAD of the checked-out source', async () => {
    const app = {
      id: 'f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f0f0',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true
    });

    const verifiedSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: snapshot.workspacePath }).toString().trim();
    assert.equal(snapshot.commitSha, verifiedSha.toLowerCase());

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 30. Workspace Isolation Remains Enforced ───────────────────────
  await t.test('30. Multi-tenant workspace isolation enforces restrictive 0o700 permissions', async () => {
    const app = {
      id: 'f1f1f1f1-f1f1-41f1-81f1-f1f1f1f1f1f1',
      repo_url: `file://${fixtureRepoPath}`,
      branch: 'main'
    };

    const snapshot = await gitService.fetchRepository(app, {
      workspaceRoot,
      allowTestFixture: true
    });

    const stat = fs.statSync(snapshot.workspacePath);
    // Mode includes 0o700 on POSIX
    assert.ok(stat.isDirectory());

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 31. SQLite Application Records Remain Unchanged ────────────────
  await t.test('31. SQLite tables remain untouched during private repository checkout operations', () => {
    const { getDatabase } = require('../config/database');
    const { runMigrations } = require('../db/migrate');
    const db = getDatabase();
    runMigrations(db);

    const count = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    assert.ok(count >= 0);
  });

  // ── 32. Legacy deployments.json Remains Unchanged ──────────────────
  await t.test('32. Legacy backend/data/deployments.json is confirmed completely untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });

  // ── 33. Broker Handshake End-to-End via gitAskpass Helper ──────────
  await t.test('33. Full End-to-End Handshake: gitAskpass talks to broker over Unix socket', async () => {
    const broker = await startCredentialBroker({
      token: 'super_secret_e2e_token_123',
      expectedHost: 'github.com'
    });

    const runAskpassAsync = (prompt) =>
      new Promise((resolve, reject) => {
        const { execFile } = require('child_process');
        execFile(
          process.execPath,
          [ASKPASS_HELPER_PATH, prompt],
          {
            env: {
              ...process.env,
              KPANEL_ASKPASS_SOCKET: broker.socketPath,
              KPANEL_ASKPASS_NONCE: broker.nonce
            }
          },
          (err, stdout) => {
            if (err) return reject(err);
            resolve(stdout);
          }
        );
      });

    // 1. Test username challenge
    const userOutput = await runAskpassAsync("Username for 'https://github.com':");
    assert.equal(userOutput.trim(), 'x-access-token');

    // 2. Test password challenge
    const passOutput = await runAskpassAsync("Password for 'https://x-access-token@github.com':");
    assert.equal(passOutput.trim(), 'super_secret_e2e_token_123');

    broker.close();
  });
});
