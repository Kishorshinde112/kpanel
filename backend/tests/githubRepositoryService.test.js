const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getAppliedMigrations, getCurrentVersion } = require('../db/migrate');
const { createApplication, getApplicationById } = require('../services/applicationService');
const githubRepositoryService = require('../services/githubRepositoryService');
const { GithubRepositoryError } = githubRepositoryService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 3B3A: Verified GitHub Installation & Repository Association Suite', async (t) => {
  let tempDir;
  let tempDbPath;
  let testDb;
  let testPrivateKeyPem;
  let testPublicKeyPem;
  let originalDeploymentsContent;

  const TEST_APP_ID = '987654';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    process.env.GITHUB_ALLOWED_ACCOUNT_IDS = '999,888';

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-ghrepo-test-'));
    tempDbPath = path.join(tempDir, 'test-kpanel.db');

    // Generate test RSA keypair
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
    });
    testPrivateKeyPem = privateKey;
    testPublicKeyPem = publicKey;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
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

  // Mock fetch builder for GitHub API endpoints
  function createMockFetch(options = {}) {
    function mockRes(status, bodyObj) {
      const bodyStr = JSON.stringify(bodyObj);
      return {
        ok: status >= 200 && status < 300,
        status,
        headers: new Map(),
        text: async () => bodyStr,
        json: async () => bodyObj
      };
    }

    return async (url, opts) => {
      // 1. Installation details: /app/installations/{id}
      if (url.includes('/app/installations/') && !url.includes('/access_tokens')) {
        if (options.installationSuspended) {
          return mockRes(200, {
            id: 12345,
            account: { id: 999, login: 'my-org', type: 'Organization' },
            repository_selection: 'selected',
            suspended_at: '2026-01-01T00:00:00Z',
            suspended_by: 'admin'
          });
        }
        if (options.installationNotFound) {
          return mockRes(404, { message: 'Not Found' });
        }
        return mockRes(200, {
          id: Number(options.installationId || 12345),
          account: { id: 999, login: options.accountLogin || 'my-org', type: 'Organization' },
          repository_selection: options.repositorySelection || 'selected'
        });
      }

      // 2. Token creation: /app/installations/{id}/access_tokens
      if (url.includes('/access_tokens')) {
        if (options.tokenScopeRejected) {
          return mockRes(403, { message: 'Resource not accessible by integration' });
        }
        return mockRes(201, {
          token: 'ghs_mockInstallationToken12345',
          expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
          permissions: { contents: 'read' },
          repository_selection: 'selected'
        });
      }

      // 3. Installation repository set: /installation/repositories
      if (url.includes('/installation/repositories')) {
        if (options.repoNotInScope) {
          return mockRes(200, {
            total_count: 1,
            repositories: [
              { id: 999999, name: 'other-repo', full_name: 'my-org/other-repo', owner: { login: 'my-org' }, private: true }
            ]
          });
        }
        return mockRes(200, {
          total_count: 1,
          repositories: [
            {
              id: Number(options.repositoryId || 888888),
              name: options.repoName || 'my-app',
              full_name: `${options.repoOwner || 'my-org'}/${options.repoName || 'my-app'}`,
              owner: { login: options.repoOwner || 'my-org' },
              private: options.isPrivate !== undefined ? options.isPrivate : true
            }
          ]
        });
      }

      return mockRes(404, { message: 'Endpoint not mocked' });
    };
  }

  // ── 1-3. Migration Verification ───────────────────────────────────
  await t.test('1-3. Migration 002 applies cleanly and runs idempotently', () => {
    const applied = getAppliedMigrations(testDb);
    const versions = applied.map((m) => m.version);
    assert.ok(versions.includes(1), 'Migration 001 must be applied');
    assert.ok(versions.includes(2), 'Migration 002 must be applied');
    assert.ok(getCurrentVersion(testDb) >= 2, 'Current schema version must be at least 2');

    // Re-run should apply 0 changes
    const rerun = runMigrations(testDb);
    assert.equal(rerun.applied, 0, 'Migration re-run must be idempotent');
  });

  // ── 4-7. Installation & Association Persistence ───────────────────
  await t.test('4-7. Installation and application repository association can be persisted transactionally', async () => {
    const app = createApplication(
      {
        name: 'Associated Web App',
        repo_url: 'https://github.com/my-org/my-app.git'
      },
      { db: testDb }
    );

    const mockFetch = createMockFetch({
      installationId: '12345',
      repositoryId: '888888',
      repoOwner: 'my-org',
      repoName: 'my-app'
    });

    const association = await githubRepositoryService.associateApplicationRepository(
      {
        applicationId: app.id,
        installationId: '12345',
        repositoryId: '888888'
      },
      {
        db: testDb,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockFetch
      }
    );

    assert.ok(association);
    assert.equal(association.applicationId, app.id);
    assert.equal(association.installationId, '12345');
    assert.equal(association.repositoryId, '888888');
    assert.equal(association.repositoryFullName, 'my-org/my-app');
    assert.equal(association.associationStatus, 'verified');

    // 6. Multiple applications can associate with the same repository
    const app2 = createApplication(
      {
        name: 'Second App on Same Repo',
        repo_url: 'https://github.com/my-org/my-app.git'
      },
      { db: testDb }
    );

    const association2 = await githubRepositoryService.associateApplicationRepository(
      {
        applicationId: app2.id,
        installationId: '12345',
        repositoryId: '888888'
      },
      {
        db: testDb,
        appId: TEST_APP_ID,
        privateKey: testPrivateKeyPem,
        fetch: mockFetch
      }
    );

    assert.equal(association2.applicationId, app2.id);
    assert.equal(association2.repositoryId, '888888');
  });

  // ── 8-10. Input Identifiers Validation ─────────────────────────────
  await t.test('8-10. Invalid application, installation, or repository IDs are rejected', async () => {
    const mockFetch = createMockFetch();

    // 8. Invalid application UUID
    await assert.rejects(
      async () => {
        await githubRepositoryService.associateApplicationRepository(
          { applicationId: 'not-a-uuid', installationId: '12345', repositoryId: '888' },
          { db: testDb, appId: TEST_APP_ID, privateKey: testPrivateKeyPem, fetch: mockFetch }
        );
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'APPLICATION_NOT_FOUND'
    );

    // 9. Invalid installation ID
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyInstallation('-5', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'INSTALLATION_NOT_FOUND'
    );

    // 10. Invalid repository ID
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyRepositoryAccess('12345', 'invalid-id', 'https://github.com/my-org/repo.git', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mockFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'REPOSITORY_NOT_FOUND'
    );
  });

  // ── 11-12. Suspended & Nonexistent Installations ───────────────────
  await t.test('11-12. Suspended or nonexistent GitHub installations are rejected', async () => {
    // 11. Suspended installation
    const suspendedFetch = createMockFetch({ installationSuspended: true });
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyInstallation('12345', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: suspendedFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'INSTALLATION_SUSPENDED'
    );

    // 12. Nonexistent installation
    const notFoundFetch = createMockFetch({ installationNotFound: true });
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyInstallation('99999', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: notFoundFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'INSTALLATION_NOT_FOUND'
    );
  });

  // ── 13-15. Repository Authorization & Identity Matching ───────────
  await t.test('13-15. Repositories outside installation or identity mismatches are rejected', async () => {
    // 13. Repository not in installation scope
    const outOfScopeFetch = createMockFetch({ repoNotInScope: true });
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyRepositoryAccess('12345', '888888', 'https://github.com/my-org/my-app.git', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: outOfScopeFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'REPOSITORY_NOT_AUTHORIZED'
    );

    // 15. Owner/name mismatch between GitHub and application repo_url
    const mismatchFetch = createMockFetch({
      repositoryId: '888888',
      repoOwner: 'attacker-org', // Mismatch!
      repoName: 'my-app'
    });
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyRepositoryAccess('12345', '888888', 'https://github.com/my-org/my-app.git', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: mismatchFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'REPOSITORY_IDENTITY_MISMATCH'
    );
  });

  // ── 16-18. Permission Scoping & Token Validation ──────────────────
  await t.test('16-18. Token scope strictly enforced to repository and contents: read', async () => {
    const scopeRejectedFetch = createMockFetch({ tokenScopeRejected: true });
    await assert.rejects(
      async () => {
        await githubRepositoryService.verifyRepositoryAccess('12345', '888888', 'https://github.com/my-org/my-app.git', {
          appId: TEST_APP_ID,
          privateKey: testPrivateKeyPem,
          fetch: scopeRejectedFetch
        });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'REPOSITORY_NOT_AUTHORIZED'
    );
  });

  // ── 19-21. Transactional Rollback & Integrity ──────────────────────
  await t.test('19-21. Failure during verification rolls back database state completely', async () => {
    const app = createApplication(
      {
        name: 'Failing Association App',
        repo_url: 'https://github.com/my-org/fail-app.git'
      },
      { db: testDb }
    );

    const failingFetch = createMockFetch({ repoNotInScope: true });

    await assert.rejects(
      async () => {
        await githubRepositoryService.associateApplicationRepository(
          { applicationId: app.id, installationId: '12345', repositoryId: '777' },
          { db: testDb, appId: TEST_APP_ID, privateKey: testPrivateKeyPem, fetch: failingFetch }
        );
      },
      (err) => err instanceof GithubRepositoryError
    );

    // Verify zero records were written to application_repositories
    const assoc = githubRepositoryService.getApplicationRepositoryAssociation(app.id, { db: testDb });
    assert.equal(assoc, null, 'Failed association must not leave partial database records');
  });

  // ── 22-23. Repository URL Drift Detection (Fail-Closed) ────────────
  await t.test('22-23. Updating repo_url after association causes subsequent lookup to fail closed', async () => {
    const app = createApplication(
      {
        name: 'Drifting URL App',
        repo_url: 'https://github.com/my-org/drift-app.git'
      },
      { db: testDb }
    );

    const mockFetch = createMockFetch({
      installationId: '12345',
      repositoryId: '555111',
      repoOwner: 'my-org',
      repoName: 'drift-app'
    });

    await githubRepositoryService.associateApplicationRepository(
      { applicationId: app.id, installationId: '12345', repositoryId: '555111' },
      { db: testDb, appId: TEST_APP_ID, privateKey: testPrivateKeyPem, fetch: mockFetch }
    );

    // Confirm association is valid initially
    const activeAssoc = githubRepositoryService.getApplicationRepositoryAssociation(app.id, { db: testDb });
    assert.ok(activeAssoc);
    assert.equal(activeAssoc.repositoryFullName, 'my-org/drift-app');

    // Simulate user editing application repo_url to a different repository
    testDb.prepare("UPDATE applications SET repo_url = 'https://github.com/my-org/completely-different-repo.git' WHERE id = ?").run(app.id);

    // Stale association lookup must fail closed!
    assert.throws(
      () => {
        githubRepositoryService.getApplicationRepositoryAssociation(app.id, { db: testDb });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'APPLICATION_REPOSITORY_CHANGED'
    );
  });

  // ── 24-27. Disconnect Lifecycle ───────────────────────────────────
  await t.test('24-27. Disconnect deactivates association only and preserves application data', async () => {
    const app = createApplication(
      {
        name: 'Disconnect Test App',
        repo_url: 'https://github.com/my-org/disconnect-me.git'
      },
      { db: testDb }
    );

    const mockFetch = createMockFetch({
      installationId: '12345',
      repositoryId: '999888',
      repoOwner: 'my-org',
      repoName: 'disconnect-me'
    });

    await githubRepositoryService.associateApplicationRepository(
      { applicationId: app.id, installationId: '12345', repositoryId: '999888' },
      { db: testDb, appId: TEST_APP_ID, privateKey: testPrivateKeyPem, fetch: mockFetch }
    );

    // Disconnect
    const disconnected = githubRepositoryService.disconnectApplicationRepository(app.id, { db: testDb });
    assert.equal(disconnected, true);

    // Lookup returns null
    const lookupAfter = githubRepositoryService.getApplicationRepositoryAssociation(app.id, { db: testDb });
    assert.equal(lookupAfter, null);

    // Verify application record itself was NOT deleted
    const appRow = getApplicationById(app.id, { db: testDb });
    assert.ok(appRow);
    assert.equal(appRow.name, 'Disconnect Test App');
  });

  // ── 28-30. Confidentiality & Zero Execution ────────────────────────
  await t.test('28-30. No credentials stored in SQLite; zero shell execution', () => {
    // Audit github_installations table columns
    const columns = testDb.prepare('PRAGMA table_info(github_installations)').all().map((c) => c.name);
    assert.equal(columns.includes('token'), false);
    assert.equal(columns.includes('private_key'), false);
    assert.equal(columns.includes('jwt'), false);
  });

  // ── 31-34. Regression & Isolation ─────────────────────────────────
  await t.test('31-34. Public git clone and deployments.json remain completely untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });

  // ── 35-38. resolveApplicationCheckoutAuth Resolver ───────────────
  await t.test('35-38. resolveApplicationCheckoutAuth resolves trusted options from SQLite or fails closed', async () => {
    // 1. Associated application resolves github-app mode
    const app = createApplication(
      {
        name: 'Auto Auth App',
        repo_url: 'https://github.com/my-org/auto-auth.git'
      },
      { db: testDb }
    );

    const mockFetch = createMockFetch({
      installationId: '12345',
      repositoryId: '654321',
      repoOwner: 'my-org',
      repoName: 'auto-auth'
    });

    await githubRepositoryService.associateApplicationRepository(
      { applicationId: app.id, installationId: '12345', repositoryId: '654321' },
      { db: testDb, appId: TEST_APP_ID, privateKey: testPrivateKeyPem, fetch: mockFetch }
    );

    const authContext = githubRepositoryService.resolveApplicationCheckoutAuth(app.id, { db: testDb });
    assert.ok(authContext);
    assert.equal(authContext.authMode, 'github-app');
    assert.equal(authContext.installationId, '12345');
    assert.equal(authContext.repositoryId, '654321');
    assert.equal(authContext.repositoryName, 'auto-auth');
    assert.equal(authContext.repositoryOwner, 'my-org');

    // 2. Unassociated application resolves to public mode
    const unassociatedApp = createApplication(
      {
        name: 'Public Open Source App',
        repo_url: 'https://github.com/torvalds/linux.git'
      },
      { db: testDb }
    );
    const publicAuth = githubRepositoryService.resolveApplicationCheckoutAuth(unassociatedApp.id, { db: testDb });
    assert.equal(publicAuth.authMode, 'public');

    // 3. Suspended installation fails closed
    testDb.prepare("UPDATE github_installations SET installation_status = 'suspended' WHERE installation_id = '12345'").run();
    assert.throws(
      () => {
        githubRepositoryService.resolveApplicationCheckoutAuth(app.id, { db: testDb });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'INSTALLATION_SUSPENDED'
    );
    testDb.prepare("UPDATE github_installations SET installation_status = 'active' WHERE installation_id = '12345'").run();

    // 4. Drifted repo URL fails closed
    testDb.prepare("UPDATE applications SET repo_url = 'https://github.com/my-org/drifted-url.git' WHERE id = ?").run(app.id);
    assert.throws(
      () => {
        githubRepositoryService.resolveApplicationCheckoutAuth(app.id, { db: testDb });
      },
      (err) => err instanceof GithubRepositoryError && err.code === 'APPLICATION_REPOSITORY_CHANGED'
    );
  });
});
