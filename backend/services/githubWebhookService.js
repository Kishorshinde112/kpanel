const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const { validateRepositoryUrl } = require('./gitService');
const { isAccountAllowlisted } = require('./githubAppService');

/**
 * Structured service error class for GitHub Webhook operations.
 */
class GithubWebhookError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'GithubWebhookError';
    this.code = code;
    this.details = details;
  }
}

const ZERO_SHA = '0000000000000000000000000000000000000000';
const DELIVERY_ID_REGEX = /^[a-zA-Z0-9-]{8,64}$/;
const COMMIT_SHA_REGEX = /^[0-9a-f]{40}$/i;

/**
 * Retrieves the configured GitHub Webhook Secret.
 * Never returns default or placeholder values in production.
 */
function getWebhookSecret(options = {}) {
  const secret = options.secret !== undefined ? options.secret : process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    return null;
  }
  return secret.trim();
}

/**
 * Cryptographically verifies GitHub webhook HMAC-SHA256 signature using timingSafeEqual.
 * Operates strictly on raw unparsed request payload Buffer bytes.
 *
 * @param {Buffer|string} rawBody - Raw unparsed request body bytes
 * @param {string} signatureHeader - Value of X-Hub-Signature-256 header
 * @param {string} secret - Configured webhook secret
 * @returns {boolean} True if verified
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!secret || typeof secret !== 'string' || secret.trim().length === 0) {
    throw new GithubWebhookError(
      'GitHub Webhook Secret is not configured on this server.',
      'WEBHOOK_SECRET_NOT_CONFIGURED'
    );
  }

  if (!signatureHeader || typeof signatureHeader !== 'string' || signatureHeader.trim().length === 0) {
    throw new GithubWebhookError('Missing X-Hub-Signature-256 signature header.', 'MISSING_SIGNATURE');
  }

  const trimmedHeader = signatureHeader.trim();

  // Explicitly reject SHA-1-only signatures
  if (trimmedHeader.startsWith('sha1=')) {
    throw new GithubWebhookError(
      'SHA-1 signatures are rejected. X-Hub-Signature-256 (HMAC-SHA256) is required.',
      'INVALID_SIGNATURE'
    );
  }

  if (!trimmedHeader.startsWith('sha256=')) {
    throw new GithubWebhookError('Malformed signature header. Expected "sha256=" prefix.', 'INVALID_SIGNATURE');
  }

  if (rawBody === undefined || rawBody === null) {
    throw new GithubWebhookError('Missing raw request body payload.', 'INVALID_SIGNATURE');
  }

  const bodyBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');

  // Compute expected HMAC-SHA256
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(bodyBuffer);
  const expectedDigest = hmac.digest('hex');
  const expectedHeader = `sha256=${expectedDigest}`;

  const expectedBuf = Buffer.from(expectedHeader, 'utf8');
  const actualBuf = Buffer.from(trimmedHeader, 'utf8');

  // Guard against RangeError in crypto.timingSafeEqual
  if (expectedBuf.length !== actualBuf.length) {
    throw new GithubWebhookError('Invalid webhook signature.', 'INVALID_SIGNATURE');
  }

  if (!crypto.timingSafeEqual(expectedBuf, actualBuf)) {
    throw new GithubWebhookError('Invalid webhook signature.', 'INVALID_SIGNATURE');
  }

  return true;
}

/**
 * Safely parses raw webhook JSON while preserving large decimal integer IDs as exact strings
 * without losing precision from JavaScript IEEE-754 Number.MAX_SAFE_INTEGER rounding.
 * Uses a character-level lexical scanner that respects string boundaries and escape characters.
 */
function parseWebhookJsonSafely(rawBody) {
  if (rawBody === undefined || rawBody === null) {
    throw new GithubWebhookError('Missing raw request body payload.', 'INVALID_PAYLOAD');
  }
  const bodyStr = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody);

  let output = '';
  let inString = false;
  let isEscaped = false;
  let lastKey = '';
  let expectingValue = false;
  let currentString = '';

  for (let i = 0; i < bodyStr.length; i++) {
    const ch = bodyStr[i];

    if (inString) {
      output += ch;
      if (isEscaped) {
        currentString += ch;
        isEscaped = false;
      } else if (ch === '\\') {
        currentString += ch;
        isEscaped = true;
      } else if (ch === '"') {
        inString = false;
      } else {
        currentString += ch;
      }
    } else {
      if (ch === '"') {
        inString = true;
        isEscaped = false;
        currentString = '';
        output += ch;
      } else if (ch === ':') {
        expectingValue = true;
        lastKey = currentString.trim();
        output += ch;
      } else if (expectingValue && ((ch >= '0' && ch <= '9') || ch === '-')) {
        let numStr = '';
        let j = i;
        while (j < bodyStr.length && /[0-9eE.+-]/.test(bodyStr[j])) {
          numStr += bodyStr[j];
          j++;
        }
        if ((lastKey === 'id' || lastKey.endsWith('_id')) && /^-?[0-9]+$/.test(numStr) && numStr.length >= 15) {
          output += '"' + numStr + '"';
        } else {
          output += numStr;
        }
        i = j - 1;
        expectingValue = false;
      } else {
        if (ch === ',' || ch === '{' || ch === '}' || ch === '[' || ch === ']') {
          expectingValue = false;
        }
        output += ch;
      }
    }
  }

  try {
    return JSON.parse(output);
  } catch {
    throw new GithubWebhookError('Malformed JSON payload in request body.', 'INVALID_PAYLOAD');
  }
}

/**
 * Validates the format and bounds of the X-GitHub-Delivery header identifier.
 */
function validateDeliveryId(deliveryId) {
  if (!deliveryId || typeof deliveryId !== 'string') {
    throw new GithubWebhookError('Missing X-GitHub-Delivery header.', 'MALFORMED_DELIVERY_ID');
  }
  const trimmed = deliveryId.trim();
  if (!DELIVERY_ID_REGEX.test(trimmed)) {
    throw new GithubWebhookError(`Malformed X-GitHub-Delivery identifier "${trimmed}".`, 'MALFORMED_DELIVERY_ID');
  }
  return trimmed;
}

/**
 * Validates and extracts push event metadata from the parsed payload.
 *
 * @param {Object} payload - Parsed GitHub push event payload
 * @returns {Object} Validated event metadata or { isIgnored: true, reason }
 */
function validatePushEvent(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new GithubWebhookError('Invalid JSON payload in push event.', 'INVALID_PAYLOAD');
  }

  // Repository identification
  const repo = payload.repository;
  if (!repo || !repo.id) {
    throw new GithubWebhookError('Push event payload missing repository identifier.', 'INVALID_PAYLOAD');
  }

  // Reject unsafe rounded numbers if they were somehow parsed as non-safe float numbers
  if (typeof repo.id === 'number' && !Number.isSafeInteger(repo.id)) {
    throw new GithubWebhookError('Unsafe integer precision detected in repository identifier.', 'INVALID_PAYLOAD');
  }

  const repositoryId = String(repo.id);
  if (!/^[1-9]\d*$/.test(repositoryId)) {
    throw new GithubWebhookError(`Invalid repository ID "${repositoryId}" in push payload.`, 'INVALID_PAYLOAD');
  }

  // Installation identification
  const inst = payload.installation;
  if (!inst || !inst.id) {
    throw new GithubWebhookError('Push event payload missing installation identifier.', 'INVALID_PAYLOAD');
  }

  if (typeof inst.id === 'number' && !Number.isSafeInteger(inst.id)) {
    throw new GithubWebhookError('Unsafe integer precision detected in installation identifier.', 'INVALID_PAYLOAD');
  }

  const installationId = String(inst.id);
  if (!/^[1-9]\d*$/.test(installationId)) {
    throw new GithubWebhookError(`Invalid installation ID "${installationId}" in push payload.`, 'INVALID_PAYLOAD');
  }

  const ref = String(payload.ref || '').trim();
  if (!ref) {
    return { isIgnored: true, reason: 'missing_ref' };
  }

  // Ignore tag pushes (only branches are deployment candidates)
  if (ref.startsWith('refs/tags/')) {
    return { isIgnored: true, reason: 'tag_push', ref };
  }

  if (!ref.startsWith('refs/heads/')) {
    return { isIgnored: true, reason: 'unsupported_ref', ref };
  }

  const branch = ref.slice('refs/heads/'.length);

  // Check branch deletion event
  if (payload.deleted === true || payload.after === ZERO_SHA) {
    return { isIgnored: true, reason: 'branch_deleted', branch, ref };
  }

  const commitSha = String(payload.after || '').trim().toLowerCase();
  if (!COMMIT_SHA_REGEX.test(commitSha)) {
    throw new GithubWebhookError(`Invalid commit SHA "${commitSha}" in push payload.`, 'INVALID_PAYLOAD');
  }

  return {
    isIgnored: false,
    repositoryId,
    installationId,
    repositoryFullName: repo.full_name || `${repo.owner?.login || repo.owner?.name}/${repo.name}`,
    repositoryName: repo.name || '',
    repositoryOwner: repo.owner?.login || repo.owner?.name || '',
    ref,
    branch,
    commitSha,
    beforeSha: payload.before || null,
    pusher: payload.pusher?.name || payload.sender?.login || 'unknown'
  };
}

/**
 * Searches SQLite for registered applications that match an incoming verified push event.
 * Enforces verified association, active installation, account allowlisting, matching branch, and URL integrity.
 *
 * @param {Object} event - Validated push event metadata
 * @param {Object} options - Database and allowlist options
 * @returns {Array<Object>} List of matching application records
 */
function findMatchingApplicationsForPush(event, options = {}) {
  const db = options.db || getDatabase(options);

  const rows = db.prepare(`
    SELECT
      a.id, a.name, a.slug, a.branch, a.repo_url,
      ar.installation_id, ar.repository_id, ar.repository_owner, ar.repository_name, ar.repository_full_name, ar.association_status,
      gi.account_id, gi.account_login, gi.installation_status
    FROM applications a
    JOIN application_repositories ar ON a.id = ar.application_id
    JOIN github_installations gi ON ar.installation_id = gi.installation_id
    WHERE ar.repository_id = ? AND ar.installation_id = ?
  `).all(event.repositoryId, event.installationId);

  const matched = [];

  for (const row of rows) {
    // 1. Association status must be verified
    if (row.association_status !== 'verified') {
      continue;
    }

    // 2. Installation status must be active (reject suspended)
    if (row.installation_status !== 'active') {
      continue;
    }

    // 3. Account ID must be in server-side allowlist
    if (options.enforceAllowlist !== false) {
      if (!isAccountAllowlisted(row.account_id, options)) {
        continue;
      }
    }

    // 4. Branch matching: Application configured branch must match pushed branch exactly
    if (row.branch !== event.branch) {
      continue;
    }

    // 5. Ensure application repo_url has not drifted from verified association
    try {
      const urlInfo = validateRepositoryUrl(row.repo_url, options);
      const ownerMatch = urlInfo.owner.toLowerCase() === row.repository_owner.toLowerCase();
      const repoMatch = urlInfo.repo.toLowerCase() === row.repository_name.toLowerCase();
      if (!ownerMatch || !repoMatch) {
        continue;
      }
    } catch {
      continue;
    }

    matched.push({
      applicationId: row.id,
      applicationName: row.name,
      applicationSlug: row.slug,
      branch: row.branch,
      repoUrl: row.repo_url,
      installationId: row.installation_id,
      repositoryId: row.repository_id
    });
  }

  return matched;
}

/**
 * Persists webhook delivery record and targets transactionally with deduplication.
 *
 * @param {Object} deliveryData - { deliveryId, eventName, rawBody, installationId, repositoryId, ref, commitSha, decision }
 * @param {Array<Object>} matchedApps - Array of matched application targets
 * @param {Object} options - Database options
 * @returns {Object} { status: 'accepted'|'duplicate'|'ignored', decision, matchedCount }
 */
function recordWebhookDelivery(deliveryData, matchedApps = [], options = {}) {
  const db = options.db || getDatabase(options);
  const { deliveryId, eventName, rawBody, installationId, repositoryId, ref, commitSha, decision } = deliveryData;

  const payloadBuffer = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ''), 'utf8');
  const payloadSha256 = crypto.createHash('sha256').update(payloadBuffer).digest('hex');

  // Check if delivery ID has already been recorded
  const existing = db.prepare('SELECT delivery_id, payload_sha256, decision FROM github_webhook_deliveries WHERE delivery_id = ?').get(deliveryId);

  if (existing) {
    if (existing.payload_sha256 === payloadSha256) {
      return {
        status: 'duplicate',
        duplicate: true,
        deliveryId,
        decision: existing.decision,
        message: 'Delivery already processed with identical payload hash.'
      };
    }
    // Same delivery ID with different payload -> Conflict
    throw new GithubWebhookError(
      `Delivery ID "${deliveryId}" has already been processed with a different payload hash.`,
      'DELIVERY_CONFLICT'
    );
  }

  // Atomically persist delivery and targets inside SQLite transaction
  const insertTx = db.transaction(() => {
    db.prepare(`
      INSERT INTO github_webhook_deliveries (
        delivery_id, event_name, payload_sha256, installation_id, repository_id, ref, commit_sha, decision, received_at, processed_at
      ) VALUES (
        @delivery_id, @event_name, @payload_sha256, @installation_id, @repository_id, @ref, @commit_sha, @decision, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run({
      delivery_id: deliveryId,
      event_name: eventName,
      payload_sha256: payloadSha256,
      installation_id: installationId || null,
      repository_id: repositoryId || null,
      ref: ref || null,
      commit_sha: commitSha || null,
      decision
    });

    const insertTargetStmt = db.prepare(`
      INSERT INTO github_webhook_targets (
        delivery_id, application_id, commit_sha, ref, created_at
      ) VALUES (
        @delivery_id, @application_id, @commit_sha, @ref, CURRENT_TIMESTAMP
      )
    `);

    for (const app of matchedApps) {
      insertTargetStmt.run({
        delivery_id: deliveryId,
        application_id: app.applicationId,
        commit_sha: commitSha,
        ref
      });
    }
  });

  try {
    insertTx();
  } catch (err) {
    throw new GithubWebhookError(`Failed to persist webhook delivery inbox: ${err.message}`, 'DATABASE_ERROR');
  }

  return {
    status: decision === 'accepted' ? 'accepted' : 'acknowledged',
    deliveryId,
    decision,
    matchedCount: matchedApps.length
  };
}

module.exports = {
  verifyWebhookSignature,
  validateDeliveryId,
  validatePushEvent,
  parseWebhookJsonSafely,
  findMatchingApplicationsForPush,
  recordWebhookDelivery,
  getWebhookSecret,
  GithubWebhookError
};
