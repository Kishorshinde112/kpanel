#!/usr/bin/env node
/**
 * ==============================================================================
 * K-PANEL DISPOSABLE STAGING BUNDLE PACKAGER & VERIFIER (PHASE 4C3D6)
 * ==============================================================================
 * Creates a minimal, reproducible, checksum-verified transfer package for the
 * disposable staging smoke test.
 *
 * STRICT INVARIANTS:
 * 1. Packages ONLY approved disposable staging smoke files (8 files).
 * 2. Strictly excludes .git, node_modules, credentials, database files, and secrets.
 * 3. Enforces zero unexpected symlinks, zero absolute paths, zero path traversals.
 * 4. Generates a cryptographic SHA-256 manifest.
 * 5. Verifies archive extraction into an isolated target directory.
 * ==============================================================================
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

const APPROVED_BUNDLE_FILES = Object.freeze([
  'docker-compose.yml',
  '.env.example',
  'README.md',
  'RUNBOOK.md',
  path.join('candidate', 'Dockerfile'),
  path.join('candidate', 'server.js'),
  path.join('ingress', 'Dockerfile'),
  path.join('ingress', 'nginx.conf')
]);

const PROHIBITED_FILE_PATTERNS = Object.freeze([
  /^\.env(?!\.example$)/,
  /\.git/,
  /node_modules/,
  /\.sqlite/,
  /\.db$/,
  /id_rsa/,
  /\.pem$/,
  /\.key$/,
  /credentials/i,
  /secret/i
]);

class BundlePackagingError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'BundlePackagingError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Computes SHA-256 hash of a file.
 */
function computeFileSha256(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new BundlePackagingError(`File not found for checksum: ${filePath}`, 'FILE_NOT_FOUND');
  }
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

/**
 * Recursively scans directory to audit files against approved whitelist.
 */
function auditSourceDirectory(sourceDir) {
  if (!fs.existsSync(sourceDir)) {
    throw new BundlePackagingError(`Source directory does not exist: ${sourceDir}`, 'DIR_NOT_FOUND');
  }

  const foundFiles = [];

  function walk(currentDir) {
    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      const relPath = path.relative(sourceDir, fullPath);

      // Check for symlinks
      if (entry.isSymbolicLink()) {
        throw new BundlePackagingError(
          `Unexpected symbolic link detected in staging bundle: ${relPath}. Symbolic links are strictly prohibited in transfer bundle.`,
          'UNEXPECTED_SYMLINK_DETECTED',
          { path: relPath }
        );
      }

      // Check against prohibited patterns
      for (const pattern of PROHIBITED_FILE_PATTERNS) {
        if (pattern.test(entry.name) || pattern.test(relPath)) {
          throw new BundlePackagingError(
            `Prohibited file or credential detected in staging bundle: ${relPath}`,
            'PROHIBITED_FILE_DETECTED',
            { path: relPath }
          );
        }
      }

      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        foundFiles.push(relPath);
      }
    }
  }

  walk(sourceDir);

  // Normalize found paths for cross-platform comparison
  const normalizedFound = foundFiles.map((p) => p.replace(/\\/g, '/')).sort();
  const normalizedApproved = APPROVED_BUNDLE_FILES.map((p) => p.replace(/\\/g, '/')).sort();

  for (const found of normalizedFound) {
    if (!normalizedApproved.includes(found)) {
      throw new BundlePackagingError(
        `Unapproved extra file detected in staging bundle: ${found}. Only approved staging smoke files may be packaged.`,
        'UNAPPROVED_FILE_DETECTED',
        { path: found }
      );
    }
  }

  for (const approved of normalizedApproved) {
    if (!normalizedFound.includes(approved)) {
      throw new BundlePackagingError(
        `Required staging file missing from bundle: ${approved}`,
        'REQUIRED_FILE_MISSING',
        { path: approved }
      );
    }
  }

  return {
    valid: true,
    fileCount: foundFiles.length,
    files: normalizedFound
  };
}

/**
 * Creates the transfer tarball and SHA-256 checksum file.
 *
 * @param {string} sourceDir - Absolute path to deploy/staging-smoke
 * @param {string} outputTarPath - Target archive path
 * @param {string} [outputShaPath] - Target sha256 file path
 * @returns {Object} Manifest with file list, checksum, and archive size
 */
function createStagingSmokeBundle(sourceDir, outputTarPath, outputShaPath) {
  // 1. Audit source files
  const audit = auditSourceDirectory(sourceDir);

  const parentDir = path.dirname(sourceDir);
  const baseName = path.basename(sourceDir); // 'staging-smoke'

  // Ensure output directory exists
  const outDir = path.dirname(outputTarPath);
  if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
  }

  // 2. Package tar.gz using deterministic tar parameters
  try {
    execFileSync('tar', [
      '--sort=name',
      '--owner=root:0',
      '--group=root:0',
      '--mtime=2026-10-23 00:00:00Z',
      '-czf',
      outputTarPath,
      '-C',
      parentDir,
      baseName
    ]);
  } catch (tarErr) {
    throw new BundlePackagingError(`Failed to create tarball: ${tarErr.message}`, 'TAR_CREATION_FAILED');
  }

  // 3. Compute SHA-256
  const sha256 = computeFileSha256(outputTarPath);
  const tarBasename = path.basename(outputTarPath);
  const shaManifest = `${sha256}  ${tarBasename}\n`;

  const shaPath = outputShaPath || `${outputTarPath}.sha256`;
  fs.writeFileSync(shaPath, shaManifest, 'utf8');

  const stats = fs.statSync(outputTarPath);

  return {
    success: true,
    archivePath: outputTarPath,
    archiveBasename: tarBasename,
    sha256Path: shaPath,
    sha256,
    sizeBytes: stats.size,
    auditedFiles: audit.files,
    fileCount: audit.fileCount
  };
}

/**
 * Inspects tarball contents without extracting to verify paths and safety.
 *
 * @param {string} archivePath - Path to tar.gz file
 * @returns {Array<string>} List of entries inside the archive
 */
function inspectArchiveContents(archivePath) {
  if (!fs.existsSync(archivePath)) {
    throw new BundlePackagingError(`Archive not found: ${archivePath}`, 'ARCHIVE_NOT_FOUND');
  }

  const stdout = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf8' });
  const entries = stdout.trim().split('\n').filter(Boolean);

  for (const entry of entries) {
    // Check for absolute paths
    if (entry.startsWith('/') || /^[a-zA-Z]:/.test(entry)) {
      throw new BundlePackagingError(`Absolute path detected in archive: ${entry}`, 'ABSOLUTE_PATH_DETECTED');
    }
    // Check for directory traversal
    if (entry.includes('..') || entry.includes('../') || entry.includes('..\\')) {
      throw new BundlePackagingError(`Path traversal detected in archive: ${entry}`, 'PATH_TRAVERSAL_DETECTED');
    }
  }

  return entries;
}

/**
 * Verifies archive integrity and tests extraction in an isolated temporary directory.
 *
 * @param {string} archivePath - Path to tar.gz file
 * @param {string} sha256Path - Path to sha256 file
 * @returns {Object} Verification report
 */
function verifyTransferBundle(archivePath, sha256Path) {
  if (!fs.existsSync(archivePath)) {
    throw new BundlePackagingError(`Archive not found: ${archivePath}`, 'ARCHIVE_NOT_FOUND');
  }
  if (!fs.existsSync(sha256Path)) {
    throw new BundlePackagingError(`SHA-256 manifest not found: ${sha256Path}`, 'SHA_NOT_FOUND');
  }

  // 1. Verify SHA-256
  const actualSha256 = computeFileSha256(archivePath);
  const expectedContent = fs.readFileSync(sha256Path, 'utf8').trim();
  const expectedSha256 = expectedContent.split(/\s+/)[0];

  if (actualSha256.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new BundlePackagingError(
      `Checksum mismatch! Expected: ${expectedSha256}, Actual: ${actualSha256}`,
      'CHECKSUM_MISMATCH',
      { expected: expectedSha256, actual: actualSha256 }
    );
  }

  // 2. Inspect archive paths
  const entries = inspectArchiveContents(archivePath);

  // 3. Test extraction into isolated temporary directory
  const tempExtractDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-smoke-extract-verify-'));

  try {
    execFileSync('tar', ['-xzf', archivePath, '-C', tempExtractDir]);

    const extractedSmokeDir = path.join(tempExtractDir, 'staging-smoke');
    if (!fs.existsSync(extractedSmokeDir)) {
      throw new BundlePackagingError('Extracted root staging-smoke directory missing', 'EXTRACTION_VERIFICATION_FAILED');
    }

    // Verify all 8 files exist in extracted target
    for (const relFile of APPROVED_BUNDLE_FILES) {
      const targetFile = path.join(extractedSmokeDir, relFile);
      if (!fs.existsSync(targetFile)) {
        throw new BundlePackagingError(`Missing extracted file: ${relFile}`, 'EXTRACTION_VERIFICATION_FAILED');
      }
    }

    return {
      verified: true,
      sha256: actualSha256,
      entriesCount: entries.length,
      entries,
      extractionVerified: true
    };
  } finally {
    // Clean up temporary extraction directory
    try {
      fs.rmSync(tempExtractDir, { recursive: true, force: true });
    } catch (_) {
      // Ignore temp cleanup errors
    }
  }
}

/**
 * Verifies that the sha256 manifest references a bare filename
 * and that the target archive exists in the designated working directory.
 *
 * @param {string} manifestPath - Path to .sha256 file
 * @param {string} workingDir - Directory where sha256sum will be executed
 * @returns {Object} Manifest and working directory check report
 */
function verifyManifestWorkingDirectory(manifestPath, workingDir) {
  if (!fs.existsSync(manifestPath)) {
    throw new BundlePackagingError(`Manifest not found: ${manifestPath}`, 'MANIFEST_NOT_FOUND');
  }
  const manifestContent = fs.readFileSync(manifestPath, 'utf8').trim();
  const parts = manifestContent.split(/\s+/);
  if (parts.length < 2) {
    throw new BundlePackagingError('Invalid sha256 manifest format.', 'INVALID_MANIFEST_FORMAT');
  }
  const hash = parts[0];
  const filename = parts.slice(1).join(' ').trim();

  const isBareFilename = !filename.includes('/') && !filename.includes('\\');
  const expectedPath = path.resolve(workingDir, filename);
  const existsInWorkingDir = fs.existsSync(expectedPath);

  return {
    valid: existsInWorkingDir,
    hash,
    filename,
    isBareFilename,
    workingDir,
    resolvedArchivePath: expectedPath,
    existsInWorkingDir
  };
}

// CLI Execution Entry Point
if (require.main === module) {
  const sourceDir = path.resolve(__dirname, '..', '..', 'deploy', 'staging-smoke');
  const targetTar = path.resolve(__dirname, '..', '..', 'deploy', 'kpanel-staging-smoke-bundle.tar.gz');
  const targetSha = path.resolve(__dirname, '..', '..', 'deploy', 'kpanel-staging-smoke-bundle.tar.gz.sha256');

  console.log(`[packageStagingSmokeBundle] Packaging disposable staging bundle from: ${sourceDir}`);
  const result = createStagingSmokeBundle(sourceDir, targetTar, targetSha);
  console.log(`[packageStagingSmokeBundle] Archive created: ${result.archivePath} (${result.sizeBytes} bytes)`);
  console.log(`[packageStagingSmokeBundle] SHA-256: ${result.sha256}`);

  console.log(`[packageStagingSmokeBundle] Verifying archive integrity and testing extraction...`);
  const verify = verifyTransferBundle(targetTar, targetSha);
  console.log(`[packageStagingSmokeBundle] VERIFICATION SUCCESS: ${verify.entriesCount} entries verified with 100% integrity.`);
}

module.exports = {
  APPROVED_BUNDLE_FILES,
  PROHIBITED_FILE_PATTERNS,
  auditSourceDirectory,
  createStagingSmokeBundle,
  computeFileSha256,
  inspectArchiveContents,
  verifyTransferBundle,
  verifyManifestWorkingDirectory,
  BundlePackagingError
};
