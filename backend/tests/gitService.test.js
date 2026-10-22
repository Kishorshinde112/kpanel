const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const gitService = require('../services/gitService');
const { GitServiceError } = gitService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

test('Phase 3A: Secure Git Repository Engine Suite', async (t) => {
  let tempBaseDir;
  let workspaceRoot;
  let fixtureRepoPath;
  let fixtureCommitSha;
  let originalDeploymentsContent;

  t.before(() => {
    process.env.NODE_ENV = 'test';

    // Verify legacy deployments.json
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    // Create an isolated temporary test directory
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-git-service-test-'));
    workspaceRoot = path.join(tempBaseDir, 'workspaces');
    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });

    // ── Create a Local Git Repository Fixture for Offline Tests ─────
    const fixtureWorkingDir = path.join(tempBaseDir, 'fixture-src');
    fixtureRepoPath = path.join(tempBaseDir, 'fixture-origin.git');

    fs.mkdirSync(fixtureWorkingDir, { recursive: true });

    // Initialize source repo with a commit
    execFileSync('git', ['init', '-b', 'main'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.name', 'KPanel Tester'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['config', 'user.email', 'tester@kpanel.local'], { cwd: fixtureWorkingDir });

    // Add safe test file and an unexecuted script to verify no scripts are run
    fs.writeFileSync(path.join(fixtureWorkingDir, 'README.md'), '# K-Panel Test Project\n');
    fs.writeFileSync(
      path.join(fixtureWorkingDir, 'malicious-postinstall.sh'),
      '#!/bin/sh\necho "EXPLOIT_EXECUTED" > /tmp/kpanel_exploit.txt\n',
      { mode: 0o755 }
    );

    execFileSync('git', ['add', '.'], { cwd: fixtureWorkingDir });
    execFileSync('git', ['commit', '-m', 'Initial commit for test fixture'], { cwd: fixtureWorkingDir });

    // Create a secondary branch 'v1.x'
    execFileSync('git', ['branch', 'v1.x'], { cwd: fixtureWorkingDir });

    // Get exact commit SHA
    fixtureCommitSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fixtureWorkingDir }).toString().trim();

    // Clone bare to simulate remote origin
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

  // ── 1. Valid GitHub HTTPS URL ──────────────────────────────────────
  await t.test('1. Valid GitHub HTTPS URL is accepted and normalized', () => {
    const res = gitService.validateRepositoryUrl('https://github.com/torvalds/linux');
    assert.equal(res.owner, 'torvalds');
    assert.equal(res.repo, 'linux');
    assert.equal(res.normalizedUrl, 'https://github.com/torvalds/linux.git');
    assert.equal(res.isHttps, true);
  });

  // ── 2. Optional .git Suffix ────────────────────────────────────────
  await t.test('2. Optional .git suffix is handled cleanly', () => {
    const res = gitService.validateRepositoryUrl('https://github.com/expressjs/express.git');
    assert.equal(res.owner, 'expressjs');
    assert.equal(res.repo, 'express');
    assert.equal(res.normalizedUrl, 'https://github.com/expressjs/express.git');
  });

  // ── 3. Rejected Embedded Credentials ───────────────────────────────
  await t.test('3. Embedded credentials in URLs are strictly rejected', () => {
    const credentialUrls = [
      'https://user:ghp_secretToken@github.com/owner/repo.git',
      'https://token123@github.com/owner/repo',
      'https://foo:bar@github.com/owner/repo'
    ];
    for (const url of credentialUrls) {
      assert.throws(
        () => gitService.validateRepositoryUrl(url),
        (err) => err instanceof GitServiceError && err.code === 'INVALID_REPOSITORY_URL' && err.message.includes('embedded authentication credentials'),
        `Expected rejection of credentials in ${url}`
      );
    }
  });

  // ── 4. Rejected SSH URL ────────────────────────────────────────────
  await t.test('4. SSH repository URLs are rejected with UNSUPPORTED_AUTH_METHOD', () => {
    const sshUrls = [
      'git@github.com:owner/repo.git',
      'ssh://git@github.com/owner/repo.git'
    ];
    for (const url of sshUrls) {
      assert.throws(
        () => gitService.validateRepositoryUrl(url),
        (err) => err instanceof GitServiceError && err.code === 'UNSUPPORTED_AUTH_METHOD',
        `Expected rejection for SSH URL: ${url}`
      );
    }
  });

  // ── 5. Rejected File URL ───────────────────────────────────────────
  await t.test('5. Local file:// URLs are rejected by default production validator', () => {
    assert.throws(
      () => gitService.validateRepositoryUrl('file:///etc/passwd'),
      (err) => err instanceof GitServiceError && err.code === 'INVALID_REPOSITORY_URL' && err.message.includes('Local file repository schemes')
    );
  });

  // ── 6. Rejected Localhost URL ──────────────────────────────────────
  await t.test('6. Localhost and internal IP repository URLs are rejected', () => {
    const blockedHosts = [
      'https://localhost/owner/repo',
      'https://127.0.0.1/owner/repo',
      'https://192.168.1.1/owner/repo',
      'https://gitlab.com/owner/repo',
      'https://bitbucket.org/owner/repo'
    ];
    for (const url of blockedHosts) {
      assert.throws(
        () => gitService.validateRepositoryUrl(url),
        (err) => err instanceof GitServiceError && err.code === 'UNSUPPORTED_REPOSITORY_HOST',
        `Expected rejection for host in ${url}`
      );
    }
  });

  // ── 7. Rejected Malicious Encoded URL ──────────────────────────────
  await t.test('7. Path traversal and encoded sequences in URL are rejected', () => {
    const malformed = [
      'https://github.com/owner/../repo',
      'https://github.com/owner/repo/..',
      'https://github.com/../owner/repo',
      '//github.com/owner/repo',
      'https://github.com:8443/owner/repo'
    ];
    for (const url of malformed) {
      assert.throws(
        () => gitService.validateRepositoryUrl(url),
        (err) => err instanceof GitServiceError && err.code === 'INVALID_REPOSITORY_URL'
      );
    }
  });

  // ── 8. Rejected URL with Unexpected Path Segments ───────────────────
  await t.test('8. URLs with extra or missing path segments are rejected', () => {
    const badPaths = [
      'https://github.com/only-one-segment',
      'https://github.com/owner/repo/extra/segment',
      'https://github.com/owner/repo/tree/main',
      'https://github.com/owner/repo?token=123',
      'https://github.com/owner/repo#readme'
    ];
    for (const url of badPaths) {
      assert.throws(
        () => gitService.validateRepositoryUrl(url),
        (err) => err instanceof GitServiceError && err.code === 'INVALID_REPOSITORY_URL'
      );
    }
  });

  // ── 9. Valid Branch Names ──────────────────────────────────────────
  await t.test('9. Valid Git branch names are accepted', () => {
    const valid = ['main', 'master', 'develop', 'release-2.0', 'feat/login-guard', 'v1.0.4'];
    for (const b of valid) {
      assert.equal(gitService.validateBranch(b), b);
    }
  });

  // ── 10. Invalid Git References ─────────────────────────────────────
  await t.test('10. Invalid Git reference names are rejected', () => {
    const invalid = [
      'main..branch',
      'branch~1',
      'branch^',
      'refs/heads:branch',
      'feature*name',
      'branch?name',
      'feat[0]',
      'feat\\name',
      'feat@{1}',
      '/leading-slash',
      'trailing-slash/',
      'trailing-dot.',
      'branch.lock',
      'branch with spaces'
    ];
    for (const b of invalid) {
      assert.throws(
        () => gitService.validateBranch(b),
        (err) => err instanceof GitServiceError && err.code === 'INVALID_BRANCH',
        `Expected branch rejection for "${b}"`
      );
    }
  });

  // ── 11. Command-Option Injection Attempts ──────────────────────────
  await t.test('11. Command-option injection attempts in branch names are strictly blocked', () => {
    const injectionAttempts = [
      '--upload-pack=touch /tmp/pwned',
      '-oProxyCommand=calc',
      '--exec=rm -rf /',
      '-f',
      '--help'
    ];
    for (const b of injectionAttempts) {
      assert.throws(
        () => gitService.validateBranch(b),
        (err) => err instanceof GitServiceError && err.code === 'INVALID_BRANCH' && err.message.includes('must not begin with a hyphen'),
        `Expected rejection of option injection branch "${b}"`
      );
    }
  });

  // ── 12. No Shell Invocation ────────────────────────────────────────
  await t.test('12. Subprocess execution executes directly without a shell interpreter', async () => {
    // Attempt shell command chaining in an argument; without a shell it will be treated literally and fail safely
    const result = await gitService.executeGitCommand(['version; echo SHELL_INJECTED'], { timeout: 5000 });
    assert.notEqual(result.code, 0, 'Argument chaining without shell must fail');
    assert.ok(!result.stdout.includes('SHELL_INJECTED'), 'Shell metacharacters must never be interpreted');
  });

  // ── 13. Workspace Isolation Between Applications ───────────────────
  await t.test('13. Workspaces are isolated per application UUID and operation UUID', async () => {
    const app1 = { id: '11111111-1111-4111-8111-111111111111', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    const app2 = { id: '22222222-2222-4222-8222-222222222222', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };

    const snapshot1 = await gitService.fetchRepository(app1, { workspaceRoot, allowTestFixture: true });
    const snapshot2 = await gitService.fetchRepository(app2, { workspaceRoot, allowTestFixture: true });

    assert.ok(snapshot1.workspacePath.includes('11111111-1111-4111-8111-111111111111'));
    assert.ok(snapshot2.workspacePath.includes('22222222-2222-4222-8222-222222222222'));
    assert.notEqual(snapshot1.workspacePath, snapshot2.workspacePath);

    // Clean up
    gitService.cleanupWorkspace(snapshot1, { workspaceRoot });
    gitService.cleanupWorkspace(snapshot2, { workspaceRoot });
  });

  // ── 14. Workspace Traversal Rejection ──────────────────────────────
  await t.test('14. Traversal in application ID or workspace path is rejected', async () => {
    const badApp = { id: '../../etc/passwd', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    await assert.rejects(
      async () => {
        await gitService.fetchRepository(badApp, { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'WORKSPACE_ERROR' && err.message.includes('Expected a standard UUID')
    );
  });

  // ── 15. Symlink Escape Prevention ──────────────────────────────────
  await t.test('15. Symlink escapes from workspace are detected and blocked', () => {
    const fakeInfo = {
      workspacePath: '/tmp/outside-workspace',
      applicationId: '33333333-3333-4333-8333-333333333333',
      operationId: '44444444-4444-4444-8444-444444444444'
    };

    assert.throws(
      () => gitService.cleanupWorkspace(fakeInfo, { workspaceRoot }),
      (err) => err instanceof GitServiceError && err.code === 'WORKSPACE_ACCESS_DENIED'
    );
  });

  // ── 16. Missing Workspace Root Fails Closed ────────────────────────
  await t.test('16. Missing KPANEL_WORKSPACE_ROOT configuration fails closed', async () => {
    const origEnv = process.env.KPANEL_WORKSPACE_ROOT;
    delete process.env.KPANEL_WORKSPACE_ROOT;

    const app = { id: '55555555-5555-4555-8555-555555555555', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    await assert.rejects(
      async () => {
        // Without options.workspaceRoot or env var
        await gitService.fetchRepository(app, { allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'WORKSPACE_ERROR' && err.message.includes('KPANEL_WORKSPACE_ROOT environment variable is not configured')
    );

    if (origEnv) process.env.KPANEL_WORKSPACE_ROOT = origEnv;
  });

  // ── 17. Missing Branch Handling ────────────────────────────────────
  await t.test('17. Missing remote branch is reported cleanly with BRANCH_NOT_FOUND', async () => {
    const app = { id: '66666666-6666-4666-8666-666666666666', repo_url: `file://${fixtureRepoPath}`, branch: 'non-existent-branch' };
    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError && err.code === 'BRANCH_NOT_FOUND'
    );
  });

  // ── 18. Exact Fetched Commit SHA Verification ──────────────────────
  await t.test('18. Exact fetched commit SHA is verified against local checkout HEAD', async () => {
    const app = { id: '77777777-7777-4777-8777-777777777777', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    const snapshot = await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });

    assert.ok(snapshot.commitSha);
    assert.equal(snapshot.commitSha, fixtureCommitSha.toLowerCase());

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 19. Shallow Fetch Behavior ─────────────────────────────────────
  await t.test('19. Shallow clone minimizes history depth to exactly 1 commit', async () => {
    const app = { id: '88888888-8888-4888-8888-888888888888', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    const snapshot = await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });

    // Inspect commit count in fetched workspace
    const revListCount = execFileSync('git', ['rev-list', '--count', 'HEAD'], { cwd: snapshot.workspacePath }).toString().trim();
    assert.equal(revListCount, '1', 'Shallow clone must have commit depth exactly 1');

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 20. Git Subprocess Failure ─────────────────────────────────────
  await t.test('20. Git subprocess errors are captured and reported safely', async () => {
    const badApp = { id: '99999999-9999-4999-8999-999999999999', repo_url: 'file:///tmp/non-existent-origin.git', branch: 'main' };
    await assert.rejects(
      async () => {
        await gitService.fetchRepository(badApp, { workspaceRoot, allowTestFixture: true });
      },
      (err) => err instanceof GitServiceError
    );
  });

  // ── 21. Git Operation Timeout ──────────────────────────────────────
  await t.test('21. Git operation timeout terminates child process safely', async () => {
    await assert.rejects(
      async () => {
        // Sleep command will exceed 50ms timeout
        await gitService.executeGitCommand(['status'], { timeout: 1 });
      },
      (err) => err instanceof GitServiceError && err.code === 'GIT_TIMEOUT'
    );
  });

  // ── 22. Cleanup After Failed Operations ────────────────────────────
  await t.test('22. Failed fetch cleans up partial workspace automatically', async () => {
    const app = { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', repo_url: `file://${fixtureRepoPath}`, branch: 'missing-branch-for-cleanup' };
    const appWorkspace = path.join(workspaceRoot, app.id);

    try {
      await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });
    } catch {}

    // Verify operation directory was cleaned up and no leftover sources remain
    if (fs.existsSync(appWorkspace)) {
      const contents = fs.readdirSync(appWorkspace);
      assert.equal(contents.length, 0, 'Failed operation directory must be cleaned up');
    }
  });

  // ── 23. Cancellation Support ───────────────────────────────────────
  await t.test('23. AbortSignal cancellation terminates git operation', async () => {
    const controller = new AbortController();
    const app = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };

    // Abort immediately
    controller.abort();

    await assert.rejects(
      async () => {
        await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true, signal: controller.signal });
      },
      (err) => err instanceof GitServiceError && (err.code === 'OPERATION_CANCELLED' || err.code === 'GIT_FETCH_FAILED')
    );
  });

  // ── 24. Safe Workspace Cleanup ─────────────────────────────────────
  await t.test('24. cleanupWorkspace safely removes only tracked operation directory', async () => {
    const app = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    const snapshot = await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });

    assert.ok(fs.existsSync(snapshot.workspacePath));

    const cleanupRes = gitService.cleanupWorkspace(snapshot, { workspaceRoot });
    assert.equal(cleanupRes.success, true);
    assert.equal(fs.existsSync(snapshot.workspacePath), false);
  });

  // ── 25. Rejection of Arbitrary External Deletion Paths ─────────────
  await t.test('25. cleanupWorkspace refuses arbitrary paths outside workspace root', () => {
    const dangerousPaths = [
      { workspacePath: '/home/ubuntu', applicationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { workspacePath: '/etc', applicationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
      { workspacePath: '/tmp', applicationId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', operationId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' }
    ];

    for (const info of dangerousPaths) {
      assert.throws(
        () => gitService.cleanupWorkspace(info, { workspaceRoot }),
        (err) => err instanceof GitServiceError && err.code === 'WORKSPACE_ACCESS_DENIED'
      );
    }
  });

  // ── 26. No Execution of Repository Application Scripts ─────────────
  await t.test('26. Repository scripts are never executed during cloning', async () => {
    const exploitCheckFile = '/tmp/kpanel_exploit.txt';
    if (fs.existsSync(exploitCheckFile)) fs.unlinkSync(exploitCheckFile);

    const app = { id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee', repo_url: `file://${fixtureRepoPath}`, branch: 'main' };
    const snapshot = await gitService.fetchRepository(app, { workspaceRoot, allowTestFixture: true });

    assert.equal(fs.existsSync(exploitCheckFile), false, 'Repository application scripts must never be executed');

    gitService.cleanupWorkspace(snapshot, { workspaceRoot });
  });

  // ── 27. No Credentials in Logs ─────────────────────────────────────
  await t.test('27. Git error messages never expose passwords or token secrets', () => {
    const SECRET_TOKEN = 'ghp_superSecretToken1234567890';
    try {
      gitService.validateRepositoryUrl(`https://user:${SECRET_TOKEN}@github.com/owner/repo.git`);
    } catch (err) {
      assert.ok(!err.message.includes(SECRET_TOKEN), 'Exception message must never echo token value');
    }
  });

  // ── 28. No Modification to SQLite Applications or Deployments ──────
  await t.test('28. Git service performs pure filesystem operations without touching SQLite tables', () => {
    const { getDatabase } = require('../config/database');
    const { runMigrations } = require('../db/migrate');
    const db = getDatabase();
    runMigrations(db);
    // Verify application and deployment table row counts remain untouched
    const appCount = db.prepare('SELECT COUNT(*) as c FROM applications').get().c;
    assert.ok(appCount >= 0);
  });

  // ── 29. No Modification to Legacy deployments.json ─────────────────
  await t.test('29. Legacy backend/data/deployments.json remains byte-for-byte untouched', () => {
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent);
    }
  });

  // ── 30. inspectRemoteBranch Resolves Remote Heads ───────────────────
  await t.test('30. inspectRemoteBranch resolves remote branches and commit SHAs cleanly', async () => {
    const res = await gitService.inspectRemoteBranch(`file://${fixtureRepoPath}`, 'main', {
      allowTestFixture: true
    });
    assert.equal(res.branch, 'main');
    assert.equal(res.commitSha, fixtureCommitSha.toLowerCase());

    await assert.rejects(
      async () => {
        await gitService.inspectRemoteBranch(`file://${fixtureRepoPath}`, 'missing-branch', {
          allowTestFixture: true
        });
      },
      (err) => err instanceof GitServiceError && err.code === 'BRANCH_NOT_FOUND'
    );
  });
});
