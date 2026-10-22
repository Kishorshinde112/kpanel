const crypto = require('crypto');
const { getDatabase } = require('../config/database');

/**
 * Structured service error class for application management.
 */
class ApplicationServiceError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ApplicationServiceError';
    this.code = code; // 'VALIDATION_ERROR' | 'DUPLICATE_SLUG' | 'APPLICATION_NOT_FOUND' | 'DATABASE_ERROR'
    this.details = details;
  }
}

const SUPPORTED_BUILD_TYPES = new Set(['dockerfile', 'railpack', 'compose']);
const EDITABLE_FIELDS = new Set([
  'name',
  'slug',
  'repo_url',
  'branch',
  'build_type',
  'build_path',
  'port',
  'domain',
  'cpu_limit',
  'memory_limit_mb'
]);
const IMMUTABLE_FIELDS = new Set(['id', 'created_at', 'active_release_id']);

/**
 * Helper to slugify a string into valid kebab-case.
 */
function slugify(text) {
  if (!text || typeof text !== 'string') return '';
  return text
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Validates application name.
 */
function validateName(name) {
  if (!name || typeof name !== 'string') {
    throw new ApplicationServiceError('Application name is required and must be a string.', 'VALIDATION_ERROR', { field: 'name' });
  }
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new ApplicationServiceError('Application name must be between 1 and 100 characters.', 'VALIDATION_ERROR', { field: 'name' });
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new ApplicationServiceError('Application name cannot contain control characters.', 'VALIDATION_ERROR', { field: 'name' });
  }
  return trimmed;
}

/**
 * Validates application slug.
 */
function validateSlug(slug) {
  if (!slug || typeof slug !== 'string') {
    throw new ApplicationServiceError('Application slug is required.', 'VALIDATION_ERROR', { field: 'slug' });
  }
  const trimmed = slug.trim().toLowerCase();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new ApplicationServiceError('Application slug must be between 1 and 100 characters.', 'VALIDATION_ERROR', { field: 'slug' });
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(trimmed)) {
    throw new ApplicationServiceError('Application slug must consist of lowercase alphanumeric characters separated by single hyphens.', 'VALIDATION_ERROR', { field: 'slug' });
  }
  return trimmed;
}

/**
 * Validates Git repository URL.
 * Rejects embedded credentials, control characters, and local file paths.
 */
function validateRepoUrl(url) {
  if (!url || typeof url !== 'string') {
    throw new ApplicationServiceError('Repository URL is required and must be a string.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  const trimmed = url.trim();
  if (trimmed.length < 3 || trimmed.length > 500) {
    throw new ApplicationServiceError('Repository URL must be between 3 and 500 characters.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  // Reject control characters or newlines
  if (/[\x00-\x1F\x7F\s]/.test(trimmed)) {
    throw new ApplicationServiceError('Repository URL must not contain whitespace or control characters.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  // Reject local file schemes or path traversal
  if (/^(file:\/\/|\/|\.\/|\.\.\/|[a-zA-Z]:\\)/i.test(trimmed)) {
    throw new ApplicationServiceError('Repository URL: Local file repository schemes are not permitted.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  // Reject embedded credentials in URLs (e.g. https://user:token@github.com/... or git@...:password)
  if (/^[a-zA-Z]+:\/\/[^@/\s]+@/.test(trimmed) || /:([^@/\s]+)@/.test(trimmed)) {
    throw new ApplicationServiceError('Repository URL must not contain embedded authentication credentials.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  // Must match valid HTTPS or SSH git repository pattern
  const isHttps = /^https?:\/\/[a-zA-Z0-9.-]+(?::[0-9]+)?\/[^\s@:]+$/i.test(trimmed);
  const isSsh = /^(?:git@|ssh:\/\/(?:[a-zA-Z0-9._-]+@)?)[a-zA-Z0-9.-]+(?::[0-9]+)?[:\/][^\s@:]+$/i.test(trimmed);
  if (!isHttps && !isSsh) {
    throw new ApplicationServiceError('Repository URL must be a valid HTTPS or SSH Git URL.', 'VALIDATION_ERROR', { field: 'repo_url' });
  }
  return trimmed;
}

/**
 * Validates Git branch name.
 */
function validateBranch(branch) {
  if (!branch || typeof branch !== 'string') {
    throw new ApplicationServiceError('Branch name must be a non-empty string.', 'VALIDATION_ERROR', { field: 'branch' });
  }
  const trimmed = branch.trim();
  if (trimmed.length < 1 || trimmed.length > 100) {
    throw new ApplicationServiceError('Branch name must be between 1 and 100 characters.', 'VALIDATION_ERROR', { field: 'branch' });
  }
  // Reject git reference violations (.., ~, ^, :, ?, *, [, control chars)
  if (/\.\.|\~|\^|:|\?|\*|\[|\\|[\x00-\x1F\x7F\s]/.test(trimmed) || trimmed.startsWith('/') || trimmed.endsWith('/') || trimmed.endsWith('.')) {
    throw new ApplicationServiceError('Branch name contains invalid git reference characters.', 'VALIDATION_ERROR', { field: 'branch' });
  }
  return trimmed;
}

/**
 * Validates build type.
 */
function validateBuildType(buildType) {
  if (!buildType || typeof buildType !== 'string') {
    return 'dockerfile';
  }
  const normalized = buildType.trim().toLowerCase();
  if (!SUPPORTED_BUILD_TYPES.has(normalized)) {
    throw new ApplicationServiceError(
      `Unsupported build type "${buildType}". Supported types: ${Array.from(SUPPORTED_BUILD_TYPES).join(', ')}.`,
      'VALIDATION_ERROR',
      { field: 'build_type', supported: Array.from(SUPPORTED_BUILD_TYPES) }
    );
  }
  return normalized;
}

/**
 * Validates repository-relative build path.
 */
function validateBuildPath(buildPath) {
  if (!buildPath || typeof buildPath !== 'string') {
    return '/';
  }
  const trimmed = buildPath.trim();
  // Disallow directory traversal
  if (trimmed.includes('..')) {
    throw new ApplicationServiceError('Build path cannot contain directory traversal references ("..").', 'VALIDATION_ERROR', { field: 'build_path' });
  }
  if (/[\x00-\x1F\x7F]/.test(trimmed)) {
    throw new ApplicationServiceError('Build path cannot contain control characters.', 'VALIDATION_ERROR', { field: 'build_path' });
  }
  let normalized = trimmed.replace(/\\/g, '/');
  if (!normalized.startsWith('/')) {
    normalized = '/' + normalized;
  }
  // Collapse multiple slashes
  normalized = normalized.replace(/\/+/g, '/');
  if (normalized.length > 255) {
    throw new ApplicationServiceError('Build path must not exceed 255 characters.', 'VALIDATION_ERROR', { field: 'build_path' });
  }
  return normalized;
}

/**
 * Validates application container port.
 */
function validatePort(port) {
  const num = typeof port === 'string' ? parseInt(port, 10) : port;
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new ApplicationServiceError('Application port must be an integer between 1 and 65535.', 'VALIDATION_ERROR', { field: 'port' });
  }
  return num;
}

/**
 * Validates domain hostname (RFC 1123 format).
 */
function validateDomain(domain) {
  if (!domain) return null;
  if (typeof domain !== 'string') {
    throw new ApplicationServiceError('Domain must be a string.', 'VALIDATION_ERROR', { field: 'domain' });
  }
  let trimmed = domain.trim().toLowerCase();
  // Strip protocol or paths if accidentally passed
  if (trimmed.includes('://') || trimmed.includes('/') || trimmed.includes(':')) {
    throw new ApplicationServiceError('Domain must be a bare hostname without protocol, port, or path.', 'VALIDATION_ERROR', { field: 'domain' });
  }
  if (trimmed.length < 3 || trimmed.length > 253) {
    throw new ApplicationServiceError('Domain must be between 3 and 253 characters.', 'VALIDATION_ERROR', { field: 'domain' });
  }
  const domainRegex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
  if (!domainRegex.test(trimmed)) {
    throw new ApplicationServiceError('Domain must be a syntactically valid RFC 1123 hostname.', 'VALIDATION_ERROR', { field: 'domain' });
  }
  return trimmed;
}

/**
 * Validates Cgroups CPU cores limit.
 */
function validateCpuLimit(cpuLimit) {
  if (cpuLimit === undefined || cpuLimit === null) return 1.0;
  const num = typeof cpuLimit === 'string' ? parseFloat(cpuLimit) : cpuLimit;
  if (isNaN(num) || num < 0.1 || num > 32.0) {
    throw new ApplicationServiceError('CPU limit must be a positive number between 0.1 and 32.0 cores.', 'VALIDATION_ERROR', { field: 'cpu_limit' });
  }
  return parseFloat(num.toFixed(2));
}

/**
 * Validates Cgroups memory limit in megabytes.
 */
function validateMemoryLimit(memoryLimitMb) {
  if (memoryLimitMb === undefined || memoryLimitMb === null) return 1024;
  const num = typeof memoryLimitMb === 'string' ? parseInt(memoryLimitMb, 10) : memoryLimitMb;
  if (!Number.isInteger(num) || num < 64 || num > 65536) {
    throw new ApplicationServiceError('Memory limit must be an integer between 64 MB and 65536 MB (64 GB).', 'VALIDATION_ERROR', { field: 'memory_limit_mb' });
  }
  return num;
}

/**
 * Sanitizes an application database row for external return.
 */
function sanitizeApplication(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    repo_url: row.repo_url,
    branch: row.branch,
    build_type: row.build_type,
    build_path: row.build_path,
    port: row.port,
    domain: row.domain || null,
    cpu_limit: row.cpu_limit,
    memory_limit_mb: row.memory_limit_mb,
    active_release_id: row.active_release_id || null,
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

/**
 * Creates a new application in SQLite.
 *
 * @param {Object} input - Application creation payload
 * @param {Object} options - Database options (e.g. { db })
 * @returns {Object} Sanitized created application record
 */
function createApplication(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new ApplicationServiceError('Input must be a valid object.', 'VALIDATION_ERROR');
  }

  // Reject unexpected/unknown fields
  const allowedInputKeys = new Set([
    'name',
    'slug',
    'repo_url',
    'branch',
    'build_type',
    'build_path',
    'port',
    'domain',
    'cpu_limit',
    'memory_limit_mb'
  ]);
  for (const key of Object.keys(input)) {
    if (!allowedInputKeys.has(key)) {
      throw new ApplicationServiceError(`Unknown field "${key}" is not permitted on application creation.`, 'VALIDATION_ERROR', { field: key });
    }
  }

  const name = validateName(input.name);
  const slug = validateSlug(input.slug || slugify(name));
  const repo_url = validateRepoUrl(input.repo_url);
  const branch = validateBranch(input.branch || 'main');
  const build_type = validateBuildType(input.build_type || 'dockerfile');
  const build_path = validateBuildPath(input.build_path || '/');
  const port = validatePort(input.port !== undefined ? input.port : 3000);
  const domain = validateDomain(input.domain);
  const cpu_limit = validateCpuLimit(input.cpu_limit);
  const memory_limit_mb = validateMemoryLimit(input.memory_limit_mb);

  const id = crypto.randomUUID();
  const db = options.db || getDatabase(options);

  const insertStmt = db.prepare(`
    INSERT INTO applications (
      id, name, slug, repo_url, branch, build_type, build_path, port, domain, cpu_limit, memory_limit_mb
    ) VALUES (
      @id, @name, @slug, @repo_url, @branch, @build_type, @build_path, @port, @domain, @cpu_limit, @memory_limit_mb
    )
  `);

  try {
    insertStmt.run({
      id,
      name,
      slug,
      repo_url,
      branch,
      build_type,
      build_path,
      port,
      domain,
      cpu_limit,
      memory_limit_mb
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed: applications.slug')) {
      throw new ApplicationServiceError(`Application slug "${slug}" already exists. Please choose a unique slug.`, 'DUPLICATE_SLUG', { field: 'slug', slug });
    }
    throw new ApplicationServiceError(`Database insert failed: ${err.message}`, 'DATABASE_ERROR');
  }

  return getApplicationById(id, { db });
}

/**
 * Retrieves an application by its unique ID.
 *
 * @param {string} id - Application UUID
 * @param {Object} options - Database options
 * @returns {Object|null} Sanitized application record or null
 */
function getApplicationById(id, options = {}) {
  if (!id || typeof id !== 'string') return null;
  const db = options.db || getDatabase(options);
  const row = db.prepare('SELECT * FROM applications WHERE id = ?').get(id.trim());
  return sanitizeApplication(row);
}

/**
 * Retrieves an application by its unique slug.
 *
 * @param {string} slug - Unique application slug
 * @param {Object} options - Database options
 * @returns {Object|null} Sanitized application record or null
 */
function getApplicationBySlug(slug, options = {}) {
  if (!slug || typeof slug !== 'string') return null;
  const db = options.db || getDatabase(options);
  const row = db.prepare('SELECT * FROM applications WHERE slug = ?').get(slug.trim().toLowerCase());
  return sanitizeApplication(row);
}

/**
 * Lists applications with deterministic ordering and bounded pagination.
 *
 * @param {Object} options - Pagination and sorting options
 * @returns {Object} { data: [...], pagination: { page, limit, total, totalPages } }
 */
function listApplications(options = {}) {
  const db = options.db || getDatabase(options);

  // Pagination parameters
  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const rawLimit = parseInt(options.limit, 10) || 20;
  const limit = Math.min(100, Math.max(1, rawLimit)); // Bounded between 1 and 100
  const offset = (page - 1) * limit;

  // Sorting parameters
  const allowedSortColumns = {
    created_at: 'created_at',
    updated_at: 'updated_at',
    name: 'name',
    slug: 'slug'
  };
  const sortCol = allowedSortColumns[options.sortBy] || 'created_at';
  const sortDir = String(options.sortOrder || '').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const totalRow = db.prepare('SELECT COUNT(*) as total FROM applications').get();
  const total = totalRow?.total || 0;

  const rows = db
    .prepare(`
      SELECT * FROM applications
      ORDER BY ${sortCol} ${sortDir}, id ASC
      LIMIT ? OFFSET ?
    `)
    .all(limit, offset);

  return {
    data: rows.map(sanitizeApplication),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 1
    }
  };
}

/**
 * Updates editable fields of an existing application.
 *
 * @param {string} id - Application UUID
 * @param {Object} changes - Key-value map of changes
 * @param {Object} options - Database options
 * @returns {Object} Updated application record
 */
function updateApplication(id, changes, options = {}) {
  if (!id || typeof id !== 'string') {
    throw new ApplicationServiceError('Application ID is required.', 'VALIDATION_ERROR', { field: 'id' });
  }
  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) {
    throw new ApplicationServiceError('No changes provided to update.', 'VALIDATION_ERROR');
  }

  const db = options.db || getDatabase(options);
  const existing = getApplicationById(id, { db });
  if (!existing) {
    throw new ApplicationServiceError(`Application with ID "${id}" was not found.`, 'APPLICATION_NOT_FOUND', { id });
  }

  // Reject unknown or immutable fields
  for (const key of Object.keys(changes)) {
    if (IMMUTABLE_FIELDS.has(key)) {
      throw new ApplicationServiceError(`Field "${key}" is immutable and cannot be updated directly.`, 'VALIDATION_ERROR', { field: key });
    }
    if (!EDITABLE_FIELDS.has(key)) {
      throw new ApplicationServiceError(`Unknown field "${key}" is not an editable application field.`, 'VALIDATION_ERROR', { field: key });
    }
  }

  // Validate only provided changes
  const updates = {};
  if (changes.name !== undefined) updates.name = validateName(changes.name);
  if (changes.slug !== undefined) updates.slug = validateSlug(changes.slug);
  if (changes.repo_url !== undefined) updates.repo_url = validateRepoUrl(changes.repo_url);
  if (changes.branch !== undefined) updates.branch = validateBranch(changes.branch);
  if (changes.build_type !== undefined) updates.build_type = validateBuildType(changes.build_type);
  if (changes.build_path !== undefined) updates.build_path = validateBuildPath(changes.build_path);
  if (changes.port !== undefined) updates.port = validatePort(changes.port);
  if (changes.domain !== undefined) updates.domain = validateDomain(changes.domain);
  if (changes.cpu_limit !== undefined) updates.cpu_limit = validateCpuLimit(changes.cpu_limit);
  if (changes.memory_limit_mb !== undefined) updates.memory_limit_mb = validateMemoryLimit(changes.memory_limit_mb);

  const setClauses = Object.keys(updates).map((key) => `${key} = @${key}`);
  setClauses.push('updated_at = CURRENT_TIMESTAMP');

  const updateStmt = db.prepare(`
    UPDATE applications
    SET ${setClauses.join(', ')}
    WHERE id = @id
  `);

  try {
    updateStmt.run({
      ...updates,
      id: id.trim()
    });
  } catch (err) {
    if (err.message && err.message.includes('UNIQUE constraint failed: applications.slug')) {
      throw new ApplicationServiceError(`Application slug "${updates.slug}" already exists.`, 'DUPLICATE_SLUG', { field: 'slug', slug: updates.slug });
    }
    throw new ApplicationServiceError(`Database update failed: ${err.message}`, 'DATABASE_ERROR');
  }

  return getApplicationById(id, { db });
}

module.exports = {
  createApplication,
  getApplicationById,
  getApplicationBySlug,
  listApplications,
  updateApplication,
  ApplicationServiceError,
  slugify,
  SUPPORTED_BUILD_TYPES,
  EDITABLE_FIELDS,
  IMMUTABLE_FIELDS
};
