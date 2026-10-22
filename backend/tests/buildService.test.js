const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { Readable } = require('node:stream');

const buildService = require('../services/buildService');
const {
  buildImage,
  BuildServiceError,
  validateBuildInput,
  verifySourceIntegrity,
  generateImageTag,
  checkDockerAvailability,
  inspectImageId,
  buildSanitizedEnvironment
} = buildService;

const buildLogService = require('../services/buildLogService');
const {
  BuildLogError,
  createBuildLogger,
  readBuildLog,
  resolveLogPath
} = buildLogService;

const { getDatabase, closeDatabase } = require('../config/database');

// Helper to create an in-memory mock child process for spawn
function createMockChildProcess({ exitCode = 0, signal = null, stdout = '', stderr = '', delayMs = 10, error = null } = {}) {
  const child = new EventEmitter();
  child.stdout = new Readable({ read() {} });
  child.stderr = new Readable({ read() {} });
  child.killed = false;
  child.killSignals = [];

  child.kill = (sig = 'SIGTERM') => {
    child.killed = true;
    child.killSignals.push(sig);
  };

  setTimeout(() => {
    if (error) {
      child.emit('error', error);
      return;
    }
    if (stdout) {
      child.stdout.push(stdout);
    }
    child.stdout.push(null);

    if (stderr) {
      child.stderr.push(stderr);
    }
    child.stderr.push(null);

    setTimeout(() => {
      child.emit('close', exitCode, signal);
    }, delayMs);
  }, 5);

  return child;
}

test('Phase 4B1: Docker BuildKit Image Builder & Persistent Logs Suite', async (t) => {
  let tempBaseDir;
  let workspaceRoot;
  let logRoot;
  let testAppId;
  let testDeploymentId;
  let testCommitSha;
  let validWorkspacePath;
  let validDockerfilePath;

  t.before(() => {
    process.env.NODE_ENV = 'test';
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-build-test-'));
    workspaceRoot = path.join(tempBaseDir, 'workspaces');
    logRoot = path.join(tempBaseDir, 'logs');

    fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });

    testAppId = '11111111-1111-4111-8111-111111111111';
    testDeploymentId = '22222222-2222-4222-8222-222222222222';
    testCommitSha = 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';

    // Standard valid workspace structure: <workspaceRoot>/<appId>/source
    const appDir = path.join(workspaceRoot, testAppId);
    validWorkspacePath = path.join(appDir, 'source');
    fs.mkdirSync(validWorkspacePath, { recursive: true, mode: 0o700 });

    validDockerfilePath = path.join(validWorkspacePath, 'Dockerfile');
    fs.writeFileSync(validDockerfilePath, 'FROM node:20-alpine\nWORKDIR /app\nCOPY . .\nCMD ["node", "app.js"]\n');
  });

  t.after(() => {
    try {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    } catch {}
    closeDatabase();
  });

  // Default mock execFile helper that satisfies preflight and inspection
  function createMockExecFile({
    gitHead = testCommitSha,
    dockerVersion = 'Docker version 24.0.5',
    buildxVersion = 'github.com/docker/buildx v0.11.2',
    daemonVersion = '24.0.5',
    imageId = 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    inspectError = null
  } = {}) {
    return (file, args, options, callback) => {
      if (typeof options === 'function') {
        callback = options;
        options = {};
      }

      // git rev-parse HEAD
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') {
        return callback(null, gitHead, '');
      }

      // docker --version
      if (args[0] === '--version') {
        return callback(null, dockerVersion, '');
      }

      // docker buildx version
      if (args[0] === 'buildx' && args[1] === 'version') {
        return callback(null, buildxVersion, '');
      }

      // docker info
      if (args[0] === 'info') {
        return callback(null, daemonVersion, '');
      }

      // docker image inspect
      if (args[0] === 'image' && args[1] === 'inspect') {
        if (inspectError) {
          return callback(inspectError, '', 'Image inspect error');
        }
        return callback(null, imageId, '');
      }

      return callback(null, '', '');
    };
  }

  // ── 1. Valid Dockerfile Project Build ──────────────────────────────
  await t.test('1. Valid Dockerfile project builds successfully with correct metadata', async () => {
    let capturedSpawnArgs = null;
    const mockSpawn = (cmd, args, opts) => {
      capturedSpawnArgs = { cmd, args, opts };
      return createMockChildProcess({
        exitCode: 0,
        stdout: '#1 [internal] load build definition from Dockerfile\n#2 DONE 0.1s\n'
      });
    };

    const result = await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        workspaceRoot,
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    assert.equal(result.deploymentId, testDeploymentId);
    assert.equal(result.applicationId, testAppId);
    assert.equal(result.commitSha, testCommitSha);
    assert.equal(result.imageTag, `kpanel/app-${testAppId}:d-${testDeploymentId}-${testCommitSha.slice(0, 7)}`);
    assert.equal(result.imageId, 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef');
    assert.ok(result.buildDurationMs >= 0);
    assert.ok(fs.existsSync(result.logPath));
  });

  // ── 2. Unsupported Railpack Rejection ───────────────────────────────
  await t.test('2. Unsupported Railpack build type is rejected with UNSUPPORTED_BUILD_TYPE', async () => {
    await assert.rejects(
      () =>
        buildImage({
          deploymentId: testDeploymentId,
          applicationId: testAppId,
          commitSha: testCommitSha,
          workspacePath: validWorkspacePath,
          buildType: 'railpack'
        }),
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_BUILD_TYPE');
        assert.match(err.message, /Railpack build type is not supported/);
        return true;
      }
    );
  });

  // ── 3. Unsupported Compose Rejection ────────────────────────────────
  await t.test('3. Unsupported Compose build type is rejected with UNSUPPORTED_BUILD_TYPE', async () => {
    await assert.rejects(
      () =>
        buildImage({
          deploymentId: testDeploymentId,
          applicationId: testAppId,
          commitSha: testCommitSha,
          workspacePath: validWorkspacePath,
          buildType: 'compose'
        }),
      (err) => {
        assert.equal(err.code, 'UNSUPPORTED_BUILD_TYPE');
        assert.match(err.message, /Compose build type is not supported/);
        return true;
      }
    );
  });

  // ── 4. Missing Dockerfile Rejection ─────────────────────────────────
  await t.test('4. Missing Dockerfile throws DOCKERFILE_NOT_FOUND', async () => {
    const emptyWorkspace = path.join(tempBaseDir, 'empty-workspace');
    fs.mkdirSync(emptyWorkspace, { recursive: true });

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: emptyWorkspace,
            buildType: 'dockerfile'
          },
          { execFile: createMockExecFile() }
        ),
      (err) => {
        assert.equal(err.code, 'DOCKERFILE_NOT_FOUND');
        return true;
      }
    );
  });

  // ── 5. Missing Build Context Rejection ──────────────────────────────
  await t.test('5. Non-existent build context throws BUILD_CONTEXT_NOT_FOUND', async () => {
    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            buildPath: 'nonexistent/subfolder',
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'BUILD_CONTEXT_NOT_FOUND');
        return true;
      }
    );
  });

  // ── 6. Invalid Application ID Rejection ─────────────────────────────
  await t.test('6. Invalid application ID throws INVALID_APPLICATION_ID', async () => {
    await assert.rejects(
      () =>
        buildImage({
          deploymentId: testDeploymentId,
          applicationId: 'not-a-uuid',
          commitSha: testCommitSha,
          workspacePath: validWorkspacePath,
          buildType: 'dockerfile'
        }),
      (err) => {
        assert.equal(err.code, 'INVALID_APPLICATION_ID');
        return true;
      }
    );
  });

  // ── 7. Invalid Deployment ID Rejection ──────────────────────────────
  await t.test('7. Invalid deployment ID throws INVALID_DEPLOYMENT_ID', async () => {
    await assert.rejects(
      () =>
        buildImage({
          deploymentId: 'invalid-dep-id',
          applicationId: testAppId,
          commitSha: testCommitSha,
          workspacePath: validWorkspacePath,
          buildType: 'dockerfile'
        }),
      (err) => {
        assert.equal(err.code, 'INVALID_DEPLOYMENT_ID');
        return true;
      }
    );
  });

  // ── 8. Invalid SHA Rejection ────────────────────────────────────────
  await t.test('8. Malformed commit SHA throws INVALID_COMMIT_SHA', async () => {
    await assert.rejects(
      () =>
        buildImage({
          deploymentId: testDeploymentId,
          applicationId: testAppId,
          commitSha: 'not-a-40-char-sha',
          workspacePath: validWorkspacePath,
          buildType: 'dockerfile'
        }),
      (err) => {
        assert.equal(err.code, 'INVALID_COMMIT_SHA');
        return true;
      }
    );
  });

  // ── 9. Wrong Workspace / Tenant Mismatch ────────────────────────────
  await t.test('9. Workspace not belonging to application throws WORKSPACE_TENANT_MISMATCH', async () => {
    const foreignAppId = '99999999-9999-4999-8999-999999999999';
    const foreignWorkspace = path.join(workspaceRoot, foreignAppId, 'source');
    fs.mkdirSync(foreignWorkspace, { recursive: true });
    fs.writeFileSync(path.join(foreignWorkspace, 'Dockerfile'), 'FROM alpine\n');

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId, // Mismatched application ID
            commitSha: testCommitSha,
            workspacePath: foreignWorkspace,
            buildType: 'dockerfile'
          },
          {
            workspaceRoot,
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'WORKSPACE_TENANT_MISMATCH');
        return true;
      }
    );
  });

  // ── 10. Workspace Path Traversal Rejection ──────────────────────────
  await t.test('10. Path traversal in buildPath throws PATH_TRAVERSAL_DETECTED', async () => {
    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            buildPath: '../../etc',
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'PATH_TRAVERSAL_DETECTED');
        return true;
      }
    );
  });

  // ── 11. Symlink Escape Rejection ────────────────────────────────────
  await t.test('11. Symlink escaping workspace is strictly rejected', async () => {
    const symlinkTarget = path.join(tempBaseDir, 'outside-target');
    fs.mkdirSync(symlinkTarget, { recursive: true });

    const rogueLink = path.join(validWorkspacePath, 'rogue-symlink');
    try { fs.unlinkSync(rogueLink); } catch {}
    fs.symlinkSync(symlinkTarget, rogueLink, 'dir');

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            buildPath: 'rogue-symlink',
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'WORKSPACE_ACCESS_DENIED');
        return true;
      }
    );
  });

  // ── 12. Unsafe Dockerfile Path Rejection ─────────────────────────────
  await t.test('12. Unsafe Dockerfile path traversal throws PATH_TRAVERSAL_DETECTED', async () => {
    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            dockerfilePath: '../Dockerfile.outside',
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'PATH_TRAVERSAL_DETECTED');
        return true;
      }
    );
  });

  // ── 13. Correct ARM64 Platform ──────────────────────────────────────
  await t.test('13. Target platform defaults strictly to linux/arm64', async () => {
    let capturedArgs = null;
    const mockSpawn = (cmd, args) => {
      capturedArgs = args;
      return createMockChildProcess({ exitCode: 0 });
    };

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    const platformIndex = capturedArgs.indexOf('--platform');
    assert.ok(platformIndex !== -1, 'Platform flag must be present');
    assert.equal(capturedArgs[platformIndex + 1], 'linux/arm64');
  });

  // ── 14. Correct Buildx Argument Construction ────────────────────────
  await t.test('14. Validated fixed Buildx arguments are constructed correctly', async () => {
    let capturedCmd = null;
    let capturedArgs = null;
    const mockSpawn = (cmd, args) => {
      capturedCmd = cmd;
      capturedArgs = args;
      return createMockChildProcess({ exitCode: 0 });
    };

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    assert.equal(capturedCmd, 'docker');
    assert.equal(capturedArgs[0], 'buildx');
    assert.equal(capturedArgs[1], 'build');
    assert.ok(capturedArgs.includes('--progress'));
    assert.ok(capturedArgs.includes('plain'));
    assert.ok(capturedArgs.includes('--load'));
    assert.ok(capturedArgs.includes('--tag'));
    assert.ok(capturedArgs.includes('--file'));
    assert.equal(capturedArgs[capturedArgs.length - 1], validWorkspacePath);
  });

  // ── 15. shell: false Verification ───────────────────────────────────
  await t.test('15. Subprocess execution strictly enforces shell: false', async () => {
    let capturedOpts = null;
    const mockSpawn = (cmd, args, opts) => {
      capturedOpts = opts;
      return createMockChildProcess({ exitCode: 0 });
    };

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    assert.equal(capturedOpts.shell, false, 'shell must be strictly false');
  });

  // ── 16. Immutable Image Tag Generation ──────────────────────────────
  await t.test('16. Generates deterministic, immutable image tags without latest', () => {
    const tag = generateImageTag(testAppId, testDeploymentId, testCommitSha);
    assert.equal(tag, `kpanel/app-${testAppId}:d-${testDeploymentId}-${testCommitSha.slice(0, 7)}`);
    assert.equal(tag.includes('latest'), false, 'Tag must not contain "latest"');
  });

  // ── 17. Successful Build with Verified Image ID ─────────────────────
  await t.test('17. Reports verified sha256 image ID from inspection', async () => {
    const expectedId = 'sha256:fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210';
    const mockSpawn = () => createMockChildProcess({ exitCode: 0 });

    const result = await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile({ imageId: expectedId })
      }
    );

    assert.equal(result.imageId, expectedId);
  });

  // ── 18. Failed Build Exit Code ──────────────────────────────────────
  await t.test('18. Non-zero exit code throws BUILD_FAILED and preserves log marker', async () => {
    const mockSpawn = () =>
      createMockChildProcess({
        exitCode: 1,
        stderr: 'ERROR: failed to solve: process "/bin/sh -c npm run build" did not complete successfully: exit code: 1\n'
      });

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            spawn: mockSpawn,
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'BUILD_FAILED');
        assert.equal(err.details.exitCode, 1);
        return true;
      }
    );

    // Verify failure marker in log
    const logContent = readBuildLog(testDeploymentId, { logRoot });
    assert.match(logContent, /BUILD FAILED: Docker exited with code 1/);
  });

  // ── 19. Missing Docker Binary ───────────────────────────────────────
  await t.test('19. Missing Docker binary throws DOCKER_NOT_FOUND', async () => {
    const missingExecFile = (file, args, opts, cb) => {
      if (typeof opts === 'function') {
        cb = opts;
      }
      if (args[0] === 'rev-parse') {
        return cb(null, testCommitSha, '');
      }
      const err = new Error('spawn docker ENOENT');
      err.code = 'ENOENT';
      cb(err);
    };

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            execFile: missingExecFile
          }
        ),
      (err) => {
        assert.equal(err.code, 'DOCKER_NOT_FOUND');
        return true;
      }
    );
  });

  // ── 20. Missing Buildx Plugin ───────────────────────────────────────
  await t.test('20. Missing Buildx plugin throws BUILDX_NOT_AVAILABLE', async () => {
    const noBuildxExecFile = (file, args, opts, cb) => {
      if (typeof opts === 'function') {
        cb = opts;
      }
      if (args[0] === 'rev-parse') {
        return cb(null, testCommitSha, '');
      }
      if (args[0] === 'buildx') {
        const err = new Error('docker: "buildx" is not a docker command.');
        return cb(err);
      }
      cb(null, 'Docker version 24.0.5', '');
    };

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            execFile: noBuildxExecFile
          }
        ),
      (err) => {
        assert.equal(err.code, 'BUILDX_NOT_AVAILABLE');
        return true;
      }
    );
  });

  // ── 21. Docker Daemon Failure ───────────────────────────────────────
  await t.test('21. Docker daemon connection failure throws DOCKER_DAEMON_UNAVAILABLE', async () => {
    const daemonDownExecFile = (file, args, opts, cb) => {
      if (typeof opts === 'function') {
        cb = opts;
      }
      if (args[0] === 'rev-parse') {
        return cb(null, testCommitSha, '');
      }
      if (args[0] === 'info') {
        const err = new Error('Cannot connect to the Docker daemon');
        return cb(err, '', 'Cannot connect to the Docker daemon at unix:///var/run/docker.sock.');
      }
      cb(null, 'Docker version 24.0.5', '');
    };

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            execFile: daemonDownExecFile
          }
        ),
      (err) => {
        assert.equal(err.code, 'DOCKER_DAEMON_UNAVAILABLE');
        return true;
      }
    );
  });

  // ── 22. Execution Timeout ───────────────────────────────────────────
  await t.test('22. Exceeding build timeout terminates child and throws BUILD_TIMEOUT', async () => {
    let mockChildRef;
    const mockSpawn = () => {
      mockChildRef = createMockChildProcess({ exitCode: 0, delayMs: 400 });
      return mockChildRef;
    };

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            timeout: 30, // 30ms short timeout
            spawn: mockSpawn,
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'BUILD_TIMEOUT');
        return true;
      }
    );

    assert.ok(mockChildRef.killed, 'Child process must be killed on timeout');
  });

  // ── 23. Cancellation via AbortSignal ────────────────────────────────
  await t.test('23. AbortSignal abort terminates process and throws OPERATION_CANCELLED', async () => {
    const controller = new AbortController();
    let mockChildRef;
    const mockSpawn = () => {
      mockChildRef = createMockChildProcess({ exitCode: 0, delayMs: 400 });
      return mockChildRef;
    };

    const buildPromise = buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        signal: controller.signal,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    // Abort after 15ms
    setTimeout(() => {
      controller.abort();
    }, 15);

    await assert.rejects(
      buildPromise,
      (err) => {
        assert.equal(err.code, 'OPERATION_CANCELLED');
        return true;
      }
    );

    assert.ok(mockChildRef.killed, 'Child process must be terminated on abort');
  });

  // ── 24. No Success After Cancellation ───────────────────────────────
  await t.test('24. Process exit code 0 after cancellation does not result in success', async () => {
    const controller = new AbortController();
    controller.abort(); // Pre-aborted

    await assert.rejects(
      () =>
        buildImage(
          {
            deploymentId: testDeploymentId,
            applicationId: testAppId,
            commitSha: testCommitSha,
            workspacePath: validWorkspacePath,
            buildType: 'dockerfile'
          },
          {
            logRoot,
            allowOverwrite: true,
            signal: controller.signal,
            execFile: createMockExecFile()
          }
        ),
      (err) => {
        assert.equal(err.code, 'OPERATION_CANCELLED');
        return true;
      }
    );
  });

  // ── 25. Persistent Log Creation ─────────────────────────────────────
  await t.test('25. Creates persistent log file at expected location', async () => {
    const mockSpawn = () =>
      createMockChildProcess({ exitCode: 0, stdout: 'Step 1/3 : FROM alpine\n' });

    const result = await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    assert.equal(result.logPath, path.join(logRoot, `${testDeploymentId}.log`));
    assert.ok(fs.existsSync(result.logPath));
  });

  // ── 26. Incremental Log Writing ─────────────────────────────────────
  await t.test('26. Log captures incremental stdout and stderr streams with markers', async () => {
    const mockSpawn = () =>
      createMockChildProcess({
        exitCode: 0,
        stdout: 'Step 1/2 : WORKDIR /app\n',
        stderr: 'debconf: delaying package configuration\n'
      });

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    const logContent = readBuildLog(testDeploymentId, { logRoot });
    assert.match(logContent, /BUILD STARTED/);
    assert.match(logContent, /Step 1\/2 : WORKDIR \/app/);
    assert.match(logContent, /debconf: delaying package configuration/);
    assert.match(logContent, /BUILD SUCCESSFUL/);
  });

  // ── 27. Large-Output Bounding ───────────────────────────────────────
  await t.test('27. Bounded logger truncates oversized output safely without crash', () => {
    const boundedDepId = '33333333-3333-4333-8333-333333333333';
    const logger = createBuildLogger(boundedDepId, {
      logRoot,
      maxLogBytes: 200, // Small limit
      allowOverwrite: true
    });

    const hugeChunk = 'A'.repeat(500);
    logger.write(hugeChunk);
    logger.close();

    const content = readBuildLog(boundedDepId, { logRoot });
    assert.match(content, /LOG TRUNCATED: MAXIMUM SIZE EXCEEDED/);
    assert.ok(content.length <= 400);
  });

  // ── 28. Log File Permission Restrictions ────────────────────────────
  await t.test('28. Log file permissions are restricted to owner-only 0o600', () => {
    const permDepId = '44444444-4444-4444-8444-444444444444';
    const logger = createBuildLogger(permDepId, { logRoot, allowOverwrite: true });
    logger.write('Permission check\n');
    logger.close();

    const filePath = path.join(logRoot, `${permDepId}.log`);
    const stat = fs.statSync(filePath);
    const mode = stat.mode & 0o777;
    assert.equal(mode, 0o600, 'Log file must have 0o600 permissions');
  });

  // ── 29. Log Symlink Rejection ───────────────────────────────────────
  await t.test('29. Rejects target log path if it is a symbolic link', () => {
    const symlinkDepId = '55555555-5555-4555-8555-555555555555';
    const realTargetFile = path.join(tempBaseDir, 'external-fake.log');
    fs.writeFileSync(realTargetFile, 'dummy');

    const rogueSymlink = path.join(logRoot, `${symlinkDepId}.log`);
    try { fs.unlinkSync(rogueSymlink); } catch {}
    fs.symlinkSync(realTargetFile, rogueSymlink);

    assert.throws(
      () => createBuildLogger(symlinkDepId, { logRoot }),
      (err) => {
        assert.equal(err.code, 'LOG_SECURITY_ERROR');
        return true;
      }
    );
  });

  // ── 30. Log Preservation on Build Failure ───────────────────────────
  await t.test('30. Failure logs are strictly preserved and accessible for operator diagnosis', async () => {
    const failDepId = '66666666-6666-4666-8666-666666666666';
    const mockSpawn = () =>
      createMockChildProcess({
        exitCode: 137, // OOM kill exit code
        stderr: 'Killed: Process ran out of memory\n'
      });

    try {
      await buildImage(
        {
          deploymentId: failDepId,
          applicationId: testAppId,
          commitSha: testCommitSha,
          workspacePath: validWorkspacePath,
          buildType: 'dockerfile'
        },
        {
          logRoot,
          allowOverwrite: true,
          spawn: mockSpawn,
          execFile: createMockExecFile()
        }
      );
    } catch {}

    const logPath = path.join(logRoot, `${failDepId}.log`);
    assert.ok(fs.existsSync(logPath), 'Log file must be preserved on failure');
    const logContent = readBuildLog(failDepId, { logRoot });
    assert.match(logContent, /BUILD FAILED: Docker exited with code 137/);
  });

  // ── 31. No Token in Build Arguments ─────────────────────────────────
  await t.test('31. Build arguments do not contain GitHub tokens or secrets', async () => {
    let capturedArgs = null;
    const mockSpawn = (cmd, args) => {
      capturedArgs = args;
      return createMockChildProcess({ exitCode: 0 });
    };

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    const argsString = capturedArgs.join(' ');
    assert.equal(argsString.includes('--build-arg'), false, 'Must not pass build arguments');
    assert.equal(argsString.includes('ghs_'), false, 'Must not contain GitHub installation tokens');
    assert.equal(argsString.includes('secret'), false, 'Must not contain secrets');
  });

  // ── 32. No Backend Secrets in Build Environment ─────────────────────
  await t.test('32. Subprocess environment strips backend secrets and credentials', () => {
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const originalAppSecret = process.env.SESSION_SECRET;
    try {
      process.env.GITHUB_WEBHOOK_SECRET = 'whsec_supersecretvalue';
      process.env.SESSION_SECRET = 'kpanel_session_secret_key';

      const sanitized = buildSanitizedEnvironment({
        extraEnv: {
          SAFE_VAR: 'hello',
          MALICIOUS_TOKEN: 'ghs_forbidden123456789'
        }
      });

      assert.equal(sanitized.GITHUB_WEBHOOK_SECRET, undefined);
      assert.equal(sanitized.SESSION_SECRET, undefined);
      assert.equal(sanitized.MALICIOUS_TOKEN, undefined);
      assert.equal(sanitized.SAFE_VAR, 'hello');
    } finally {
      if (originalSecret) process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
      else delete process.env.GITHUB_WEBHOOK_SECRET;

      if (originalAppSecret) process.env.SESSION_SECRET = originalAppSecret;
      else delete process.env.SESSION_SECRET;
    }
  });

  // ── 33. No Release Records Created ──────────────────────────────────
  await t.test('33. No release records are inserted into SQLite database', async () => {
    const db = getDatabase();
    let initialReleaseCount = 0;
    try {
      initialReleaseCount = db.prepare('SELECT count(*) as count FROM releases').get().count;
    } catch {}

    const mockSpawn = () => createMockChildProcess({ exitCode: 0 });

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    let finalReleaseCount = 0;
    try {
      finalReleaseCount = db.prepare('SELECT count(*) as count FROM releases').get().count;
    } catch {}

    assert.equal(finalReleaseCount, initialReleaseCount, 'Release record count must not change');
  });

  // ── 34. No Successful Deployment Status Written ─────────────────────
  await t.test('34. Build does not update deployment status to success in database', async () => {
    const db = getDatabase();
    const deploymentIdForDbCheck = '77777777-7777-4777-8777-777777777777';

    // Insert dummy pending deployment
    try {
      db.prepare(`
        INSERT OR IGNORE INTO applications (id, name, slug, repo_url, branch, port)
        VALUES (?, 'Db Test App', 'db-test-app', 'https://github.com/test/app.git', 'main', 3000)
      `).run(testAppId);

      db.prepare(`
        INSERT OR IGNORE INTO deployments (id, application_id, commit_sha, status, trigger_source)
        VALUES (?, ?, ?, 'building', 'manual')
      `).run(deploymentIdForDbCheck, testAppId, testCommitSha);
    } catch {}

    const mockSpawn = () => createMockChildProcess({ exitCode: 0 });

    await buildImage(
      {
        deploymentId: deploymentIdForDbCheck,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    const depRow = db.prepare('SELECT status FROM deployments WHERE id = ?').get(deploymentIdForDbCheck);
    if (depRow) {
      assert.notEqual(depRow.status, 'success', 'Deployment status must not be updated to success');
    }
  });

  // ── 35. No Application Containers Started ───────────────────────────
  await t.test('35. Builder does not execute docker run or start containers', async () => {
    const executedDockerCommands = [];
    const mockSpawn = (cmd, args) => {
      executedDockerCommands.push({ cmd, subCmd: args[0] });
      return createMockChildProcess({ exitCode: 0 });
    };

    await buildImage(
      {
        deploymentId: testDeploymentId,
        applicationId: testAppId,
        commitSha: testCommitSha,
        workspacePath: validWorkspacePath,
        buildType: 'dockerfile'
      },
      {
        logRoot,
        allowOverwrite: true,
        spawn: mockSpawn,
        execFile: createMockExecFile()
      }
    );

    for (const execution of executedDockerCommands) {
      assert.notEqual(execution.subCmd, 'run', 'docker run must never be invoked');
      assert.notEqual(execution.subCmd, 'start', 'docker start must never be invoked');
    }
  });
});
