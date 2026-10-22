const fs = require('fs');
const path = require('path');
const os = require('os');

class BuildLogError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'BuildLogError';
    this.code = code;
    this.details = details;
  }
}

// Strict UUID regex for deployment validation
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DEFAULT_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB total size limit
const DEFAULT_LINE_MAX_BYTES = 16 * 1024; // 16 KB per line/chunk limit

/**
 * Resolves the root directory for build logs.
 * Defaults to KPANEL_BUILD_LOG_ROOT or backend/data/logs/builds.
 */
function getBuildLogRoot(customRoot) {
  if (customRoot && typeof customRoot === 'string' && customRoot.trim().length > 0) {
    return path.resolve(customRoot.trim());
  }
  if (process.env.KPANEL_BUILD_LOG_ROOT && process.env.KPANEL_BUILD_LOG_ROOT.trim().length > 0) {
    return path.resolve(process.env.KPANEL_BUILD_LOG_ROOT.trim());
  }
  return path.resolve(path.join(__dirname, '..', 'data', 'logs', 'builds'));
}

/**
 * Validates deployment ID format.
 */
function validateDeploymentId(deploymentId) {
  if (!deploymentId || typeof deploymentId !== 'string' || !UUID_REGEX.test(deploymentId.trim())) {
    throw new BuildLogError(
      `Invalid deployment ID "${deploymentId}". Expected valid UUID.`,
      'INVALID_DEPLOYMENT_ID'
    );
  }
  return deploymentId.trim().toLowerCase();
}

/**
 * Resolves and verifies the target build log file path for a deployment.
 * Enforces directory creation with 0o700 permissions and prevents directory traversal.
 */
function resolveLogPath(deploymentId, customRoot) {
  const validId = validateDeploymentId(deploymentId);
  const logRoot = getBuildLogRoot(customRoot);

  if (!fs.existsSync(logRoot)) {
    try {
      fs.mkdirSync(logRoot, { recursive: true, mode: 0o700 });
      try {
        fs.chmodSync(logRoot, 0o700);
      } catch {}
    } catch (err) {
      throw new BuildLogError(
        `Failed to create build log root directory: ${err.message}`,
        'LOG_DIRECTORY_ERROR'
      );
    }
  }

  const realLogRoot = fs.realpathSync(logRoot);
  const targetFile = path.join(realLogRoot, `${validId}.log`);

  // Path traversal guard
  if (!targetFile.startsWith(realLogRoot + path.sep)) {
    throw new BuildLogError(
      'Path traversal detected in build log path calculation.',
      'LOG_SECURITY_ERROR'
    );
  }

  return {
    logRoot: realLogRoot,
    logPath: targetFile
  };
}

/**
 * Persistent Build Logger stream handler.
 * Handles incremental writing, bounding, symlink rejection, and graceful closure.
 */
class BuildLogger {
  constructor(logPath, options = {}) {
    this.logPath = logPath;
    this.maxBytes = options.maxLogBytes || DEFAULT_LOG_MAX_BYTES;
    this.maxLineBytes = options.maxLineBytes || DEFAULT_LINE_MAX_BYTES;
    this.bytesWritten = 0;
    this.isTruncated = false;
    this.closed = false;
    this.fd = null;

    // Check if target file already exists and is a symlink
    if (fs.existsSync(logPath)) {
      const stat = fs.lstatSync(logPath);
      if (stat.isSymbolicLink()) {
        throw new BuildLogError(
          'Build log path must not be a symbolic link.',
          'LOG_SECURITY_ERROR'
        );
      }
      if (options.allowOverwrite !== true) {
        throw new BuildLogError(
          `Build log already exists for deployment at "${logPath}". Overwriting another deployment log is forbidden.`,
          'LOG_ALREADY_EXISTS'
        );
      }
    }

    // Open file exclusively with 0o600 permissions
    const openFlag = options.allowOverwrite ? 'w' : 'wx';
    try {
      this.fd = fs.openSync(logPath, openFlag, 0o600);
      try {
        fs.chmodSync(logPath, 0o600);
      } catch {}
    } catch (err) {
      if (err.code === 'EEXIST') {
        throw new BuildLogError(
          `Build log already exists for deployment at "${logPath}". Overwriting is forbidden.`,
          'LOG_ALREADY_EXISTS'
        );
      }
      throw new BuildLogError(
        `Failed to open build log file: ${err.message}`,
        'LOG_WRITE_ERROR'
      );
    }
  }

  /**
   * Appends raw chunk (Buffer or string) incrementally to the log file.
   * Enforces total size limits and individual chunk bounding.
   */
  write(data) {
    if (this.closed || this.isTruncated || !data) return;

    let buffer = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');

    // Bound single chunk/line if oversized
    if (buffer.length > this.maxLineBytes) {
      const truncatedChunk = buffer.subarray(0, this.maxLineBytes);
      const marker = Buffer.from('\n[LINE TRUNCATED: EXCEEDED MAXIMUM LINE SIZE]\n', 'utf8');
      buffer = Buffer.concat([truncatedChunk, marker]);
    }

    // Check if total size limit reached
    if (this.bytesWritten + buffer.length > this.maxBytes) {
      const allowed = Math.max(0, this.maxBytes - this.bytesWritten);
      if (allowed > 0) {
        try {
          fs.writeSync(this.fd, buffer, 0, allowed);
          this.bytesWritten += allowed;
        } catch {}
      }
      const truncationMarker = Buffer.from('\n[LOG TRUNCATED: MAXIMUM SIZE EXCEEDED]\n', 'utf8');
      try {
        fs.writeSync(this.fd, truncationMarker);
        this.bytesWritten += truncationMarker.length;
      } catch {}
      this.isTruncated = true;
      return;
    }

    try {
      fs.writeSync(this.fd, buffer);
      this.bytesWritten += buffer.length;
    } catch (err) {
      throw new BuildLogError(`Failed to write to build log: ${err.message}`, 'LOG_WRITE_ERROR');
    }
  }

  /**
   * Writes a formatted operational marker line into the log.
   */
  writeMarker(marker) {
    if (this.closed) return;
    const line = `\n--- ${marker} ---\n`;
    this.write(line);
  }

  /**
   * Flushes and safely closes the file descriptor.
   */
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.fsyncSync(this.fd);
      } catch {}
      try {
        fs.closeSync(this.fd);
      } catch {}
      this.fd = null;
    }
  }
}

/**
 * Creates and initializes an active BuildLogger instance for a deployment.
 */
function createBuildLogger(deploymentId, options = {}) {
  const { logPath } = resolveLogPath(deploymentId, options.logRoot);
  return new BuildLogger(logPath, options);
}

/**
 * Reads persistent build log for a deployment.
 */
function readBuildLog(deploymentId, options = {}) {
  const validId = validateDeploymentId(deploymentId);
  const logRoot = getBuildLogRoot(options.logRoot);
  const logPath = path.join(logRoot, `${validId}.log`);

  if (!fs.existsSync(logPath)) {
    throw new BuildLogError(
      `Build log for deployment "${validId}" was not found.`,
      'LOG_NOT_FOUND'
    );
  }

  const stat = fs.lstatSync(logPath);
  if (stat.isSymbolicLink()) {
    throw new BuildLogError(
      'Build log file cannot be a symbolic link.',
      'LOG_SECURITY_ERROR'
    );
  }

  const maxReadBytes = options.maxReadBytes || DEFAULT_LOG_MAX_BYTES;
  const fd = fs.openSync(logPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(stat.size, maxReadBytes));
    const bytesRead = fs.readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

module.exports = {
  BuildLogError,
  BuildLogger,
  createBuildLogger,
  resolveLogPath,
  readBuildLog,
  getBuildLogRoot,
  validateDeploymentId,
  DEFAULT_LOG_MAX_BYTES,
  DEFAULT_LINE_MAX_BYTES
};
