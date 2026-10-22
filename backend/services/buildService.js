const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {
  createBuildLogger,
  resolveLogPath,
  readBuildLog,
  getBuildLogRoot,
  BuildLogError
} = require('./buildLogService');

/**
 * Structured service error class for Image Build operations.
 */
class BuildServiceError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'BuildServiceError';
    this.code = code;
    this.details = details;
  }
}

// Strict validation patterns
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const DOCKER_IMAGE_TAG_REGEX = /^[a-z0-9][a-z0-9_.-]*(?:\/[a-z0-9][a-z0-9_.-]*)*(?::[a-zA-Z0-9_.-]+)?$/;
const IMAGE_ID_REGEX = /^sha256:[0-9a-f]{64}$/i;

// Forbidden host root paths that must never be selected as build context
const FORBIDDEN_HOST_PATHS = [
  '/',
  '/etc',
  '/home/ubuntu',
  '/var',
  '/var/run',
  '/var/run/docker.sock',
  '/run',
  '/sys',
  '/proc',
  '/dev',
  '/root'
];

/**
 * Validates input parameters for building an image.
 */
function validateBuildInput(input) {
  if (!input || typeof input !== 'object') {
    throw new BuildServiceError('Build input must be a valid object.', 'INVALID_BUILD_INPUT');
  }

  const { deploymentId, applicationId, commitSha, buildType, workspacePath } = input;

  // 1. Validate Deployment ID
  if (!deploymentId || typeof deploymentId !== 'string' || !UUID_REGEX.test(deploymentId.trim())) {
    throw new BuildServiceError(
      `Invalid deployment ID "${deploymentId}". Expected valid UUID.`,
      'INVALID_DEPLOYMENT_ID'
    );
  }

  // 2. Validate Application ID
  if (!applicationId || typeof applicationId !== 'string' || !UUID_REGEX.test(applicationId.trim())) {
    throw new BuildServiceError(
      `Invalid application ID "${applicationId}". Expected valid UUID.`,
      'INVALID_APPLICATION_ID'
    );
  }

  // 3. Validate Commit SHA
  if (!commitSha || typeof commitSha !== 'string' || !COMMIT_SHA_REGEX.test(commitSha.trim())) {
    throw new BuildServiceError(
      `Invalid commit SHA "${commitSha}". Expected 40-character hexadecimal SHA.`,
      'INVALID_COMMIT_SHA'
    );
  }

  // 4. Validate Build Type
  if (!buildType || typeof buildType !== 'string') {
    throw new BuildServiceError('Build type is required.', 'INVALID_BUILD_TYPE');
  }

  const normalizedBuildType = buildType.trim().toLowerCase();
  if (normalizedBuildType === 'railpack') {
    throw new BuildServiceError(
      'Railpack build type is not supported in Phase 4B1. Only "dockerfile" builds are supported.',
      'UNSUPPORTED_BUILD_TYPE'
    );
  }
  if (normalizedBuildType === 'compose') {
    throw new BuildServiceError(
      'Compose build type is not supported in Phase 4B1. Only "dockerfile" builds are supported.',
      'UNSUPPORTED_BUILD_TYPE'
    );
  }
  if (normalizedBuildType !== 'dockerfile') {
    throw new BuildServiceError(
      `Unsupported build type "${buildType}". Only "dockerfile" builds are supported.`,
      'UNSUPPORTED_BUILD_TYPE'
    );
  }

  // 5. Validate Workspace Path format
  if (!workspacePath || typeof workspacePath !== 'string' || workspacePath.trim().length === 0) {
    throw new BuildServiceError('Workspace path is required.', 'INVALID_WORKSPACE_PATH');
  }

  return {
    deploymentId: deploymentId.trim().toLowerCase(),
    applicationId: applicationId.trim().toLowerCase(),
    commitSha: commitSha.trim().toLowerCase(),
    buildType: normalizedBuildType,
    workspacePath: workspacePath.trim()
  };
}

/**
 * Validates and ensures the workspace and build context meet strict security and isolation boundaries.
 */
function verifySourceIntegrity(validatedInput, options = {}) {
  const { workspacePath, applicationId, commitSha } = validatedInput;

  // 1. Ensure workspace exists and is a directory
  if (!fs.existsSync(workspacePath)) {
    throw new BuildServiceError(
      `Workspace directory "${workspacePath}" does not exist.`,
      'WORKSPACE_NOT_FOUND'
    );
  }

  let realWorkspacePath;
  try {
    realWorkspacePath = fs.realpathSync(workspacePath);
  } catch (err) {
    throw new BuildServiceError(`Failed to resolve workspace path: ${err.message}`, 'WORKSPACE_ACCESS_DENIED');
  }

  const stat = fs.statSync(realWorkspacePath);
  if (!stat.isDirectory()) {
    throw new BuildServiceError(`Workspace path "${realWorkspacePath}" is not a directory.`, 'WORKSPACE_INVALID');
  }

  // 2. Reject forbidden host paths
  for (const forbidden of FORBIDDEN_HOST_PATHS) {
    if (realWorkspacePath === forbidden || realWorkspacePath === path.resolve(forbidden)) {
      throw new BuildServiceError(
        `Host directory "${forbidden}" is strictly forbidden as a build workspace.`,
        'FORBIDDEN_WORKSPACE_PATH'
      );
    }
  }

  // 3. Reject K-Panel source directory itself
  const kpanelSourceDir = path.resolve(path.join(__dirname, '..'));
  if (realWorkspacePath === kpanelSourceDir || realWorkspacePath.startsWith(kpanelSourceDir + path.sep)) {
    throw new BuildServiceError(
      'K-Panel internal source directory cannot be used as build workspace.',
      'FORBIDDEN_WORKSPACE_PATH'
    );
  }

  // 4. Enforce workspace root boundaries if configured
  const configuredRoot = options.workspaceRoot || process.env.KPANEL_WORKSPACE_ROOT;
  if (configuredRoot && typeof configuredRoot === 'string' && configuredRoot.trim().length > 0) {
    const resolvedRoot = path.resolve(configuredRoot.trim());
    if (fs.existsSync(resolvedRoot)) {
      const realRoot = fs.realpathSync(resolvedRoot);
      if (!realWorkspacePath.startsWith(realRoot + path.sep)) {
        throw new BuildServiceError(
          `Workspace path "${realWorkspacePath}" escapes the configured workspace root "${realRoot}".`,
          'WORKSPACE_ACCESS_DENIED'
        );
      }
      // Ensure workspace path contains the application ID
      if (!realWorkspacePath.includes(applicationId)) {
        throw new BuildServiceError(
          `Workspace path does not belong to application ID "${applicationId}".`,
          'WORKSPACE_TENANT_MISMATCH'
        );
      }
    }
  }

  // 5. Validate repository-relative buildPath
  const rawBuildPath = options.buildPath !== undefined && options.buildPath !== null ? String(options.buildPath).trim() : '.';
  // Reject absolute buildPath
  if (path.isAbsolute(rawBuildPath)) {
    throw new BuildServiceError(
      `Build path "${rawBuildPath}" must be repository-relative, not absolute.`,
      'INVALID_BUILD_PATH'
    );
  }

  // Reject path traversal
  if (rawBuildPath.includes('..')) {
    throw new BuildServiceError(
      `Build path "${rawBuildPath}" contains path traversal sequences.`,
      'PATH_TRAVERSAL_DETECTED'
    );
  }

  const resolvedBuildContext = path.resolve(realWorkspacePath, rawBuildPath);
  if (!fs.existsSync(resolvedBuildContext)) {
    throw new BuildServiceError(
      `Build context directory "${rawBuildPath}" does not exist in workspace.`,
      'BUILD_CONTEXT_NOT_FOUND'
    );
  }

  let realBuildContext;
  try {
    realBuildContext = fs.realpathSync(resolvedBuildContext);
  } catch (err) {
    throw new BuildServiceError(`Failed to resolve build context path: ${err.message}`, 'BUILD_CONTEXT_INVALID');
  }

  const contextStat = fs.statSync(realBuildContext);
  if (!contextStat.isDirectory()) {
    throw new BuildServiceError(
      `Build context path "${rawBuildPath}" is not a directory.`,
      'BUILD_CONTEXT_INVALID'
    );
  }

  // Reject symlink escape of build context outside workspace
  if (realBuildContext !== realWorkspacePath && !realBuildContext.startsWith(realWorkspacePath + path.sep)) {
    throw new BuildServiceError(
      'Build context escapes workspace via symbolic link or traversal.',
      'WORKSPACE_ACCESS_DENIED'
    );
  }

  // 6. Validate Dockerfile
  const rawDockerfilePath = options.dockerfilePath !== undefined && options.dockerfilePath !== null
    ? String(options.dockerfilePath).trim()
    : 'Dockerfile';

  if (path.isAbsolute(rawDockerfilePath)) {
    throw new BuildServiceError(
      `Dockerfile path "${rawDockerfilePath}" must be relative, not absolute.`,
      'INVALID_DOCKERFILE_PATH'
    );
  }

  if (rawDockerfilePath.includes('..')) {
    throw new BuildServiceError(
      `Dockerfile path "${rawDockerfilePath}" contains path traversal sequences.`,
      'PATH_TRAVERSAL_DETECTED'
    );
  }

  // Check candidate locations: relative to build context or relative to workspace root
  let candidateDockerfilePath = path.resolve(realBuildContext, rawDockerfilePath);
  if (!fs.existsSync(candidateDockerfilePath)) {
    const altCandidate = path.resolve(realWorkspacePath, rawDockerfilePath);
    if (fs.existsSync(altCandidate)) {
      candidateDockerfilePath = altCandidate;
    } else {
      throw new BuildServiceError(
        `Dockerfile was not found at "${rawDockerfilePath}".`,
        'DOCKERFILE_NOT_FOUND'
      );
    }
  }

  let realDockerfilePath;
  try {
    realDockerfilePath = fs.realpathSync(candidateDockerfilePath);
  } catch (err) {
    throw new BuildServiceError(`Failed to resolve Dockerfile: ${err.message}`, 'DOCKERFILE_NOT_FOUND');
  }

  const dockerfileStat = fs.statSync(realDockerfilePath);
  if (!dockerfileStat.isFile()) {
    throw new BuildServiceError(
      `Resolved Dockerfile path "${realDockerfilePath}" is not a regular file.`,
      'DOCKERFILE_NOT_FOUND'
    );
  }

  // Ensure Dockerfile does not escape workspace
  if (!realDockerfilePath.startsWith(realWorkspacePath + path.sep)) {
    throw new BuildServiceError(
      'Dockerfile escapes workspace boundary via symbolic link.',
      'WORKSPACE_ACCESS_DENIED'
    );
  }

  return {
    realWorkspacePath,
    realBuildContext,
    realDockerfilePath,
    relativeBuildPath: path.relative(realWorkspacePath, realBuildContext) || '.',
    relativeDockerfilePath: path.relative(realWorkspacePath, realDockerfilePath)
  };
}

/**
 * Verifies that the checked out Git HEAD in workspace matches the expected commit SHA.
 */
async function verifyGitCommitHead(workspacePath, expectedCommitSha, options = {}) {
  const runner = options.execFile || execFile;
  const gitBinary = options.gitBinary || 'git';

  return new Promise((resolve, reject) => {
    runner(
      gitBinary,
      ['rev-parse', 'HEAD'],
      {
        cwd: workspacePath,
        timeout: 5000,
        env: { PATH: process.env.PATH || '/usr/local/bin:/usr/bin:/bin' }
      },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new BuildServiceError(
              `Failed to verify Git commit HEAD in workspace: ${stderr || err.message}`,
              'GIT_HEAD_VERIFICATION_FAILED'
            )
          );
        }
        const actualHead = (stdout || '').trim().toLowerCase();
        if (actualHead !== expectedCommitSha.toLowerCase()) {
          return reject(
            new BuildServiceError(
              `Workspace Git HEAD commit "${actualHead}" does not match expected commit SHA "${expectedCommitSha}".`,
              'GIT_COMMIT_MISMATCH'
            )
          );
        }
        resolve(actualHead);
      }
    );
  });
}

/**
 * Generates an immutable, traceable Docker image tag.
 * Format: kpanel/app-<applicationId>:d-<deploymentId>-<shortSha>
 */
function generateImageTag(applicationId, deploymentId, commitSha) {
  const shortSha = commitSha.slice(0, 7).toLowerCase();
  const repoName = `kpanel/app-${applicationId.toLowerCase()}`;
  const tagName = `d-${deploymentId.toLowerCase()}-${shortSha}`;
  const fullTag = `${repoName}:${tagName}`;

  if (!DOCKER_IMAGE_TAG_REGEX.test(fullTag)) {
    throw new BuildServiceError(`Generated image tag "${fullTag}" is invalid.`, 'INVALID_IMAGE_TAG');
  }

  return fullTag;
}

/**
 * Checks Docker binary and Buildx plugin availability.
 */
async function checkDockerAvailability(options = {}) {
  const runner = options.execFile || execFile;
  const dockerBin = options.dockerBinary || 'docker';

  // 1. Check Docker CLI binary
  await new Promise((resolve, reject) => {
    runner(dockerBin, ['--version'], { timeout: 5000 }, (err) => {
      if (err) {
        if (err.code === 'ENOENT') {
          return reject(
            new BuildServiceError(
              `Docker binary "${dockerBin}" was not found on system PATH.`,
              'DOCKER_NOT_FOUND'
            )
          );
        }
        return reject(
          new BuildServiceError(
            `Docker CLI check failed: ${err.message}`,
            'DOCKER_NOT_FOUND'
          )
        );
      }
      resolve();
    });
  });

  // 2. Check Buildx plugin
  await new Promise((resolve, reject) => {
    runner(dockerBin, ['buildx', 'version'], { timeout: 5000 }, (err, stdout) => {
      if (err) {
        return reject(
          new BuildServiceError(
            `Docker Buildx plugin is not installed or available: ${err.message}`,
            'BUILDX_NOT_AVAILABLE'
          )
        );
      }
      resolve();
    });
  });

  // 3. Check Docker daemon availability (unless explicitly skipped in testing)
  if (options.skipDaemonCheck !== true) {
    await new Promise((resolve, reject) => {
      runner(dockerBin, ['info', '--format', '{{.ServerVersion}}'], { timeout: 5000 }, (err, stdout, stderr) => {
        if (err) {
          return reject(
            new BuildServiceError(
              `Docker daemon is not running or accessible: ${stderr || err.message}`,
              'DOCKER_DAEMON_UNAVAILABLE'
            )
          );
        }
        resolve();
      });
    });
  }
}

/**
 * Inspects a built Docker image to retrieve its immutable Image ID.
 * Verifies that the image actually exists in the local image store.
 */
async function inspectImageId(imageTag, options = {}) {
  const runner = options.execFile || execFile;
  const dockerBin = options.dockerBinary || 'docker';

  return new Promise((resolve, reject) => {
    runner(
      dockerBin,
      ['image', 'inspect', '--format', '{{.Id}}', imageTag],
      { timeout: 10000 },
      (err, stdout, stderr) => {
        if (err) {
          return reject(
            new BuildServiceError(
              `Failed to inspect built image "${imageTag}" in local store: ${stderr || err.message}`,
              'IMAGE_INSPECTION_FAILED'
            )
          );
        }

        const imageId = (stdout || '').trim();
        if (!imageId || !IMAGE_ID_REGEX.test(imageId)) {
          return reject(
            new BuildServiceError(
              `Docker image inspection returned an invalid image ID: "${imageId}". Expected sha256:... format.`,
              'IMAGE_INSPECTION_FAILED'
            )
          );
        }

        resolve(imageId);
      }
    );
  });
}

/**
 * Safely terminates a spawned child process.
 */
function terminateProcess(child) {
  if (!child || child.killed) return;
  try {
    child.kill('SIGTERM');
  } catch {}

  const forceKillTimer = setTimeout(() => {
    try {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
    } catch {}
  }, 3000);
  forceKillTimer.unref();
}

/**
 * Constructs sanitized subprocess environment containing only safe system and Docker variables.
 * Strictly prevents forwarding backend secrets, tokens, or private credentials.
 */
function buildSanitizedEnvironment(options = {}) {
  const allowedKeys = [
    'PATH',
    'HOME',
    'TMPDIR',
    'DOCKER_HOST',
    'DOCKER_CONFIG',
    'DOCKER_CERT_PATH',
    'DOCKER_TLS_VERIFY'
  ];

  const env = {};
  for (const key of allowedKeys) {
    if (process.env[key] !== undefined) {
      env[key] = process.env[key];
    }
  }

  // Ensure PATH has standard fallbacks if unset
  if (!env.PATH) {
    env.PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
  }

  if (options.extraEnv && typeof options.extraEnv === 'object') {
    for (const [key, val] of Object.entries(options.extraEnv)) {
      // Strictly prevent token/secret injection
      if (/token|secret|key|password|auth/i.test(key)) {
        continue;
      }
      env[key] = String(val);
    }
  }

  return env;
}

/**
 * Standalone Docker BuildKit Image Building Service.
 * Takes a verified workspace, builds an image via Buildx, persists bounded logs,
 * and retrieves immutable image ID without touching the deployment queue, release records,
 * or running application containers.
 *
 * @param {Object} input - Build input parameters
 * @param {string} input.deploymentId - Deployment UUID
 * @param {string} input.applicationId - Application UUID
 * @param {string} input.commitSha - Git commit 40-character hexadecimal SHA
 * @param {string} input.workspacePath - Verified filesystem workspace path
 * @param {string} input.buildType - Build type ('dockerfile' only)
 * @param {Object} [options] - Build execution options
 * @param {string} [options.buildPath] - Repository-relative build path
 * @param {string} [options.dockerfilePath] - Relative Dockerfile path
 * @param {string} [options.platform='linux/arm64'] - Target architecture platform
 * @param {number} [options.timeout=600000] - Execution timeout in ms (default 10 min)
 * @param {AbortSignal} [options.signal] - Caller cancellation signal
 * @returns {Promise<Object>} Build result containing image identity and metadata
 */
async function buildImage(input, options = {}) {
  const startTime = Date.now();

  // 1. Strict Input Validation
  const validatedInput = validateBuildInput(input);
  const { deploymentId, applicationId, commitSha, workspacePath, buildType } = validatedInput;

  // 2. Strict Source Integrity Verification
  const sourceContext = verifySourceIntegrity(validatedInput, options);
  const { realWorkspacePath, realBuildContext, realDockerfilePath, relativeBuildPath, relativeDockerfilePath } = sourceContext;

  // 3. Verify Git HEAD commit matches expected commitSha
  if (options.skipGitHeadCheck !== true) {
    await verifyGitCommitHead(realWorkspacePath, commitSha, options);
  }

  // 4. Generate Immutable Image Tag
  const imageTag = options.imageTag || generateImageTag(applicationId, deploymentId, commitSha);
  const platform = options.platform || 'linux/arm64';

  if (!/^[a-z0-9_-]+\/[a-z0-9_-]+$/i.test(platform)) {
    throw new BuildServiceError(`Invalid platform specification "${platform}".`, 'INVALID_BUILD_PARAMETER');
  }

  // 5. Initialize Persistent Build Logger
  let logger;
  try {
    logger = createBuildLogger(deploymentId, {
      logRoot: options.logRoot,
      maxLogBytes: options.maxLogBytes,
      maxLineBytes: options.maxLineBytes,
      allowOverwrite: options.allowOverwrite
    });
  } catch (err) {
    if (err instanceof BuildLogError) {
      throw new BuildServiceError(err.message, err.code, err.details);
    }
    throw new BuildServiceError(`Failed to initialize build log: ${err.message}`, 'LOG_DIRECTORY_ERROR');
  }

  // Record initial marker
  logger.writeMarker(
    `BUILD STARTED: deployment=${deploymentId} app=${applicationId} commit=${commitSha} tag=${imageTag} platform=${platform}`
  );

  // 6. Pre-flight Docker & Buildx Checks
  try {
    await checkDockerAvailability(options);
  } catch (err) {
    logger.writeMarker(`BUILD PREFLIGHT FAILED: ${err.code} - ${err.message}`);
    logger.close();
    throw err;
  }

  // 7. Check if already cancelled before starting child process
  if (options.signal && options.signal.aborted) {
    logger.writeMarker('BUILD CANCELLED BEFORE START: Received abort signal');
    logger.close();
    throw new BuildServiceError('Build operation was cancelled before start.', 'OPERATION_CANCELLED');
  }

  // 8. Construct Fixed Argument Array for Docker Buildx
  const dockerBin = options.dockerBinary || 'docker';
  const spawnRunner = options.spawn || spawn;
  const buildArgs = [
    'buildx',
    'build',
    '--platform', platform,
    '--progress', 'plain',
    '--load',
    '--tag', imageTag,
    '--file', realDockerfilePath,
    realBuildContext
  ];

  const sanitizedEnv = buildSanitizedEnvironment(options);

  // 9. Execute Docker Buildx via child_process.spawn (shell: false)
  return new Promise((resolve, reject) => {
    let child;
    let timedOut = false;
    let cancelled = false;
    let timeoutTimer = null;
    let abortListener = null;

    const cleanupHandlers = () => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
      }
      if (options.signal && abortListener) {
        options.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };

    // Execution timeout guard
    const timeoutMs = options.timeout || 600000;
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      logger.writeMarker(`BUILD TIMED OUT: Exceeded ${timeoutMs}ms limit`);
      terminateProcess(child);
    }, timeoutMs);

    // AbortSignal cancellation listener
    if (options.signal) {
      abortListener = () => {
        cancelled = true;
        logger.writeMarker('BUILD CANCELLED: Received cancellation signal');
        terminateProcess(child);
      };
      options.signal.addEventListener('abort', abortListener, { once: true });
    }

    try {
      child = spawnRunner(dockerBin, buildArgs, {
        cwd: realBuildContext,
        shell: false,
        env: sanitizedEnv
      });
    } catch (err) {
      cleanupHandlers();
      logger.writeMarker(`PROCESS SPAWN ERROR: ${err.message}`);
      logger.close();
      return reject(new BuildServiceError(`Failed to spawn Docker process: ${err.message}`, 'DOCKER_SPAWN_ERROR'));
    }

    // Stream stdout and stderr incrementally to persistent log
    if (child.stdout) {
      child.stdout.on('data', (chunk) => {
        try { logger.write(chunk); } catch {}
      });
    }

    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        try { logger.write(chunk); } catch {}
      });
    }

    child.on('error', (err) => {
      cleanupHandlers();
      logger.writeMarker(`PROCESS RUNTIME ERROR: ${err.message}`);
      logger.close();
      if (err.code === 'ENOENT') {
        return reject(
          new BuildServiceError(
            `Docker executable "${dockerBin}" was not found.`,
            'DOCKER_NOT_FOUND'
          )
        );
      }
      return reject(new BuildServiceError(`Docker build process error: ${err.message}`, 'BUILD_FAILED'));
    });

    child.on('close', async (code, signal) => {
      cleanupHandlers();

      // Guard against late success after timeout or cancellation
      if (timedOut) {
        logger.close();
        return reject(
          new BuildServiceError(
            `Build timed out after ${timeoutMs}ms.`,
            'BUILD_TIMEOUT'
          )
        );
      }

      if (cancelled || (options.signal && options.signal.aborted)) {
        logger.close();
        return reject(
          new BuildServiceError(
            'Build operation was cancelled by caller.',
            'OPERATION_CANCELLED'
          )
        );
      }

      if (code !== 0) {
        logger.writeMarker(`BUILD FAILED: Docker exited with code ${code}${signal ? ` (signal: ${signal})` : ''}`);
        logger.close();
        return reject(
          new BuildServiceError(
            `Docker build failed with exit code ${code}.`,
            'BUILD_FAILED',
            { exitCode: code, signal }
          )
        );
      }

      // 10. Post-Build Image Inspection & Immutable Image ID Verification
      let imageId;
      try {
        imageId = await inspectImageId(imageTag, options);
      } catch (inspectErr) {
        logger.writeMarker(`IMAGE INSPECTION ERROR: ${inspectErr.message}`);
        logger.close();
        return reject(inspectErr);
      }

      const buildDurationMs = Date.now() - startTime;
      logger.writeMarker(
        `BUILD SUCCESSFUL: imageTag=${imageTag} imageId=${imageId} duration=${buildDurationMs}ms`
      );
      logger.close();

      resolve({
        deploymentId,
        applicationId,
        commitSha,
        imageTag,
        imageId,
        buildDurationMs,
        logPath: logger.logPath,
        metadata: {
          platform,
          buildType: 'dockerfile',
          buildPath: relativeBuildPath,
          dockerfilePath: relativeDockerfilePath,
          builtAt: new Date().toISOString()
        }
      });
    });
  });
}

module.exports = {
  BuildServiceError,
  buildImage,
  validateBuildInput,
  verifySourceIntegrity,
  verifyGitCommitHead,
  generateImageTag,
  checkDockerAvailability,
  inspectImageId,
  buildSanitizedEnvironment
};
