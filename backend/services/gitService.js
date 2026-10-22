const { spawn, execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const os = require('os');
const githubAppService = require('./githubAppService');
const { startCredentialBroker } = require('./gitCredentialBroker');

const ASKPASS_HELPER_PATH = path.resolve(path.join(__dirname, '..', 'helpers', 'gitAskpass.js'));

/**
 * Structured service error class for Git operations.
 */
class GitServiceError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'GitServiceError';
    this.code = code;
    this.details = details;
  }
}

// Strict UUID regex for workspace directory isolation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// GitHub repository identity regex: owner and repo
const GITHUB_OWNER_REGEX = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/;
const GITHUB_REPO_REGEX = /^[a-zA-Z0-9._-]+$/;

/**
 * Resolves the configured workspace root.
 * Fails closed if KPANEL_WORKSPACE_ROOT is not configured.
 */
function getWorkspaceRoot(customRoot) {
  if (customRoot && typeof customRoot === 'string' && customRoot.trim().length > 0) {
    return path.resolve(customRoot.trim());
  }
  if (process.env.KPANEL_WORKSPACE_ROOT && process.env.KPANEL_WORKSPACE_ROOT.trim().length > 0) {
    return path.resolve(process.env.KPANEL_WORKSPACE_ROOT.trim());
  }
  throw new GitServiceError(
    'KPANEL_WORKSPACE_ROOT environment variable is not configured. Real Git workspace operations are locked.',
    'WORKSPACE_ERROR'
  );
}

/**
 * Validates and normalizes public GitHub HTTPS repository URLs.
 * Rejects credentials, unsupported hosts, local paths, and malformed structures.
 */
function validateRepositoryUrl(rawUrl, options = {}) {
  if (!rawUrl || typeof rawUrl !== 'string') {
    throw new GitServiceError('Repository URL is required and must be a string.', 'INVALID_REPOSITORY_URL');
  }

  const trimmed = rawUrl.trim();

  // Explicit check for SSH repository URLs
  if (trimmed.startsWith('git@') || trimmed.startsWith('ssh://')) {
    throw new GitServiceError(
      'SSH repository URLs are not currently supported in Phase 3A. Only public HTTPS GitHub URLs are supported.',
      'UNSUPPORTED_AUTH_METHOD'
    );
  }

  // Allow local fixture URLs strictly when testing and explicitly enabled
  if (trimmed.startsWith('file://')) {
    if (options.allowTestFixture && process.env.NODE_ENV === 'test') {
      const fixturePath = trimmed.slice(7);
      if (!fs.existsSync(fixturePath)) {
        throw new GitServiceError('Test fixture repository does not exist.', 'REPOSITORY_NOT_FOUND');
      }
      return {
        owner: 'fixture-owner',
        repo: 'fixture-repo',
        normalizedUrl: trimmed,
        isHttps: false,
        isTestFixture: true
      };
    }
    throw new GitServiceError('Local file repository schemes are not permitted.', 'INVALID_REPOSITORY_URL');
  }

  // Reject local file schemes or path traversal
  if (/^(\/|\.\/|\.\.\/|[a-zA-Z]:\\)/i.test(trimmed)) {
    throw new GitServiceError('Local file repository schemes are not permitted.', 'INVALID_REPOSITORY_URL');
  }

  // Reject control characters, newlines, or whitespace
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    throw new GitServiceError('Repository URL must not contain whitespace or control characters.', 'INVALID_REPOSITORY_URL');
  }

  // Reject protocol-relative URLs
  if (trimmed.startsWith('//')) {
    throw new GitServiceError('Protocol-relative URLs are not permitted.', 'INVALID_REPOSITORY_URL');
  }

  // Reject embedded credentials (e.g. https://user:pass@github.com/... or https://token@...)
  if (/^[a-zA-Z]+:\/\/[^@/\s]+@/.test(trimmed) || /:([^@/\s]+)@/.test(trimmed)) {
    throw new GitServiceError('Repository URL must not contain embedded authentication credentials.', 'INVALID_REPOSITORY_URL');
  }

  // Reject query strings or hash fragments
  if (trimmed.includes('?') || trimmed.includes('#')) {
    throw new GitServiceError('Repository URL must not contain query parameters or URL fragments.', 'INVALID_REPOSITORY_URL');
  }

  // Reject traversal sequences before WHATWG URL normalization resolves them away
  if (trimmed.includes('..') || /%2e%2e/i.test(trimmed)) {
    throw new GitServiceError('Repository URL path contains invalid traversal sequences.', 'INVALID_REPOSITORY_URL');
  }

  // Parse as standard URL
  let parsedUrl;
  try {
    parsedUrl = new URL(trimmed);
  } catch {
    throw new GitServiceError('Repository URL is malformed.', 'INVALID_REPOSITORY_URL');
  }

  // Enforce HTTPS
  if (parsedUrl.protocol !== 'https:') {
    throw new GitServiceError('Only HTTPS repository URLs are supported.', 'INVALID_REPOSITORY_URL');
  }

  // Enforce exact github.com hostname (reject localhost, IP addresses, other hosts)
  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname !== 'github.com') {
    if (hostname.includes('gitlab.com') || hostname.includes('bitbucket.org')) {
      throw new GitServiceError(
        `Git host "${hostname}" is not currently supported. Phase 3A supports public GitHub repositories only.`,
        'UNSUPPORTED_REPOSITORY_HOST'
      );
    }
    throw new GitServiceError(
      `Unsupported Git host "${hostname}". Only public GitHub repositories (github.com) are permitted.`,
      'UNSUPPORTED_REPOSITORY_HOST'
    );
  }

  // Reject unusual ports
  if (parsedUrl.port && parsedUrl.port !== '443') {
    throw new GitServiceError('Repository URL specifies an unsupported network port.', 'INVALID_REPOSITORY_URL');
  }

  // Validate path segments (must be /<owner>/<repo>)
  const cleanPath = parsedUrl.pathname.replace(/^\/+|\/+$/g, '');
  const segments = cleanPath.split('/');

  if (segments.length !== 2) {
    throw new GitServiceError(
      'Repository URL must follow the exact format "https://github.com/owner/repository".',
      'INVALID_REPOSITORY_URL'
    );
  }

  const [rawOwner, rawRepo] = segments;

  // Reject path traversal tokens
  if (rawOwner.includes('..') || rawRepo.includes('..') || rawOwner === '.' || rawRepo === '.') {
    throw new GitServiceError('Repository URL path contains invalid traversal sequences.', 'INVALID_REPOSITORY_URL');
  }

  // Strip optional .git suffix from repo
  const repo = rawRepo.endsWith('.git') ? rawRepo.slice(0, -4) : rawRepo;
  const owner = rawOwner;

  if (!GITHUB_OWNER_REGEX.test(owner)) {
    throw new GitServiceError(`Invalid GitHub owner identifier "${owner}".`, 'INVALID_REPOSITORY_URL');
  }

  if (!GITHUB_REPO_REGEX.test(repo) || repo === '.' || repo === '..') {
    throw new GitServiceError(`Invalid GitHub repository identifier "${repo}".`, 'INVALID_REPOSITORY_URL');
  }

  const normalizedUrl = `https://github.com/${owner}/${repo}.git`;
  const isTestFixture = Boolean(options.allowTestFixture && process.env.NODE_ENV === 'test');

  return {
    owner,
    repo,
    normalizedUrl,
    isHttps: true,
    isTestFixture
  };
}

/**
 * Validates Git branch reference name.
 * Strictly checks for option injection (starting with '-') and Git ref format rules.
 */
function validateBranch(branch) {
  if (!branch || typeof branch !== 'string') {
    throw new GitServiceError('Branch name is required and must be a string.', 'INVALID_BRANCH');
  }

  const trimmed = branch.trim();

  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new GitServiceError('Branch name must be between 1 and 100 characters.', 'INVALID_BRANCH');
  }

  // Prevent command-option injection in git CLI arguments
  if (trimmed.startsWith('-')) {
    throw new GitServiceError('Branch name must not begin with a hyphen ("-").', 'INVALID_BRANCH');
  }

  // Reject control characters or whitespace
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    throw new GitServiceError('Branch name must not contain whitespace or control characters.', 'INVALID_BRANCH');
  }

  // Reject git reference rule violations
  if (
    trimmed.includes('..') ||
    trimmed.includes('~') ||
    trimmed.includes('^') ||
    trimmed.includes(':') ||
    trimmed.includes('?') ||
    trimmed.includes('*') ||
    trimmed.includes('[') ||
    trimmed.includes('\\') ||
    trimmed.includes('@{') ||
    trimmed.includes('//') ||
    trimmed.startsWith('/') ||
    trimmed.endsWith('/') ||
    trimmed.endsWith('.') ||
    trimmed.endsWith('.lock')
  ) {
    throw new GitServiceError(`Invalid Git branch reference name "${trimmed}".`, 'INVALID_BRANCH');
  }

  return trimmed;
}

/**
 * Builds an isolated, restricted environment for git subprocess execution.
 */
function getRestrictedGitEnv() {
  return {
    PATH: process.env.PATH || '/usr/bin:/bin:/usr/local/bin',
    GIT_TERMINAL_PROMPT: '0',        // Disable interactive credential prompts
    GIT_CONFIG_NOSYSTEM: '1',        // Ignore system gitconfig
    GIT_CONFIG_GLOBAL: '/dev/null',  // Ignore user ~/.gitconfig
    GIT_CONFIG_SYSTEM: '/dev/null',  // Ignore system gitconfig
    GIT_CONFIG_PARAMETERS: '',       // Neutralize configuration parameter injection
    GIT_CONFIG_COUNT: '0',           // Neutralize config count injection
    GIT_ASKPASS: 'echo',             // Never spawn GUI/CLI password prompters
    SSH_ASKPASS: 'echo',
    GIT_SSH_COMMAND: 'echo',         // Neutralize SSH transport execution
    HOME: '/dev/null',               // Prevent reading user keys
    TMPDIR: os.tmpdir()
  };
}

/**
 * Safely executes a Git subprocess with explicit argument array, timeout, and output bounding.
 * Never executes through a shell.
 */
function executeGitCommand(args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 60000;
    const maxBuffer = options.maxBuffer || 1024 * 1024; // 1 MB output limit
    const cwd = options.cwd || process.cwd();
    const env = { ...getRestrictedGitEnv(), ...(options.extraEnv || {}) };

    let stdout = '';
    let stderr = '';
    let isTerminated = false;

    // Immediate check if signal is already aborted
    if (options.signal && options.signal.aborted) {
      return reject(new GitServiceError('Git operation was cancelled by caller.', 'OPERATION_CANCELLED'));
    }

    // Use spawn with argument array directly (shell: false)
    const child = spawn('git', args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });

    // Timeout guard with process termination
    const timer = setTimeout(() => {
      isTerminated = true;
      child.kill('SIGTERM');
      setTimeout(() => {
        try { child.kill('SIGKILL'); } catch {}
      }, 3000);
      reject(new GitServiceError(`Git operation timed out after ${timeout / 1000} seconds.`, 'GIT_TIMEOUT'));
    }, timeout);

    // Cancellation support via AbortSignal
    let onAbort;
    if (options.signal) {
      onAbort = () => {
        if (!isTerminated) {
          isTerminated = true;
          clearTimeout(timer);
          child.kill('SIGTERM');
          setTimeout(() => {
            try { child.kill('SIGKILL'); } catch {}
          }, 3000).unref();
          reject(new GitServiceError('Git operation was cancelled by caller.', 'OPERATION_CANCELLED'));
        }
      };
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    child.stdout.on('data', (chunk) => {
      if (stdout.length + chunk.length <= maxBuffer) {
        stdout += chunk.toString();
      }
    });

    child.stderr.on('data', (chunk) => {
      if (stderr.length + chunk.length <= maxBuffer) {
        stderr += chunk.toString();
      }
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      if (options.signal && onAbort) {
        try { options.signal.removeEventListener('abort', onAbort); } catch {}
      }
      if (!isTerminated) {
        reject(new GitServiceError(`Failed to spawn Git process: ${err.message}`, 'GIT_FETCH_FAILED'));
      }
    });

    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (options.signal && onAbort) {
        try { options.signal.removeEventListener('abort', onAbort); } catch {}
      }
      if (isTerminated) return;

      resolve({
        code,
        signal,
        stdout: stdout.trim(),
        stderr: stderr.trim()
      });
    });
  });
}

/**
 * Resolves the requested remote branch to an exact commit SHA using git ls-remote.
 */
async function inspectRemoteBranch(repoUrl, branch, options = {}) {
  const { normalizedUrl, isTestFixture } = validateRepositoryUrl(repoUrl, options);
  const validatedBranch = validateBranch(branch);

  const extraConfig = isTestFixture ? ['-c', 'protocol.file.allow=always'] : ['-c', 'protocol.file.allow=never'];
  const gitArgs = [
    ...extraConfig,
    '-c', 'http.followRedirects=false',
    'ls-remote',
    '--heads',
    '--',
    normalizedUrl,
    `refs/heads/${validatedBranch}`
  ];

  const result = await executeGitCommand(gitArgs, { timeout: options.timeout || 30000 });

  if (result.code !== 0) {
    const errText = result.stderr.toLowerCase();
    if (errText.includes('repository not found') || errText.includes('could not read username') || errText.includes('authentication failed')) {
      throw new GitServiceError(
        'Repository was not found or is private. Only public repositories are supported.',
        'REPOSITORY_NOT_FOUND'
      );
    }
    throw new GitServiceError(`Failed to inspect remote Git repository: ${result.stderr}`, 'GIT_FETCH_FAILED');
  }

  if (!result.stdout) {
    throw new GitServiceError(
      `Branch "${validatedBranch}" was not found in repository "${normalizedUrl}".`,
      'BRANCH_NOT_FOUND'
    );
  }

  // Parse commit SHA from output format: "<sha>\trefs/heads/<branch>"
  const match = result.stdout.match(/^([0-9a-f]{40})\s+refs\/heads\//i);
  if (!match) {
    throw new GitServiceError(
      `Failed to parse commit SHA for branch "${validatedBranch}".`,
      'GIT_FETCH_FAILED'
    );
  }

  return {
    commitSha: match[1].toLowerCase(),
    branch: validatedBranch,
    repository: normalizedUrl
  };
}

/**
 * Fetches a shallow snapshot of the selected branch into an isolated workspace directory.
 *
 * @param {Object} application - Application record containing id, repo_url, branch
 * @param {Object} options - Execution options (workspaceRoot, timeout, allowTestFixture)
 * @returns {Object} Snapshot metadata containing workspacePath and exact commitSha
 */
async function fetchRepository(application, options = {}) {
  if (options.signal && options.signal.aborted) {
    throw new GitServiceError('Git operation was cancelled by caller.', 'OPERATION_CANCELLED');
  }

  if (!application || typeof application !== 'object') {
    throw new GitServiceError('Application object is required.', 'WORKSPACE_ERROR');
  }

  const { id: applicationId, repo_url, branch } = application;

  // Validate application UUID format strictly
  if (!applicationId || !UUID_REGEX.test(String(applicationId).trim())) {
    throw new GitServiceError(
      'Invalid application ID format. Expected a standard UUID to ensure filesystem isolation.',
      'WORKSPACE_ERROR',
      { applicationId }
    );
  }

  let authMode = options.authMode;
  let effectiveOptions = { ...options };

  // If authMode is not explicitly provided, attempt to auto-resolve from verified database association
  if (!authMode && options.autoResolveAuth !== false && applicationId) {
    try {
      const githubRepoService = require('./githubRepositoryService');
      const resolved = githubRepoService.resolveApplicationCheckoutAuth(applicationId, options);
      if (resolved) {
        authMode = resolved.authMode;
        effectiveOptions = { ...effectiveOptions, ...resolved };
      }
    } catch (err) {
      if (err.name === 'GithubRepositoryError' && err.code !== 'APPLICATION_NOT_FOUND') {
        throw new GitServiceError(err.message, err.code, err.details);
      }
    }
  }

  authMode = authMode || 'public';
  if (authMode !== 'public' && authMode !== 'github-app') {
    throw new GitServiceError(`Unsupported authentication mode "${authMode}". Supported modes: "public", "github-app".`, 'UNSUPPORTED_AUTH_METHOD');
  }

  const repoInfo = validateRepositoryUrl(repo_url, options);
  const normalizedUrl = repoInfo.normalizedUrl;
  const isTestFixture = repoInfo.isTestFixture;
  const validatedBranch = validateBranch(branch || 'main');

  let broker = null;
  const extraEnv = options.extraEnv ? { ...options.extraEnv } : {};

  // Resolve and verify workspace root
  const workspaceRoot = getWorkspaceRoot(options.workspaceRoot);
  if (!fs.existsSync(workspaceRoot)) {
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new GitServiceError(`Failed to create workspace root: ${err.message}`, 'WORKSPACE_ERROR');
    }
  }

  const resolvedRoot = fs.realpathSync(workspaceRoot);
  const operationId = crypto.randomUUID();

  // Create isolated application and operation directories: <root>/<appId>/<opId>/source
  const appWorkspaceDir = path.join(resolvedRoot, applicationId);
  const opWorkspaceDir = path.join(appWorkspaceDir, operationId);
  const sourceDir = path.join(opWorkspaceDir, 'source');

  // Guard against path traversal
  if (!sourceDir.startsWith(resolvedRoot + path.sep)) {
    throw new GitServiceError('Path traversal detected in workspace path calculation.', 'WORKSPACE_ACCESS_DENIED');
  }

  // Check for symlinks in workspace path before creating
  try {
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new GitServiceError(`Failed to create isolated workspace directory: ${err.message}`, 'WORKSPACE_ERROR');
  }

  // Verify realpath is inside workspaceRoot
  const realSourceDir = fs.realpathSync(sourceDir);
  if (!realSourceDir.startsWith(resolvedRoot + path.sep)) {
    // Clean up rogue directory immediately
    try { fs.rmSync(opWorkspaceDir, { recursive: true, force: true }); } catch {}
    throw new GitServiceError('Symlink-based workspace escape detected.', 'WORKSPACE_ACCESS_DENIED');
  }

  // GitHub App Authenticated Mode Setup
  if (authMode === 'github-app') {
    // 1. Validate installation ID
    const instId = effectiveOptions.installationId;
    if (instId === undefined || instId === null || String(instId).trim().length === 0) {
      throw new GitServiceError('Installation ID is required for GitHub App authenticated checkout.', 'GITHUB_APP_INVALID_ID');
    }
    const instIdStr = String(instId).trim();
    if (!/^[1-9]\d*$/.test(instIdStr)) {
      throw new GitServiceError(`Invalid installation ID "${instIdStr}". Expected positive integer.`, 'GITHUB_APP_INVALID_ID');
    }

    // 2. Validate repository identity mapping
    if (effectiveOptions.repositoryName && String(effectiveOptions.repositoryName).trim().toLowerCase() !== repoInfo.repo.toLowerCase()) {
      throw new GitServiceError(
        `Repository identity mismatch: requested repository "${effectiveOptions.repositoryName}" does not match application repository "${repoInfo.repo}".`,
        'GITHUB_PERMISSION_DENIED'
      );
    }
    if (effectiveOptions.repositoryOwner && String(effectiveOptions.repositoryOwner).trim().toLowerCase() !== repoInfo.owner.toLowerCase()) {
      throw new GitServiceError(
        `Repository owner mismatch: requested owner "${effectiveOptions.repositoryOwner}" does not match application owner "${repoInfo.owner}".`,
        'GITHUB_PERMISSION_DENIED'
      );
    }
    if (effectiveOptions.repositoryId !== undefined && effectiveOptions.repositoryId !== null) {
      const repIdNum = Number(effectiveOptions.repositoryId);
      if (!Number.isInteger(repIdNum) || repIdNum <= 0) {
        throw new GitServiceError('Invalid repository ID format. Expected positive integer.', 'GITHUB_PERMISSION_DENIED');
      }
    }

    // 3. Verify GitHub App configuration exists
    if (!githubAppService.isGithubAppConfigured(effectiveOptions)) {
      throw new GitServiceError('GitHub App identity is not configured on this server.', 'GITHUB_APP_NOT_CONFIGURED');
    }

    // 4. Request short-lived installation access token
    let tokenResult;
    try {
      const tokenOpts = {
        ...effectiveOptions,
        repositories: [repoInfo.repo],
        permissions: { contents: 'read' }
      };
      if (effectiveOptions.repositoryId) {
        tokenOpts.repository_ids = [Number(effectiveOptions.repositoryId)];
      }
      tokenResult = await githubAppService.getInstallationAccessToken(instIdStr, tokenOpts);
    } catch (err) {
      if (err instanceof githubAppService.GithubAppError) {
        throw new GitServiceError(err.message, err.code, err.details);
      }
      throw new GitServiceError(`Failed to acquire GitHub installation token: ${err.message}`, 'GITHUB_AUTH_FAILED');
    }

    // 5. Start isolated local Unix-domain socket credential broker
    try {
      broker = await startCredentialBroker({
        token: tokenResult.token,
        operationId,
        expectedHost: isTestFixture ? 'localhost' : 'github.com',
        timeoutMs: options.timeout || 60000
      });
    } catch (err) {
      throw new GitServiceError(`Failed to start local credential broker: ${err.message}`, 'CREDENTIAL_BROKER_ERROR');
    }

    // Configure askpass environment
    extraEnv.GIT_ASKPASS = process.execPath;
    extraEnv.KPANEL_ASKPASS_SOCKET = broker.socketPath;
    extraEnv.KPANEL_ASKPASS_NONCE = broker.nonce;
  }

  // Prepare shallow clone arguments with security restrictions
  const extraConfig = isTestFixture ? ['-c', 'protocol.file.allow=always'] : ['-c', 'protocol.file.allow=never'];
  const askpassConfig = broker
    ? [
        '-c', `core.askPass=${process.execPath} "${ASKPASS_HELPER_PATH}"`,
        '-c', 'credential.helper='
      ]
    : [];

  const cloneArgs = [
    '-c', 'core.hooksPath=/dev/null',          // Disable repository hooks execution
    '-c', 'submodule.recurse=false',           // Disable submodules
    '-c', 'filter.lfs.smudge=',                // Disable Git LFS smudge execution
    '-c', 'filter.lfs.required=false',
    '-c', 'http.followRedirects=false',        // Disable off-domain HTTP redirects
    ...askpassConfig,
    ...extraConfig,
    'clone',
    '--depth', '1',                            // Shallow clone (depth 1)
    '--branch', validatedBranch,               // Fetch requested branch
    '--single-branch',                         // Only requested branch
    '--no-tags',                               // Do not download tags
    '--',
    (repoInfo.isTestFixture && options.testFixtureUrl) ? options.testFixtureUrl : normalizedUrl,
    realSourceDir
  ];

  try {
    const cloneResult = await executeGitCommand(cloneArgs, {
      timeout: options.timeout || 60000,
      signal: options.signal,
      extraEnv
    });

    if (cloneResult.code !== 0) {
      const errText = cloneResult.stderr.toLowerCase();
      if (errText.includes('could not read username') || errText.includes('authentication failed')) {
        throw new GitServiceError(
          authMode === 'github-app'
            ? 'GitHub App authentication failed for private repository access.'
            : 'Authentication is required to access this repository. Configure GitHub App credentials.',
          'GIT_AUTH_REQUIRED'
        );
      }
      if (errText.includes('repository not found')) {
        throw new GitServiceError(
          authMode === 'github-app'
            ? 'Repository was not found or is not accessible by this GitHub App installation.'
            : 'Repository was not found or is private. Only public repositories are supported without credentials.',
          'REPOSITORY_NOT_FOUND'
        );
      }
      if (errText.includes('remote branch') && errText.includes('not found')) {
        throw new GitServiceError(
          `Branch "${validatedBranch}" was not found in remote repository.`,
          'BRANCH_NOT_FOUND'
        );
      }
      throw new GitServiceError(`Git clone operation failed: ${cloneResult.stderr}`, 'GIT_FETCH_FAILED');
    }

    // Verify fetched commit SHA from local repository HEAD (avoids race conditions)
    const revParseResult = await executeGitCommand(['rev-parse', 'HEAD'], {
      cwd: realSourceDir,
      timeout: 10000
    });

    if (revParseResult.code !== 0 || !/^[0-9a-f]{40}$/i.test(revParseResult.stdout)) {
      throw new GitServiceError(
        'Failed to verify fetched commit SHA in local repository checkout.',
        'GIT_FETCH_FAILED'
      );
    }

    const commitSha = revParseResult.stdout.toLowerCase();

    return {
      operationId,
      applicationId,
      workspacePath: realSourceDir,
      commitSha,
      branch: validatedBranch,
      repository: normalizedUrl,
      fetchedAt: new Date().toISOString()
    };
  } catch (err) {
    // Automatically clean up failed workspace directory
    try {
      if (fs.existsSync(opWorkspaceDir)) {
        fs.rmSync(opWorkspaceDir, { recursive: true, force: true });
      }
    } catch {}
    throw err;
  } finally {
    if (broker) {
      broker.close();
    }
  }
}

/**
 * Safely removes a workspace directory created and tracked by the service.
 * Refuses deletion of arbitrary paths or paths outside KPANEL_WORKSPACE_ROOT.
 */
function cleanupWorkspace(workspaceInfo, options = {}) {
  if (!workspaceInfo || typeof workspaceInfo !== 'object') {
    throw new GitServiceError('Workspace information object is required for cleanup.', 'WORKSPACE_ERROR');
  }

  const { workspacePath, applicationId, operationId } = workspaceInfo;

  if (!workspacePath || typeof workspacePath !== 'string') {
    throw new GitServiceError('Workspace path is required.', 'WORKSPACE_ERROR');
  }

  const workspaceRoot = getWorkspaceRoot(options.workspaceRoot);
  const resolvedRoot = fs.existsSync(workspaceRoot) ? fs.realpathSync(workspaceRoot) : path.resolve(workspaceRoot);
  const resolvedTarget = path.resolve(workspacePath);

  // Security check: Must reside strictly inside resolved workspace root
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new GitServiceError('Refusing to delete path outside the designated workspace root.', 'WORKSPACE_ACCESS_DENIED');
  }

  // Security check: Must match UUID structure for application and operation
  if (applicationId && !UUID_REGEX.test(applicationId)) {
    throw new GitServiceError('Invalid application UUID in cleanup request.', 'WORKSPACE_ACCESS_DENIED');
  }
  if (operationId && !UUID_REGEX.test(operationId)) {
    throw new GitServiceError('Invalid operation UUID in cleanup request.', 'WORKSPACE_ACCESS_DENIED');
  }

  // Locate operation directory (parent of 'source' or the target itself)
  let opDirToDelete = resolvedTarget;
  if (path.basename(resolvedTarget) === 'source') {
    opDirToDelete = path.dirname(resolvedTarget);
  }

  if (fs.existsSync(opDirToDelete)) {
    // Verify target is not a symlink escaping the root
    const lstat = fs.lstatSync(opDirToDelete);
    if (lstat.isSymbolicLink()) {
      throw new GitServiceError('Refusing to delete symlinked directory.', 'WORKSPACE_ACCESS_DENIED');
    }

    fs.rmSync(opDirToDelete, { recursive: true, force: true });
  }

  // Clean up parent application directory if empty (never delete the workspace root itself)
  const parentAppDir = path.dirname(opDirToDelete);
  try {
    if (parentAppDir !== resolvedRoot && fs.existsSync(parentAppDir)) {
      const remaining = fs.readdirSync(parentAppDir);
      if (remaining.length === 0) {
        fs.rmdirSync(parentAppDir);
      }
    }
  } catch {}

  return {
    success: true,
    deletedPath: opDirToDelete
  };
}

const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;
const ZERO_SHA = '0000000000000000000000000000000000000000';

/**
 * Fetches an exact immutable Git commit into an isolated workspace and checks it out in detached-HEAD mode.
 * Strictly verifies that the checked-out HEAD SHA matches the requested commit SHA.
 *
 * @param {Object} application - Application record containing id, repo_url, and optional branch
 * @param {string} commitSha - Exact 40-character hexadecimal commit SHA
 * @param {Object} options - Options (workspaceRoot, timeout, authMode, etc.)
 * @returns {Promise<Object>} Snapshot metadata containing verified commitSha and workspacePath
 */
async function fetchCommit(application, commitSha, options = {}) {
  if (options.signal && options.signal.aborted) {
    throw new GitServiceError('Git operation was cancelled by caller.', 'OPERATION_CANCELLED');
  }

  if (!application || typeof application !== 'object') {
    throw new GitServiceError('Application object is required.', 'WORKSPACE_ERROR');
  }

  const { id: applicationId, repo_url, branch } = application;

  if (!applicationId || !UUID_REGEX.test(String(applicationId).trim())) {
    throw new GitServiceError('Invalid application ID format. Expected a standard UUID.', 'WORKSPACE_ERROR');
  }

  // Validate commit SHA format strictly
  if (!commitSha || typeof commitSha !== 'string') {
    throw new GitServiceError('Commit SHA is required and must be a string.', 'INVALID_COMMIT_SHA');
  }

  const cleanSha = commitSha.trim().toLowerCase();
  if (cleanSha === ZERO_SHA || !COMMIT_SHA_REGEX.test(cleanSha)) {
    throw new GitServiceError(`Invalid or zero commit SHA identifier "${commitSha}".`, 'INVALID_COMMIT_SHA');
  }

  const repoInfo = validateRepositoryUrl(repo_url, options);
  const normalizedUrl = repoInfo.normalizedUrl;
  const isTestFixture = repoInfo.isTestFixture;
  const targetBranch = branch ? validateBranch(branch) : 'main';

  let authMode = options.authMode;
  let effectiveOptions = { ...options };

  // If authMode is not explicitly provided, attempt to auto-resolve from verified database association
  if (!authMode && options.autoResolveAuth !== false && applicationId) {
    try {
      const githubRepoService = require('./githubRepositoryService');
      const resolved = githubRepoService.resolveApplicationCheckoutAuth(applicationId, options);
      if (resolved) {
        authMode = resolved.authMode;
        effectiveOptions = { ...effectiveOptions, ...resolved };
      }
    } catch (err) {
      if (err.name === 'GithubRepositoryError' && err.code !== 'APPLICATION_NOT_FOUND') {
        throw new GitServiceError(err.message, err.code, err.details);
      }
    }
  }

  authMode = authMode || 'public';
  if (authMode !== 'public' && authMode !== 'github-app') {
    throw new GitServiceError(`Unsupported authentication mode "${authMode}".`, 'UNSUPPORTED_AUTH_METHOD');
  }

  // Resolve and verify workspace root
  const workspaceRoot = getWorkspaceRoot(options.workspaceRoot);
  if (!fs.existsSync(workspaceRoot)) {
    try {
      fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new GitServiceError(`Failed to create workspace root: ${err.message}`, 'WORKSPACE_ERROR');
    }
  }

  const resolvedRoot = fs.realpathSync(workspaceRoot);
  const operationId = crypto.randomUUID();

  // Create isolated directories: <root>/<appId>/<opId>/source
  const appWorkspaceDir = path.join(resolvedRoot, applicationId);
  const opWorkspaceDir = path.join(appWorkspaceDir, operationId);
  const sourceDir = path.join(opWorkspaceDir, 'source');

  if (!sourceDir.startsWith(resolvedRoot + path.sep)) {
    throw new GitServiceError('Path traversal detected in workspace path calculation.', 'WORKSPACE_ACCESS_DENIED');
  }

  try {
    fs.mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    throw new GitServiceError(`Failed to create isolated workspace directory: ${err.message}`, 'WORKSPACE_ERROR');
  }

  const realSourceDir = fs.realpathSync(sourceDir);
  if (!realSourceDir.startsWith(resolvedRoot + path.sep)) {
    try { fs.rmSync(opWorkspaceDir, { recursive: true, force: true }); } catch {}
    throw new GitServiceError('Symlink-based workspace escape detected.', 'WORKSPACE_ACCESS_DENIED');
  }

  let broker = null;
  const extraEnv = options.extraEnv ? { ...options.extraEnv } : {};

  if (authMode === 'github-app') {
    const instId = effectiveOptions.installationId;
    if (!instId || !/^[1-9]\d*$/.test(String(instId).trim())) {
      throw new GitServiceError('Installation ID is required for GitHub App authenticated checkout.', 'GITHUB_APP_INVALID_ID');
    }

    if (effectiveOptions.repositoryName && String(effectiveOptions.repositoryName).trim().toLowerCase() !== repoInfo.repo.toLowerCase()) {
      throw new GitServiceError('Repository identity mismatch.', 'GITHUB_PERMISSION_DENIED');
    }

    if (!githubAppService.isGithubAppConfigured(effectiveOptions)) {
      throw new GitServiceError('GitHub App identity is not configured on this server.', 'GITHUB_APP_NOT_CONFIGURED');
    }

    let tokenResult;
    try {
      tokenResult = await githubAppService.getInstallationAccessToken(String(instId).trim(), {
        ...effectiveOptions,
        repositories: [repoInfo.repo],
        permissions: { contents: 'read' }
      });
    } catch (err) {
      if (err instanceof githubAppService.GithubAppError) {
        throw new GitServiceError(err.message, err.code, err.details);
      }
      throw new GitServiceError(`Failed to acquire GitHub installation token: ${err.message}`, 'GITHUB_AUTH_FAILED');
    }

    try {
      broker = await startCredentialBroker({
        token: tokenResult.token,
        operationId,
        expectedHost: isTestFixture ? 'localhost' : 'github.com',
        timeoutMs: options.timeout || 60000
      });
    } catch (err) {
      throw new GitServiceError(`Failed to start local credential broker: ${err.message}`, 'CREDENTIAL_BROKER_ERROR');
    }

    extraEnv.GIT_ASKPASS = process.execPath;
    extraEnv.KPANEL_ASKPASS_SOCKET = broker.socketPath;
    extraEnv.KPANEL_ASKPASS_NONCE = broker.nonce;
  }

  const extraConfig = isTestFixture ? ['-c', 'protocol.file.allow=always'] : ['-c', 'protocol.file.allow=never'];
  const askpassConfig = broker
    ? [
        '-c', `core.askPass=${process.execPath} "${ASKPASS_HELPER_PATH}"`,
        '-c', 'credential.helper='
      ]
    : [];

  const baseGitOptions = [
    '-c', 'core.hooksPath=/dev/null',
    '-c', 'submodule.recurse=false',
    '-c', 'filter.lfs.smudge=',
    '-c', 'filter.lfs.required=false',
    '-c', 'http.followRedirects=false',
    ...askpassConfig,
    ...extraConfig
  ];

  try {
    // 1. Initialize empty git repository in target directory
    await executeGitCommand([...baseGitOptions, 'init', '-q', realSourceDir], {
      timeout: 10000,
      signal: options.signal,
      extraEnv
    });

    // 2. Add remote origin
    const targetUrl = (repoInfo.isTestFixture && options.testFixtureUrl) ? options.testFixtureUrl : normalizedUrl;
    await executeGitCommand([...baseGitOptions, '-C', realSourceDir, 'remote', 'add', 'origin', targetUrl], {
      timeout: 10000,
      signal: options.signal,
      extraEnv
    });

    // 3. Fetch: Attempt exact commit fetch first
    let fetchSuccess = false;
    const fetchCommitResult = await executeGitCommand(
      [...baseGitOptions, '-C', realSourceDir, 'fetch', '--depth', '1', 'origin', cleanSha],
      { timeout: options.timeout || 60000, signal: options.signal, extraEnv }
    );

    if (fetchCommitResult.code === 0) {
      fetchSuccess = true;
    } else {
      // Fallback: If remote forbids direct SHA fetch, fetch branch depth 50 to look for commit
      const fetchBranchResult = await executeGitCommand(
        [...baseGitOptions, '-C', realSourceDir, 'fetch', '--depth', '50', 'origin', targetBranch],
        { timeout: options.timeout || 60000, signal: options.signal, extraEnv }
      );
      if (fetchBranchResult.code === 0) {
        fetchSuccess = true;
      }
    }

    if (!fetchSuccess) {
      throw new GitServiceError(`The requested commit "${cleanSha}" is unavailable in repository "${normalizedUrl}".`, 'GIT_COMMIT_UNAVAILABLE');
    }

    // 4. Verify the Git object exists and is a commit object
    const catResult = await executeGitCommand(
      [...baseGitOptions, '-C', realSourceDir, 'cat-file', '-e', `${cleanSha}^{commit}`],
      { timeout: 5000, signal: options.signal, extraEnv }
    );

    if (catResult.code !== 0) {
      throw new GitServiceError(`The requested commit "${cleanSha}" is unavailable in repository "${normalizedUrl}".`, 'GIT_COMMIT_UNAVAILABLE');
    }

    // 5. Check out exact commit in detached-HEAD mode
    const checkoutResult = await executeGitCommand(
      [...baseGitOptions, '-C', realSourceDir, 'checkout', '-q', '--detach', cleanSha],
      { timeout: 15000, signal: options.signal, extraEnv }
    );

    if (checkoutResult.code !== 0) {
      throw new GitServiceError(`Failed to checkout commit "${cleanSha}": ${checkoutResult.stderr}`, 'GIT_FETCH_FAILED');
    }

    // 6. Verify local checkout HEAD equals requested commitSha
    const revParseResult = await executeGitCommand(
      ['-C', realSourceDir, 'rev-parse', 'HEAD'],
      { timeout: 5000, signal: options.signal, extraEnv }
    );

    const verifiedSha = revParseResult.stdout.trim().toLowerCase();
    if (verifiedSha !== cleanSha) {
      throw new GitServiceError('Checked-out commit SHA does not match requested commit.', 'GIT_COMMIT_MISMATCH');
    }

    return {
      operationId,
      applicationId,
      workspacePath: realSourceDir,
      commitSha: verifiedSha,
      branch: targetBranch,
      repository: normalizedUrl,
      fetchedAt: new Date().toISOString()
    };
  } catch (err) {
    try {
      if (fs.existsSync(opWorkspaceDir)) {
        fs.rmSync(opWorkspaceDir, { recursive: true, force: true });
      }
    } catch {}
    throw err;
  } finally {
    if (broker) {
      broker.close();
    }
  }
}

module.exports = {
  validateRepositoryUrl,
  validateBranch,
  inspectRemoteBranch,
  fetchRepository,
  fetchCommit,
  cleanupWorkspace,
  getWorkspaceRoot,
  executeGitCommand,
  GitServiceError
};
