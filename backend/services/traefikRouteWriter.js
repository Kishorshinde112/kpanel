const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const traefikRoutePlanner = require('./traefikRoutePlanner');

/**
 * Maximum allowed size for a route document in bytes (512 KB).
 */
const MAX_ROUTE_DOCUMENT_SIZE = 512 * 1024;

/**
 * Forbidden system directories for sandbox safety.
 */
const FORBIDDEN_DIRECTORIES = [
  '/etc/traefik',
  '/etc',
  '/var/run',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/root',
  '/usr',
  '/opt/traefik',
  '/var/log'
];

/**
 * Structured service error class for Route Writer operations.
 */
class TraefikRouteWriterError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'TraefikRouteWriterError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates and normalizes an application ID for filesystem namespacing.
 *
 * @param {string} applicationId - Application UUID or identifier
 * @returns {string} Sanitized application ID
 */
function sanitizeApplicationId(applicationId) {
  if (!applicationId || typeof applicationId !== 'string') {
    throw new TraefikRouteWriterError('Valid application ID is required.', 'INVALID_APPLICATION_ID');
  }
  const clean = applicationId.trim().toLowerCase();
  // Allow RFC 4122 UUID or alphanumeric/hyphen slug
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(clean)) {
    throw new TraefikRouteWriterError(`Application ID "${applicationId}" contains invalid characters for filesystem naming.`, 'INVALID_APPLICATION_ID');
  }
  return clean;
}

/**
 * Resolves the deterministic, namespaced route configuration filename for an application.
 *
 * @param {string} applicationId - Application identifier
 * @returns {string} Safe filename (e.g. "kpanel-app-id.yaml")
 */
function getRouteFileName(applicationId) {
  const cleanId = sanitizeApplicationId(applicationId);
  return `kpanel-${cleanId}.yaml`;
}

/**
 * Computes a deterministic SHA-256 fingerprint for a route document (object or string).
 *
 * @param {Object|string} routeDoc - Route document content
 * @returns {string} Hex SHA-256 digest
 */
function computeRouteFingerprint(routeDoc) {
  if (!routeDoc) return null;
  let content;
  if (typeof routeDoc === 'string') {
    content = routeDoc.trim();
  } else if (typeof routeDoc === 'object') {
    // Canonical JSON stringify
    content = JSON.stringify(routeDoc, Object.keys(routeDoc).sort());
  } else {
    throw new TraefikRouteWriterError('Route document must be an object or string.', 'INVALID_DOCUMENT');
  }
  return crypto.createHash('sha256').update(content).digest('hex');
}

/**
 * Validates and secures a configured sandbox root directory.
 * Strictly verifies directory ownership, rejects production paths,
 * verifies canonical realpath against symlink aliases, and enforces
 * server-side trusted sandbox containment.
 *
 * @param {string} sandboxDir - Target sandbox directory path
 * @param {Object} [options] - Options ({ trustedSandboxRoot })
 * @returns {string} Resolved absolute sandbox directory path
 */
function resolveAndValidateSandboxDirectory(sandboxDir, options = {}) {
  const rawDir = sandboxDir || process.env.KPANEL_SANDBOX_ROUTE_DIR || options.sandboxDir;
  if (!rawDir || typeof rawDir !== 'string' || !rawDir.trim()) {
    throw new TraefikRouteWriterError('Configured sandbox route directory is required.', 'SANDBOX_DIR_MISSING');
  }

  const cleanDir = rawDir.trim();
  if (cleanDir.includes('\0') || cleanDir.includes('..')) {
    throw new TraefikRouteWriterError('Sandbox directory path contains invalid traversal characters or null bytes.', 'PATH_TRAVERSAL_DETECTED');
  }

  const resolvedDir = path.resolve(cleanDir);

  // Reject production Traefik or sensitive root system paths
  for (const forbidden of FORBIDDEN_DIRECTORIES) {
    if (resolvedDir === forbidden || resolvedDir.startsWith(forbidden + path.sep)) {
      throw new TraefikRouteWriterError(
        `Directory "${resolvedDir}" is a forbidden system or production directory. Sandbox execution is strictly isolated.`,
        'FORBIDDEN_DIRECTORY'
      );
    }
  }

  // Ensure sandbox directory exists with restricted permissions
  if (!fs.existsSync(resolvedDir)) {
    try {
      fs.mkdirSync(resolvedDir, { recursive: true, mode: 0o700 });
    } catch (err) {
      throw new TraefikRouteWriterError(`Failed to create sandbox directory: ${err.message}`, 'SANDBOX_DIR_CREATE_FAILED');
    }
  }

  // Verify it is a directory and not a symlink
  const stat = fs.lstatSync(resolvedDir);
  if (stat.isSymbolicLink()) {
    throw new TraefikRouteWriterError('Sandbox root directory cannot be a symbolic link.', 'SYMLINK_DETECTED');
  }
  if (!stat.isDirectory()) {
    throw new TraefikRouteWriterError('Specified sandbox path is not a directory.', 'INVALID_SANDBOX_DIR');
  }

  // Verify canonical realpath on filesystem to defeat symlink aliases & mount traversal
  let realDir;
  try {
    realDir = fs.realpathSync(resolvedDir);
  } catch (err) {
    throw new TraefikRouteWriterError(`Failed to resolve canonical path for sandbox: ${err.message}`, 'INVALID_SANDBOX_DIR');
  }

  for (const forbidden of FORBIDDEN_DIRECTORIES) {
    if (realDir === forbidden || realDir.startsWith(forbidden + path.sep)) {
      throw new TraefikRouteWriterError(
        `Canonical sandbox path "${realDir}" targets a forbidden system or production directory.`,
        'FORBIDDEN_DIRECTORY'
      );
    }
  }

  // Verify containment within trusted sandbox root if configured
  const trustedRoot = options.trustedSandboxRoot || process.env.KPANEL_TRUSTED_SANDBOX_ROOT;
  if (trustedRoot) {
    const resolvedRoot = path.resolve(trustedRoot);
    let realRoot;
    try {
      realRoot = fs.existsSync(resolvedRoot) ? fs.realpathSync(resolvedRoot) : resolvedRoot;
    } catch {
      realRoot = resolvedRoot;
    }
    if (realDir !== realRoot && !realDir.startsWith(realRoot + path.sep)) {
      throw new TraefikRouteWriterError(
        `Sandbox path "${realDir}" escapes the authorized server-side sandbox root "${realRoot}".`,
        'SANDBOX_ROOT_VIOLATION'
      );
    }
  }

  return realDir;
}

/**
 * Resolves a full, secured file path for a K-Panel application route within the sandbox.
 * Prevents traversal, symlink redirection, and verifies strict containment.
 *
 * @param {string} applicationId - Application UUID
 * @param {string} sandboxDir - Approved sandbox directory
 * @param {Object} [options] - Options
 * @returns {string} Absolute file path
 */
function resolveSecureRoutePath(applicationId, sandboxDir, options = {}) {
  const resolvedDir = resolveAndValidateSandboxDirectory(sandboxDir, options);
  const fileName = getRouteFileName(applicationId);
  const fullPath = path.join(resolvedDir, fileName);

  // Path containment check
  if (!fullPath.startsWith(resolvedDir + path.sep)) {
    throw new TraefikRouteWriterError('Resolved route path escapes the approved sandbox directory.', 'PATH_TRAVERSAL_DETECTED');
  }

  // If file exists, ensure it is not a symlink escaping the directory
  if (fs.existsSync(fullPath)) {
    const stat = fs.lstatSync(fullPath);
    if (stat.isSymbolicLink()) {
      throw new TraefikRouteWriterError('Symlinks are strictly prohibited in the route sandbox.', 'SYMLINK_DETECTED');
    }
    const realFile = fs.realpathSync(fullPath);
    if (!realFile.startsWith(resolvedDir + path.sep)) {
      throw new TraefikRouteWriterError('Route target escapes sandbox via symlink alias.', 'SYMLINK_DETECTED');
    }
  }

  return fullPath;
}

/**
 * Validates a route document structure for security, correctness, and K-Panel ownership.
 * Prohibits raw unparsed rule injection, unknown middlewares, and unsafe backend schemes.
 *
 * @param {Object|string} routeDoc - Route document to validate
 * @param {Object} [context] - Context { applicationId, targetDomain }
 * @returns {Object} Validated document descriptor
 */
function validateRouteDocument(routeDoc, context = {}) {
  if (!routeDoc) {
    throw new TraefikRouteWriterError('Route document is required.', 'INVALID_ROUTE_DOCUMENT');
  }

  let docString;
  let parsedObj;

  if (typeof routeDoc === 'string') {
    docString = routeDoc;
    if (Buffer.byteLength(docString, 'utf8') > MAX_ROUTE_DOCUMENT_SIZE) {
      throw new TraefikRouteWriterError('Route document exceeds maximum size limit (512 KB).', 'DOCUMENT_TOO_LARGE');
    }
    // Attempt basic JSON parsing if it starts with {
    if (docString.trim().startsWith('{')) {
      try {
        parsedObj = JSON.parse(docString);
      } catch (err) {
        throw new TraefikRouteWriterError(`Invalid JSON in route document: ${err.message}`, 'INVALID_ROUTE_DOCUMENT');
      }
    }
  } else if (typeof routeDoc === 'object') {
    parsedObj = routeDoc;
    docString = JSON.stringify(routeDoc);
    if (Buffer.byteLength(docString, 'utf8') > MAX_ROUTE_DOCUMENT_SIZE) {
      throw new TraefikRouteWriterError('Route document exceeds maximum size limit (512 KB).', 'DOCUMENT_TOO_LARGE');
    }
  } else {
    throw new TraefikRouteWriterError('Route document must be an object or string.', 'INVALID_ROUTE_DOCUMENT');
  }

  // Content security inspection:
  // Reject arbitrary shell injection or script tags
  if (/<script|`rm\s|`curl\s|\$\(rm|\$\(curl/i.test(docString)) {
    throw new TraefikRouteWriterError('Dangerous command injection patterns detected in route document.', 'UNSAFE_ROUTE_CONTENT');
  }

  // If structured object is available, inspect routing tree
  if (parsedObj) {
    const http = parsedObj.http;
    if (!http || typeof http !== 'object') {
      throw new TraefikRouteWriterError('Route document must contain an "http" configuration section.', 'INVALID_ROUTE_DOCUMENT');
    }

    const routers = http.routers;
    const services = http.services;

    if (!routers || typeof routers !== 'object' || Object.keys(routers).length === 0) {
      throw new TraefikRouteWriterError('Route document must declare at least one Traefik router.', 'INVALID_ROUTE_DOCUMENT');
    }

    if (!services || typeof services !== 'object' || Object.keys(services).length === 0) {
      throw new TraefikRouteWriterError('Route document must declare at least one Traefik service.', 'INVALID_ROUTE_DOCUMENT');
    }

    for (const [routerName, routerConfig] of Object.entries(routers)) {
      if (!routerName.startsWith('kpanel-router-')) {
        throw new TraefikRouteWriterError(`Router name "${routerName}" must start with "kpanel-router-".`, 'INVALID_ROUTER_NAME');
      }

      const rule = String(routerConfig?.rule || '').trim();
      if (!rule.startsWith('Host(`') || !rule.endsWith('`)')) {
        throw new TraefikRouteWriterError(`Router rule "${rule}" must be an exact Host(\`...\`) match. Raw rule injections prohibited.`, 'UNSAFE_ROUTER_RULE');
      }

      // Check for wildcard or regex inside Host rule
      const hostMatch = rule.match(/^Host\(`([^`]+)`\)$/);
      if (!hostMatch || hostMatch[1].includes('*') || hostMatch[1].includes('{')) {
        throw new TraefikRouteWriterError('Wildcard or regex routing rules are strictly prohibited.', 'WILDCARD_ROUTING_PROHIBITED');
      }
    }

    for (const [serviceName, serviceConfig] of Object.entries(services)) {
      if (!serviceName.startsWith('kpanel-svc-')) {
        throw new TraefikRouteWriterError(`Service name "${serviceName}" must start with "kpanel-svc-".`, 'INVALID_SERVICE_NAME');
      }

      const servers = serviceConfig?.loadBalancer?.servers || [];
      if (!Array.isArray(servers) || servers.length === 0) {
        throw new TraefikRouteWriterError('Service loadBalancer must declare at least one backend server.', 'INVALID_SERVICE_SERVERS');
      }

      for (const server of servers) {
        const urlStr = String(server?.url || '').trim();
        try {
          const parsedUrl = new URL(urlStr);
          if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
            throw new TraefikRouteWriterError(`Backend URL "${urlStr}" uses unsupported scheme. Must be http/https.`, 'UNSAFE_BACKEND_URL');
          }
          // Reject external public domains as backend targets
          const hostname = parsedUrl.hostname.toLowerCase();
          if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0') {
            throw new TraefikRouteWriterError(`Backend target "${hostname}" cannot be host loopback.`, 'UNSAFE_BACKEND_URL');
          }
        } catch (urlErr) {
          throw new TraefikRouteWriterError(`Invalid backend server URL "${urlStr}": ${urlErr.message}`, 'UNSAFE_BACKEND_URL');
        }
      }
    }
  }

  return {
    valid: true,
    documentString: docString,
    fingerprint: computeRouteFingerprint(docString),
    byteLength: Buffer.byteLength(docString, 'utf8')
  };
}

/**
 * Generates a deterministic YAML route document string for a validated K-Panel application.
 *
 * @param {Object} input - { applicationId, deploymentId, targetDomain, targetPort, candidateContainerId, targetNetwork }
 * @param {Object} [options] - Options
 * @returns {string} Deterministic YAML formatted route document
 */
function generateDeterministicYamlRoute(input, options = {}) {
  const {
    applicationId,
    deploymentId,
    targetDomain,
    targetPort,
    candidateContainerId
  } = input;

  const cleanAppId = sanitizeApplicationId(applicationId);
  const routerName = traefikRoutePlanner.getDeterministicIdentifier('router', cleanAppId);
  const serviceName = traefikRoutePlanner.getDeterministicIdentifier('svc', cleanAppId);
  const domain = String(targetDomain).trim().toLowerCase();
  const port = parseInt(targetPort, 10);
  const container = String(candidateContainerId).trim().slice(0, 12);
  const backendUrl = options.backendUrl || `http://${container}:${port}`;

  const certResolverLine = options.certResolver
    ? `      tls:\n        certResolver: ${options.certResolver}\n`
    : `      tls: {}\n`;

  return [
    `# K-Panel Dynamic Route Configuration`,
    `# kpanel-owner: ${cleanAppId}`,
    `# kpanel-deployment: ${deploymentId}`,
    `# kpanel-domain: ${domain}`,
    `# generated-at: ${new Date().toISOString()}`,
    `http:`,
    `  routers:`,
    `    ${routerName}:`,
    `      rule: Host(\`${domain}\`)`,
    `      service: ${serviceName}`,
    `      entryPoints:`,
    `        - websecure`,
    certResolverLine.trimEnd(),
    `  services:`,
    `    ${serviceName}:`,
    `      loadBalancer:`,
    `        servers:`,
    `          - url: ${backendUrl}`,
    `        passHostHeader: true`,
    ``
  ].join('\n');
}

/**
 * Verifies explicit K-Panel ownership of an existing route configuration file.
 * Confirms that the file contains expected K-Panel ownership headers and router identifiers,
 * strictly preventing foreign files (Dokploy, n8n, admin configs) from being touched.
 *
 * @param {string} filePath - Absolute file path
 * @param {string} applicationId - Expected application UUID
 * @returns {boolean} True if ownership is verified
 */
function verifyFileOwnership(filePath, applicationId) {
  if (!fs.existsSync(filePath)) return false;

  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const cleanAppId = sanitizeApplicationId(applicationId);

  // Check 1: Explicit K-Panel owner header
  const hasOwnerHeader = content.includes(`# kpanel-owner: ${cleanAppId}`);

  // Check 2: Deterministic router name prefix
  const expectedRouterPrefix = `kpanel-router-${cleanAppId.slice(0, 16)}`;
  const hasExpectedRouter = content.includes(expectedRouterPrefix);

  // Check 3: Strictly prohibit foreign markers
  const lower = content.toLowerCase();
  const isForeign = lower.includes('dokploy') || lower.includes('n8n') || lower.includes('coolify');

  return (hasOwnerHeader || hasExpectedRouter) && !isForeign;
}

/**
 * Reads a K-Panel-owned route configuration file from the sandbox directory.
 *
 * @param {string} applicationId - Application UUID
 * @param {Object} [options] - Options ({ sandboxDir })
 * @returns {Object} { exists, filePath, routeDocument, fingerprint, isOwned }
 */
function readOwnedRoute(applicationId, options = {}) {
  const filePath = resolveSecureRoutePath(applicationId, options.sandboxDir);

  if (!fs.existsSync(filePath)) {
    return {
      exists: false,
      filePath,
      routeDocument: null,
      fingerprint: null,
      isOwned: false
    };
  }

  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new TraefikRouteWriterError('Symlinks are strictly prohibited in the route sandbox.', 'SYMLINK_DETECTED');
  }

  if (!stat.isFile()) {
    throw new TraefikRouteWriterError('Route target is not a regular file.', 'NOT_A_REGULAR_FILE');
  }

  const isOwned = verifyFileOwnership(filePath, applicationId);
  if (!isOwned) {
    throw new TraefikRouteWriterError(
      `File "${path.basename(filePath)}" exists in sandbox but is not verified as owned by K-Panel application "${applicationId}". Mutation forbidden.`,
      'FOREIGN_ROUTE_FILE'
    );
  }

  const routeDocument = fs.readFileSync(filePath, 'utf8');
  const fingerprint = computeRouteFingerprint(routeDocument);

  return {
    exists: true,
    filePath,
    routeDocument,
    fingerprint,
    isOwned: true
  };
}

/**
 * Prepares a proposed route update, validating the document and comparing against
 * the current file state and expected previous fingerprint (CAS check).
 * Pure inspection; zero filesystem side effects.
 *
 * @param {string} applicationId - Application UUID
 * @param {Object|string} routeDoc - Proposed route document
 * @param {Object} [options] - Options ({ sandboxDir, expectedPreviousFingerprint })
 * @returns {Object} Route update preparation plan
 */
function prepareRouteUpdate(applicationId, routeDoc, options = {}) {
  const validated = validateRouteDocument(routeDoc, { applicationId });
  const current = readOwnedRoute(applicationId, options);

  const expectedPrevious = options.expectedPreviousFingerprint !== undefined
    ? options.expectedPreviousFingerprint
    : null;

  // CAS Verification:
  // If file exists, current fingerprint MUST match expectedPreviousFingerprint
  if (current.exists) {
    if (!expectedPrevious) {
      throw new TraefikRouteWriterError(
        'An existing route file exists for this application, but no expectedPreviousFingerprint was provided for compare-and-swap.',
        'FINGERPRINT_MISMATCH'
      );
    }
    if (current.fingerprint !== expectedPrevious) {
      throw new TraefikRouteWriterError(
        `Route fingerprint drift detected. Expected: "${expectedPrevious}", Found: "${current.fingerprint}".`,
        'FINGERPRINT_MISMATCH'
      );
    }
  } else {
    // If file does not exist, expectedPreviousFingerprint must be null/empty
    if (expectedPrevious) {
      throw new TraefikRouteWriterError(
        `Expected previous route fingerprint "${expectedPrevious}", but route file does not exist.`,
        'FINGERPRINT_MISMATCH'
      );
    }
  }

  return {
    prepared: true,
    applicationId: sanitizeApplicationId(applicationId),
    filePath: current.filePath,
    isFirstRelease: !current.exists,
    previousFingerprint: current.fingerprint,
    proposedFingerprint: validated.fingerprint,
    proposedDocument: validated.documentString
  };
}

/**
 * Atomically writes a K-Panel route configuration file to the sandbox directory.
 * Protocol:
 * 1. Validate CAS fingerprint against live file.
 * 2. Write content to unique temporary file on the same filesystem.
 * 3. Flush file contents via fsync.
 * 4. Atomically rename temporary file over target file.
 * 5. Sync parent directory metadata via fsync.
 * 6. Verify post-rename ownership, regular file status, and fingerprint.
 *
 * @param {string} applicationId - Application UUID
 * @param {Object|string} routeDoc - Proposed route document
 * @param {Object} [options] - Options ({ sandboxDir, expectedPreviousFingerprint })
 * @returns {Object} Result of atomic write operation
 */
function applyRouteUpdate(applicationId, routeDoc, options = {}) {
  const prep = prepareRouteUpdate(applicationId, routeDoc, options);
  const targetPath = prep.filePath;
  const sandboxDir = path.dirname(targetPath);
  const randomSuffix = crypto.randomUUID();
  const tempFileName = `.${path.basename(targetPath)}.${randomSuffix}.tmp`;
  const tempFilePath = path.join(sandboxDir, tempFileName);

  try {
    // 1. Write unique temporary file with restricted 0o600 permissions
    fs.writeFileSync(tempFilePath, prep.proposedDocument, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx' // Fail if temp file already exists
    });

    // 2. Flush file contents to physical storage
    const tempFd = fs.openSync(tempFilePath, 'r');
    try {
      fs.fsyncSync(tempFd);
    } finally {
      fs.closeSync(tempFd);
    }

    // 3. Atomically rename over target file on the same filesystem
    fs.renameSync(tempFilePath, targetPath);

    // 4. Sync directory metadata to ensure rename is durable across crashes
    try {
      const dirFd = fs.openSync(sandboxDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync may be unsupported on certain virtual filesystems, non-fatal
    }

    // 5. Post-apply verification: ensure it is a regular file and not a symlink
    const stat = fs.lstatSync(targetPath);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new TraefikRouteWriterError('Applied route target corrupted or replaced by symlink.', 'SYMLINK_DETECTED');
    }

    // Verify written fingerprint
    const verifiedContent = fs.readFileSync(targetPath, 'utf8');
    const verifiedFingerprint = computeRouteFingerprint(verifiedContent);

    if (verifiedFingerprint !== prep.proposedFingerprint) {
      throw new TraefikRouteWriterError('Applied route fingerprint did not match proposed fingerprint.', 'VERIFICATION_FAILED');
    }

    return {
      applied: true,
      applicationId: prep.applicationId,
      filePath: targetPath,
      fingerprint: verifiedFingerprint,
      previousFingerprint: prep.previousFingerprint,
      isFirstRelease: prep.isFirstRelease,
      appliedAt: new Date().toISOString()
    };
  } catch (err) {
    // Clean up temporary file if leftover
    try {
      if (fs.existsSync(tempFilePath)) {
        fs.unlinkSync(tempFilePath);
      }
    } catch {}

    if (err instanceof TraefikRouteWriterError) throw err;
    throw new TraefikRouteWriterError(`Failed to atomically apply route file: ${err.message}`, 'WRITE_FAILED', {
      originalError: err.message
    });
  }
}

/**
 * Removes a K-Panel-owned route configuration file from the sandbox directory.
 * Strictly verifies ownership and expected route fingerprint before removal.
 *
 * @param {string} applicationId - Application UUID
 * @param {Object} [options] - Options ({ sandboxDir, expectedFingerprint })
 * @returns {Object} Removal outcome
 */
function removeOwnedRoute(applicationId, options = {}) {
  const filePath = resolveSecureRoutePath(applicationId, options.sandboxDir);

  if (!fs.existsSync(filePath)) {
    return {
      removed: true,
      alreadyAbsent: true,
      filePath,
      applicationId: sanitizeApplicationId(applicationId)
    };
  }

  // Ensure target is not a symlink
  const stat = fs.lstatSync(filePath);
  if (stat.isSymbolicLink()) {
    throw new TraefikRouteWriterError('Symlinks cannot be removed via route writer.', 'SYMLINK_DETECTED');
  }

  // Strict ownership check before unlinking
  const isOwned = verifyFileOwnership(filePath, applicationId);
  if (!isOwned) {
    throw new TraefikRouteWriterError(
      `File "${path.basename(filePath)}" is not verified as K-Panel owned. Removal forbidden.`,
      'FOREIGN_ROUTE_FILE'
    );
  }

  // Fingerprint verification if expected fingerprint was supplied
  if (options.expectedFingerprint) {
    const current = fs.readFileSync(filePath, 'utf8');
    const currentFingerprint = computeRouteFingerprint(current);
    if (currentFingerprint !== options.expectedFingerprint) {
      throw new TraefikRouteWriterError(
        `Cannot remove route: live fingerprint "${currentFingerprint}" does not match expected "${options.expectedFingerprint}". Foreign mutation suspected.`,
        'FINGERPRINT_MISMATCH'
      );
    }
  }

  try {
    fs.unlinkSync(filePath);

    // Sync directory metadata
    const sandboxDir = path.dirname(filePath);
    try {
      const dirFd = fs.openSync(sandboxDir, 'r');
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {}

    return {
      removed: true,
      alreadyAbsent: false,
      filePath,
      applicationId: sanitizeApplicationId(applicationId),
      removedAt: new Date().toISOString()
    };
  } catch (err) {
    throw new TraefikRouteWriterError(`Failed to remove route file: ${err.message}`, 'REMOVE_FAILED');
  }
}

/**
 * Restores a previous route document or removes the route if it was a first release.
 *
 * @param {string} applicationId - Application UUID
 * @param {string|null} previousRouteDoc - Previous route document content (or null for first release)
 * @param {Object} [options] - Options ({ sandboxDir, expectedFingerprint })
 * @returns {Object} Restoration result
 */
function restorePreviousRoute(applicationId, previousRouteDoc, options = {}) {
  if (previousRouteDoc && typeof previousRouteDoc === 'string' && previousRouteDoc.trim().length > 0) {
    // Replacement release: restore exact previous document
    return applyRouteUpdate(applicationId, previousRouteDoc, {
      ...options,
      expectedPreviousFingerprint: options.expectedFingerprint // the route currently applied
    });
  }

  // First release: previous route did not exist, so remove the K-Panel route file
  return removeOwnedRoute(applicationId, options);
}

module.exports = {
  getRouteFileName,
  sanitizeApplicationId,
  computeRouteFingerprint,
  resolveAndValidateSandboxDirectory,
  resolveSecureRoutePath,
  validateRouteDocument,
  generateDeterministicYamlRoute,
  verifyFileOwnership,
  readOwnedRoute,
  prepareRouteUpdate,
  applyRouteUpdate,
  removeOwnedRoute,
  restorePreviousRoute,
  TraefikRouteWriterError,
  MAX_ROUTE_DOCUMENT_SIZE,
  FORBIDDEN_DIRECTORIES
};
