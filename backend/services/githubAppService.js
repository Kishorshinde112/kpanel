const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

/**
 * Structured service error class for GitHub App operations.
 */
class GithubAppError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'GithubAppError';
    this.code = code;
    this.details = details;
  }
}

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const MAX_RESPONSE_BYTES = 100 * 1024; // 100 KB limit for GitHub API JSON responses

/**
 * Converts Buffer or object to Base64URL string.
 */
function base64UrlEncode(data) {
  const buf = Buffer.isBuffer(data)
    ? data
    : Buffer.from(typeof data === 'object' ? JSON.stringify(data) : String(data), 'utf8');
  return buf.toString('base64url');
}

/**
 * Resolves the configured GitHub App ID.
 * Returns string or null if not configured.
 */
function getAppId(options = {}) {
  const isExplicit = options.appId !== undefined && options.appId !== null;
  const raw = isExplicit ? options.appId : process.env.GITHUB_APP_ID;
  if (raw === undefined || raw === null) {
    return null;
  }
  const str = String(raw).trim();
  if (str.length === 0) {
    if (isExplicit) {
      throw new GithubAppError('Invalid GitHub App identifier. Expected positive integer.', 'GITHUB_APP_INVALID_ID');
    }
    return null;
  }
  if (!/^[1-9]\d*$/.test(str)) {
    throw new GithubAppError(`Invalid GitHub App identifier "${str}". Expected positive integer.`, 'GITHUB_APP_INVALID_ID');
  }
  return str;
}

/**
 * Loads and validates the RSA private key for the GitHub App.
 * Returns KeyObject or throws GithubAppError without exposing secret contents.
 */
function getPrivateKey(options = {}) {
  if (options.privateKey) {
    try {
      const keyObj = crypto.createPrivateKey(options.privateKey);
      if (keyObj.asymmetricKeyType !== 'rsa') {
        throw new Error('Key is not RSA');
      }
      return keyObj;
    } catch {
      throw new GithubAppError('Invalid GitHub App private key format. Expected RSA PEM.', 'GITHUB_APP_INVALID_KEY');
    }
  }

  const keyPath = options.privateKeyPath || process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (!keyPath || typeof keyPath !== 'string' || keyPath.trim().length === 0) {
    return null;
  }

  const resolvedPath = path.resolve(keyPath.trim());
  if (!fs.existsSync(resolvedPath)) {
    throw new GithubAppError('GitHub App private key file not found at configured path.', 'GITHUB_APP_INVALID_KEY');
  }

  try {
    const pem = fs.readFileSync(resolvedPath, 'utf8');
    const keyObj = crypto.createPrivateKey(pem);
    if (keyObj.asymmetricKeyType !== 'rsa') {
      throw new Error('Key is not RSA');
    }
    return keyObj;
  } catch {
    throw new GithubAppError('Invalid GitHub App private key format. Expected RSA PEM.', 'GITHUB_APP_INVALID_KEY');
  }
}

/**
 * Checks if the GitHub App identity is configured.
 * Missing configuration returns false without throwing or breaking startup.
 */
function isGithubAppConfigured(options = {}) {
  try {
    const appId = getAppId(options);
    if (!appId) return false;
    const privateKey = getPrivateKey(options);
    return Boolean(privateKey);
  } catch {
    return false;
  }
}

/**
 * Generates an RS256 JWT for GitHub App authentication.
 * Adheres to GitHub App specifications: RS256, 10m max lifespan, 60s clock skew.
 */
function createAppJwt(options = {}) {
  const appId = getAppId(options);
  if (!appId) {
    throw new GithubAppError('GitHub App ID is not configured.', 'GITHUB_APP_NOT_CONFIGURED');
  }

  const privateKey = getPrivateKey(options);
  if (!privateKey) {
    throw new GithubAppError('GitHub App private key is not configured.', 'GITHUB_APP_NOT_CONFIGURED');
  }

  const nowSeconds = Math.floor((options.now !== undefined ? options.now : Date.now()) / 1000);
  const clockSkewOffset = 60; // 60 seconds in past to account for server clock drift
  const jwtDurationSeconds = 540; // 9 minutes (GitHub maximum is 10 minutes / 600s)

  const header = {
    alg: 'RS256',
    typ: 'JWT'
  };

  const payload = {
    iat: nowSeconds - clockSkewOffset,
    exp: nowSeconds + jwtDurationSeconds,
    iss: appId
  };

  const encodedHeader = base64UrlEncode(header);
  const encodedPayload = base64UrlEncode(payload);
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  try {
    const signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput, 'utf8'), privateKey);
    const encodedSignature = base64UrlEncode(signature);
    return `${signingInput}.${encodedSignature}`;
  } catch (err) {
    throw new GithubAppError(`Failed to sign GitHub App JWT: ${err.message}`, 'GITHUB_AUTH_FAILED');
  }
}

/**
 * Requests a short-lived, repository-scoped installation access token from GitHub REST API.
 * Uses: POST /app/installations/{installation_id}/access_tokens
 *
 * @param {string|number} installationId - GitHub App installation identifier
 * @param {Object} options - Scoping options (repositories or repository_ids)
 * @returns {Promise<Object>} { token, expiresAt, permissions, repositorySelection }
 */
async function getInstallationAccessToken(installationId, options = {}) {
  if (installationId === undefined || installationId === null || String(installationId).trim().length === 0) {
    throw new GithubAppError('Installation ID is required.', 'GITHUB_APP_INVALID_ID');
  }

  const instIdStr = String(installationId).trim();
  if (!/^[1-9]\d*$/.test(instIdStr)) {
    throw new GithubAppError(`Invalid installation ID "${instIdStr}". Expected positive integer.`, 'GITHUB_APP_INVALID_ID');
  }

  // Enforce repository-scoped access tokens
  const hasRepoNames = Array.isArray(options.repositories) && options.repositories.length > 0;
  const hasRepoIds = Array.isArray(options.repository_ids) && options.repository_ids.length > 0;

  if (!hasRepoNames && !hasRepoIds) {
    throw new GithubAppError(
      'Repository-scoped access token requires explicit repository names or repository IDs. Unscoped tokens are prohibited.',
      'GITHUB_PERMISSION_DENIED'
    );
  }

  // Reject unexpected or escalated permissions (strictly read-only contents for source checkout)
  if (options.permissions) {
    const keys = Object.keys(options.permissions);
    const hasOnlyContentsRead = keys.length === 1 && keys[0] === 'contents' && options.permissions.contents === 'read';
    if (!hasOnlyContentsRead) {
      throw new GithubAppError(
        'Unauthorized permission request. Only read-only contents permission ("contents: read") is permitted for checkouts.',
        'GITHUB_PERMISSION_DENIED'
      );
    }
  }

  const appJwt = createAppJwt(options);

  const requestBody = {
    permissions: {
      contents: 'read'
    }
  };

  if (hasRepoNames) {
    requestBody.repositories = options.repositories.map(String);
  }
  if (hasRepoIds) {
    requestBody.repository_ids = options.repository_ids.map(Number);
  }

  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(instIdStr)}/access_tokens`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    throw new GithubAppError('HTTP fetch capability is not available in current runtime.', 'GITHUB_API_ERROR');
  }

  const controller = new AbortController();
  const timeoutMs = options.timeout || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  // External caller signal forwarding
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }

  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      redirect: 'manual', // Reject redirects
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new GithubAppError('GitHub API request timed out.', 'GITHUB_API_TIMEOUT');
    }
    throw new GithubAppError('Network communication error with GitHub API.', 'GITHUB_API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  // Handle redirects safely (must never follow off-origin or redirect blindly)
  if (response.status >= 300 && response.status < 400) {
    throw new GithubAppError('Unexpected HTTP redirect received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  // Read response with size bounding
  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    throw new GithubAppError('Failed to read response body from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (rawText.length > MAX_RESPONSE_BYTES) {
    throw new GithubAppError('GitHub API response exceeded maximum permitted size bounds.', 'GITHUB_INVALID_RESPONSE');
  }

  let json = {};
  try {
    json = JSON.parse(rawText);
  } catch {
    json = {};
  }

  // Error status mappings
  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAppError('GitHub App authentication failed. Check App ID and Private Key.', 'GITHUB_AUTH_FAILED');
    }
    if (response.status === 403) {
      const remaining = response.headers?.get?.('x-ratelimit-remaining');
      if (remaining === '0' || String(json.message || '').toLowerCase().includes('rate limit')) {
        throw new GithubAppError('GitHub API rate limit exceeded.', 'GITHUB_RATE_LIMITED');
      }
      throw new GithubAppError(json.message || 'Access to requested repository installation was denied.', 'GITHUB_PERMISSION_DENIED');
    }
    if (response.status === 404) {
      throw new GithubAppError(`GitHub App installation "${instIdStr}" was not found.`, 'GITHUB_INSTALLATION_NOT_FOUND');
    }
    if (response.status === 429) {
      throw new GithubAppError('GitHub API rate limit exceeded.', 'GITHUB_RATE_LIMITED');
    }
    if (response.status >= 500) {
      throw new GithubAppError('GitHub API service encounter an internal error.', 'GITHUB_API_ERROR');
    }
    throw new GithubAppError(json.message || `GitHub API request failed with status ${response.status}.`, 'GITHUB_API_ERROR');
  }

  // Validate token payload
  if (!json.token || typeof json.token !== 'string' || json.token.length === 0) {
    throw new GithubAppError('Invalid response from GitHub: Missing installation access token.', 'GITHUB_INVALID_RESPONSE');
  }

  if (!json.expires_at || typeof json.expires_at !== 'string') {
    throw new GithubAppError('Invalid response from GitHub: Missing token expiration timestamp.', 'GITHUB_INVALID_RESPONSE');
  }

  const expiresAtMs = new Date(json.expires_at).getTime();
  if (isNaN(expiresAtMs)) {
    throw new GithubAppError('Invalid expiration timestamp format in GitHub response.', 'GITHUB_INVALID_RESPONSE');
  }

  // Safety buffer: Reject token if already expired or expiring within 60 seconds
  const safetyBufferMs = 60 * 1000;
  if (expiresAtMs <= Date.now() + safetyBufferMs) {
    throw new GithubAppError('Received token is already expired or near expiration.', 'GITHUB_INVALID_RESPONSE');
  }

  return {
    token: json.token,
    expiresAt: json.expires_at,
    permissions: json.permissions || { contents: 'read' },
    repositorySelection: json.repository_selection || 'selected'
  };
}

/**
 * Requests an installation token restricted exclusively for repository discovery/metadata enumeration.
 * Never grants contents write or administration permissions.
 *
 * @param {string|number} installationId - GitHub App installation identifier
 * @param {Object} options - Options
 * @returns {Promise<Object>} { token, expiresAt, permissions }
 */
async function getDiscoveryInstallationToken(installationId, options = {}) {
  if (installationId === undefined || installationId === null || String(installationId).trim().length === 0) {
    throw new GithubAppError('Installation ID is required.', 'GITHUB_APP_INVALID_ID');
  }

  const instIdStr = String(installationId).trim();
  if (!/^[1-9]\d*$/.test(instIdStr)) {
    throw new GithubAppError(`Invalid installation ID "${instIdStr}". Expected positive integer.`, 'GITHUB_APP_INVALID_ID');
  }

  const appJwt = createAppJwt(options);

  // Request minimal metadata or read-only contents permission for listing
  const requestBody = {
    permissions: {
      metadata: 'read'
    }
  };

  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(instIdStr)}/access_tokens`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    throw new GithubAppError('HTTP fetch capability is not available in current runtime.', 'GITHUB_API_ERROR');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  let response;
  try {
    response = await fetchFn(url, {
      method: 'POST',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(requestBody),
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError' || controller.signal.aborted) {
      throw new GithubAppError('GitHub API request timed out.', 'GITHUB_API_TIMEOUT');
    }
    throw new GithubAppError('Network communication error with GitHub API.', 'GITHUB_API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GithubAppError('Unexpected HTTP redirect received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    throw new GithubAppError('Failed to read response body from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (rawText.length > MAX_RESPONSE_BYTES) {
    throw new GithubAppError('GitHub API response exceeded maximum permitted size bounds.', 'GITHUB_INVALID_RESPONSE');
  }

  let json = {};
  try {
    json = JSON.parse(rawText);
  } catch {
    json = {};
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAppError('GitHub App authentication failed. Check App ID and Private Key.', 'GITHUB_AUTH_FAILED');
    }
    if (response.status === 403) {
      throw new GithubAppError(json.message || 'Permission denied for repository discovery.', 'GITHUB_PERMISSION_DENIED');
    }
    if (response.status === 404) {
      throw new GithubAppError(`GitHub App installation "${instIdStr}" was not found.`, 'GITHUB_INSTALLATION_NOT_FOUND');
    }
    throw new GithubAppError(`GitHub API request failed with status ${response.status}.`, 'GITHUB_API_ERROR');
  }

  if (!json.token || typeof json.token !== 'string') {
    throw new GithubAppError('Invalid response from GitHub: Missing installation access token.', 'GITHUB_INVALID_RESPONSE');
  }

  return {
    token: json.token,
    expiresAt: json.expires_at,
    permissions: json.permissions || { metadata: 'read' }
  };
}

/**
 * Obtains non-sensitive installation status metadata.
 * Internal method only.
 */
async function getInstallationStatus(installationId, options = {}) {
  if (!installationId || !/^[1-9]\d*$/.test(String(installationId).trim())) {
    throw new GithubAppError('Invalid installation ID.', 'GITHUB_APP_INVALID_ID');
  }

  const instIdStr = String(installationId).trim();
  const appJwt = createAppJwt(options);
  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(instIdStr)}`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform'
      },
      signal: controller.signal
    });

    if (!res.ok) {
      if (res.status === 404) {
        throw new GithubAppError('GitHub App installation not found.', 'GITHUB_INSTALLATION_NOT_FOUND');
      }
      throw new GithubAppError(`Failed to fetch installation status (${res.status}).`, 'GITHUB_API_ERROR');
    }

    const data = await res.json();
    return {
      id: data.id,
      account: data.account?.login || 'unknown',
      repositorySelection: data.repository_selection || 'all',
      targetType: data.target_type || 'User'
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parses the GITHUB_ALLOWED_ACCOUNT_IDS environment variable.
 * Fails closed if empty or malformed.
 */
function parseAllowedAccountIds(options = {}) {
  const raw = options.allowedAccountIds !== undefined
    ? options.allowedAccountIds
    : process.env.GITHUB_ALLOWED_ACCOUNT_IDS;

  if (!raw || typeof raw !== 'string' || raw.trim().length === 0) {
    return new Set();
  }

  const ids = new Set();
  const tokens = raw.split(',');
  for (const token of tokens) {
    const trimmed = token.trim();
    if (!trimmed) continue;
    if (!/^[1-9]\d*$/.test(trimmed)) {
      throw new GithubAppError(
        `Invalid account ID "${trimmed}" in GITHUB_ALLOWED_ACCOUNT_IDS. Expected comma-separated positive integers.`,
        'GITHUB_APP_INVALID_ID'
      );
    }
    ids.add(trimmed);
  }
  return ids;
}

/**
 * Checks whether an account ID is authorized by the allowlist.
 * Fails closed (returns false) if the allowlist is empty or unconfigured.
 */
function isAccountAllowlisted(accountId, options = {}) {
  if (accountId === undefined || accountId === null) return false;
  const allowedSet = parseAllowedAccountIds(options);
  if (allowedSet.size === 0) {
    return false;
  }
  return allowedSet.has(String(accountId).trim());
}

/**
 * Retrieves authenticated GitHub App metadata using the App JWT.
 * Constructs the verified installation URL strictly from the verified App slug.
 */
async function getAuthenticatedAppInfo(options = {}) {
  const appJwt = createAppJwt(options);
  const url = `${GITHUB_API_BASE}/app`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform'
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new GithubAppError(`Network error communicating with GitHub API: ${err.message}`, 'GITHUB_API_TIMEOUT');
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GithubAppError('Unexpected HTTP redirect received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAppError('GitHub App authentication failed. Check App ID and Private Key.', 'GITHUB_AUTH_FAILED');
    }
    throw new GithubAppError(`Failed to fetch GitHub App identity (${response.status}).`, 'GITHUB_API_ERROR');
  }

  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    throw new GithubAppError('Failed to read response body from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (rawText.length > MAX_RESPONSE_BYTES) {
    throw new GithubAppError('GitHub API response exceeded maximum permitted size bounds.', 'GITHUB_INVALID_RESPONSE');
  }

  let data = {};
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new GithubAppError('Invalid JSON response received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (!data.id || !data.slug || !data.name) {
    throw new GithubAppError('Malformed GitHub App metadata received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  const slug = String(data.slug);

  return {
    id: String(data.id),
    name: String(data.name),
    slug,
    htmlUrl: `https://github.com/apps/${slug}`,
    installUrl: `https://github.com/apps/${slug}/installations/new`
  };
}

/**
 * Lists installations of the authenticated GitHub App with pagination and allowlist evaluation.
 */
async function listAppInstallations(options = {}) {
  const appJwt = createAppJwt(options);

  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(options.limit || options.perPage, 10) || 30));

  const url = `${GITHUB_API_BASE}/app/installations?per_page=${perPage}&page=${page}`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${appJwt}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform'
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new GithubAppError(`Network error communicating with GitHub API: ${err.message}`, 'GITHUB_API_TIMEOUT');
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GithubAppError('Unexpected HTTP redirect received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (!response.ok) {
    if (response.status === 401) {
      throw new GithubAppError('GitHub App authentication failed. Check App ID and Private Key.', 'GITHUB_AUTH_FAILED');
    }
    if (response.status === 429) {
      throw new GithubAppError('GitHub API rate limit exceeded.', 'GITHUB_RATE_LIMITED');
    }
    throw new GithubAppError(`Failed to fetch installations (${response.status}).`, 'GITHUB_API_ERROR');
  }

  let rawText = '';
  try {
    rawText = await response.text();
  } catch {
    throw new GithubAppError('Failed to read response body from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  if (rawText.length > MAX_RESPONSE_BYTES) {
    throw new GithubAppError('GitHub API response exceeded maximum permitted size bounds.', 'GITHUB_INVALID_RESPONSE');
  }

  let data = [];
  try {
    data = JSON.parse(rawText);
  } catch {
    throw new GithubAppError('Invalid JSON response received from GitHub API.', 'GITHUB_INVALID_RESPONSE');
  }

  const items = Array.isArray(data) ? data : Array.isArray(data.installations) ? data.installations : [];
  const allowedAccountIds = parseAllowedAccountIds(options);

  const sanitized = items.map((item) => {
    const isSuspended = Boolean(item.suspended_at || item.suspended_by);
    const accountId = String(item.account?.id || '');
    const isAllowlisted = allowedAccountIds.size > 0 && allowedAccountIds.has(accountId);

    let status = isSuspended ? 'suspended' : 'active';
    if (!isSuspended && allowedAccountIds.size > 0 && !isAllowlisted) {
      status = 'not_allowlisted';
    }

    return {
      installation_id: String(item.id),
      account_id: accountId,
      account_login: item.account?.login || 'unknown',
      account_type: item.account?.type || 'User',
      repository_selection: item.repository_selection || 'selected',
      installation_status: status,
      is_allowlisted: isAllowlisted,
      suspended: isSuspended
    };
  });

  return {
    data: sanitized,
    pagination: {
      page,
      limit: perPage,
      total: sanitized.length
    }
  };
}

module.exports = {
  isGithubAppConfigured,
  createAppJwt,
  getInstallationAccessToken,
  getDiscoveryInstallationToken,
  getInstallationStatus,
  getAuthenticatedAppInfo,
  listAppInstallations,
  parseAllowedAccountIds,
  isAccountAllowlisted,
  getAppId,
  getPrivateKey,
  base64UrlEncode,
  GithubAppError,
  GITHUB_API_BASE,
  GITHUB_API_VERSION
};
