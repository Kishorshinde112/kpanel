const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const { getApplicationById } = require('./applicationService');
const { validateRepositoryUrl } = require('./gitService');
const githubAppService = require('./githubAppService');

/**
 * Structured error class for GitHub repository associations.
 */
class GithubRepositoryError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'GithubRepositoryError';
    this.code = code;
    this.details = details;
  }
}

const GITHUB_API_BASE = 'https://api.github.com';
const GITHUB_API_VERSION = '2022-11-28';
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Verifies that a GitHub App installation is valid and active using the App JWT.
 * Rejects suspended installations or missing accounts.
 */
async function verifyInstallation(installationId, options = {}) {
  if (installationId === undefined || installationId === null || String(installationId).trim().length === 0) {
    throw new GithubRepositoryError('Installation ID is required.', 'INSTALLATION_NOT_FOUND');
  }

  const instIdStr = String(installationId).trim();
  if (!/^[1-9]\d*$/.test(instIdStr)) {
    throw new GithubRepositoryError(`Invalid installation ID "${instIdStr}". Expected positive integer.`, 'INSTALLATION_NOT_FOUND');
  }

  const appJwt = githubAppService.createAppJwt(options);
  const url = `${GITHUB_API_BASE}/app/installations/${encodeURIComponent(instIdStr)}`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;

  if (typeof fetchFn !== 'function') {
    throw new GithubRepositoryError('HTTP fetch capability is not available in current runtime.', 'GITHUB_API_ERROR');
  }

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
    throw new GithubRepositoryError(`Failed to communicate with GitHub API: ${err.message}`, 'GITHUB_API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    throw new GithubRepositoryError(`GitHub App installation "${instIdStr}" was not found.`, 'INSTALLATION_NOT_FOUND');
  }

  if (!response.ok) {
    throw new GithubRepositoryError(`GitHub API rejected installation verification (${response.status}).`, 'GITHUB_API_ERROR');
  }

  const data = await response.json();

  // Reject suspended installations
  if (data.suspended_at || data.suspended_by) {
    throw new GithubRepositoryError(
      `GitHub App installation "${instIdStr}" is suspended.`,
      'INSTALLATION_SUSPENDED',
      { suspendedAt: data.suspended_at }
    );
  }

  if (!data.id || !data.account || !data.account.login) {
    throw new GithubRepositoryError('Malformed installation metadata received from GitHub API.', 'INSTALLATION_NOT_VERIFIED');
  }

  const accountId = String(data.account.id);

  // Enforce account allowlist policy (fail-closed if unallowlisted or unconfigured)
  if (options.enforceAllowlist !== false) {
    if (!githubAppService.isAccountAllowlisted(accountId, options)) {
      throw new GithubRepositoryError(
        `GitHub account "${data.account.login}" (${accountId}) is not in the approved GITHUB_ALLOWED_ACCOUNT_IDS allowlist.`,
        'REPOSITORY_NOT_AUTHORIZED',
        { accountId, accountLogin: data.account.login }
      );
    }
  }

  return {
    installationId: String(data.id),
    accountId,
    accountLogin: String(data.account.login),
    accountType: data.account.type || 'User',
    repositorySelection: data.repository_selection || 'selected',
    installationStatus: 'active',
    verifiedAt: new Date().toISOString()
  };
}

/**
 * Verifies that the GitHub App installation has authorized access to the specific repository.
 * Scopes an installation token strictly to the target repository and confirms accessibility via GET /installation/repositories.
 */
async function verifyRepositoryAccess(installationId, repositoryId, repoUrl, options = {}) {
  const repoInfo = validateRepositoryUrl(repoUrl, options);

  if (repositoryId === undefined || repositoryId === null || String(repositoryId).trim().length === 0) {
    throw new GithubRepositoryError('Repository ID is required.', 'REPOSITORY_NOT_FOUND');
  }

  const repoIdStr = String(repositoryId).trim();
  if (!/^[1-9]\d*$/.test(repoIdStr)) {
    throw new GithubRepositoryError(`Invalid repository ID "${repoIdStr}". Expected positive integer.`, 'REPOSITORY_NOT_FOUND');
  }

  // Obtain short-lived token scoped strictly to this repository ID
  let tokenResult;
  try {
    tokenResult = await githubAppService.getInstallationAccessToken(installationId, {
      ...options,
      repository_ids: [Number(repoIdStr)],
      permissions: { contents: 'read' }
    });
  } catch (err) {
    if (err instanceof githubAppService.GithubAppError) {
      if (err.code === 'GITHUB_INSTALLATION_NOT_FOUND') {
        throw new GithubRepositoryError(err.message, 'INSTALLATION_NOT_FOUND');
      }
      if (err.code === 'GITHUB_PERMISSION_DENIED') {
        throw new GithubRepositoryError('GitHub App installation is not authorized for the requested repository.', 'REPOSITORY_NOT_AUTHORIZED');
      }
    }
    throw new GithubRepositoryError(`Failed to verify repository token: ${err.message}`, 'GITHUB_API_ERROR');
  }

  // Query installation repositories accessible to this token
  const url = `${GITHUB_API_BASE}/installation/repositories`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${tokenResult.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform'
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new GithubRepositoryError(`Failed to query installation repositories: ${err.message}`, 'GITHUB_API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new GithubRepositoryError(`GitHub API rejected repository listing with status ${response.status}.`, 'GITHUB_API_ERROR');
  }

  const data = await response.json();
  const repos = Array.isArray(data.repositories) ? data.repositories : [];

  // Match target repository by durable numeric ID
  const matchedRepo = repos.find((r) => String(r.id) === repoIdStr);
  if (!matchedRepo) {
    throw new GithubRepositoryError(
      `Repository ID "${repoIdStr}" is not accessible by GitHub App installation "${installationId}".`,
      'REPOSITORY_NOT_AUTHORIZED'
    );
  }

  // Verify owner and repo name match application repository URL
  const verifiedOwner = matchedRepo.owner?.login || '';
  const verifiedName = matchedRepo.name || '';

  if (verifiedOwner.toLowerCase() !== repoInfo.owner.toLowerCase() || verifiedName.toLowerCase() !== repoInfo.repo.toLowerCase()) {
    throw new GithubRepositoryError(
      `Repository identity mismatch: GitHub repository "${matchedRepo.full_name}" does not match configured URL "${repoInfo.normalizedUrl}".`,
      'REPOSITORY_IDENTITY_MISMATCH',
      {
        expected: `${repoInfo.owner}/${repoInfo.repo}`,
        actual: matchedRepo.full_name
      }
    );
  }

  return {
    installationId: String(installationId),
    repositoryId: repoIdStr,
    repositoryOwner: verifiedOwner,
    repositoryName: verifiedName,
    repositoryFullName: matchedRepo.full_name || `${verifiedOwner}/${verifiedName}`,
    repositoryPrivate: Boolean(matchedRepo.private),
    verifiedAt: new Date().toISOString()
  };
}

/**
 * Associates an application with an authorized, verified GitHub App installation.
 * Transactional: atomically upserts installation and application_repositories records in SQLite.
 *
 * @param {Object} input - { applicationId, installationId, repositoryId }
 * @param {Object} options - Options including database and transport
 * @returns {Promise<Object>} Verified association record
 */
async function associateApplicationRepository(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new GithubRepositoryError('Input object is required.', 'DATABASE_ERROR');
  }

  const { applicationId, installationId, repositoryId } = input;

  if (!applicationId || !UUID_REGEX.test(String(applicationId).trim())) {
    throw new GithubRepositoryError('Valid application UUID is required.', 'APPLICATION_NOT_FOUND');
  }

  const db = options.db || getDatabase(options);

  // 1. Load application
  const app = getApplicationById(applicationId, { db });
  if (!app) {
    throw new GithubRepositoryError(`Application with ID "${applicationId}" was not found.`, 'APPLICATION_NOT_FOUND');
  }

  // 2. Perform external verification before acquiring database lock
  const verifiedInstallation = await verifyInstallation(installationId, options);
  const verifiedRepo = await verifyRepositoryAccess(installationId, repositoryId, app.repo_url, options);

  // 3. Atomically persist association inside a transaction
  const persistTx = db.transaction(() => {
    // Re-verify application inside transaction to protect against concurrent repo_url updates
    const currentApp = getApplicationById(applicationId, { db });
    if (!currentApp) {
      throw new GithubRepositoryError(`Application with ID "${applicationId}" was removed.`, 'APPLICATION_NOT_FOUND');
    }
    if (currentApp.repo_url !== app.repo_url) {
      throw new GithubRepositoryError(
        'Application repository URL was updated during verification. Association aborted.',
        'APPLICATION_REPOSITORY_CHANGED'
      );
    }

    // Upsert github_installations
    db.prepare(`
      INSERT INTO github_installations (
        installation_id, account_id, account_login, account_type, repository_selection, installation_status, last_verified_at, updated_at
      ) VALUES (
        @installation_id, @account_id, @account_login, @account_type, @repository_selection, @installation_status, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(installation_id) DO UPDATE SET
        account_id = excluded.account_id,
        account_login = excluded.account_login,
        account_type = excluded.account_type,
        repository_selection = excluded.repository_selection,
        installation_status = excluded.installation_status,
        last_verified_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      installation_id: verifiedInstallation.installationId,
      account_id: verifiedInstallation.accountId,
      account_login: verifiedInstallation.accountLogin,
      account_type: verifiedInstallation.accountType,
      repository_selection: verifiedInstallation.repositorySelection,
      installation_status: verifiedInstallation.installationStatus
    });

    // Upsert application_repositories
    db.prepare(`
      INSERT INTO application_repositories (
        application_id, installation_id, repository_id, repository_owner, repository_name, repository_full_name, repository_private, association_status, verified_at, updated_at
      ) VALUES (
        @application_id, @installation_id, @repository_id, @repository_owner, @repository_name, @repository_full_name, @repository_private, 'verified', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
      ON CONFLICT(application_id) DO UPDATE SET
        installation_id = excluded.installation_id,
        repository_id = excluded.repository_id,
        repository_owner = excluded.repository_owner,
        repository_name = excluded.repository_name,
        repository_full_name = excluded.repository_full_name,
        repository_private = excluded.repository_private,
        association_status = 'verified',
        verified_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      application_id: applicationId.trim(),
      installation_id: verifiedInstallation.installationId,
      repository_id: verifiedRepo.repositoryId,
      repository_owner: verifiedRepo.repositoryOwner,
      repository_name: verifiedRepo.repositoryName,
      repository_full_name: verifiedRepo.repositoryFullName,
      repository_private: verifiedRepo.repositoryPrivate ? 1 : 0
    });
  });

  try {
    persistTx();
  } catch (err) {
    if (err instanceof GithubRepositoryError) throw err;
    throw new GithubRepositoryError(`Database transaction failed: ${err.message}`, 'DATABASE_ERROR');
  }

  return getApplicationRepositoryAssociation(applicationId, { db });
}

/**
 * Retrieves the persisted association metadata for an application.
 * Verifies that the stored association remains consistent with the current repo_url.
 */
function getApplicationRepositoryAssociation(applicationId, options = {}) {
  if (!applicationId || typeof applicationId !== 'string') return null;

  const db = options.db || getDatabase(options);

  const row = db.prepare(`
    SELECT
      ar.application_id,
      ar.installation_id,
      ar.repository_id,
      ar.repository_owner,
      ar.repository_name,
      ar.repository_full_name,
      ar.repository_private,
      ar.association_status,
      ar.verified_at,
      ar.created_at,
      ar.updated_at,
      gi.account_login,
      gi.installation_status,
      a.repo_url as current_app_repo_url
    FROM application_repositories ar
    JOIN applications a ON ar.application_id = a.id
    JOIN github_installations gi ON ar.installation_id = gi.installation_id
    WHERE ar.application_id = ?
  `).get(applicationId.trim());

  if (!row) {
    return null;
  }

  if (row.association_status === 'disconnected') {
    return null;
  }

  // Consistency check: Ensure application repo_url has not drifted from verified association
  try {
    const currentUrlInfo = validateRepositoryUrl(row.current_app_repo_url, options);
    const ownerMatches = currentUrlInfo.owner.toLowerCase() === row.repository_owner.toLowerCase();
    const repoMatches = currentUrlInfo.repo.toLowerCase() === row.repository_name.toLowerCase();

    if (!ownerMatches || !repoMatches) {
      throw new GithubRepositoryError(
        'Application repository URL has been modified since association was verified. Re-verification required.',
        'APPLICATION_REPOSITORY_CHANGED',
        {
          configuredUrl: row.current_app_repo_url,
          associatedRepo: row.repository_full_name
        }
      );
    }
  } catch (err) {
    if (err instanceof GithubRepositoryError) throw err;
    throw new GithubRepositoryError(
      'Application repository URL is invalid or has changed. Association is invalid.',
      'APPLICATION_REPOSITORY_CHANGED'
    );
  }

  return {
    applicationId: row.application_id,
    installationId: row.installation_id,
    repositoryId: row.repository_id,
    repositoryOwner: row.repository_owner,
    repositoryName: row.repository_name,
    repositoryFullName: row.repository_full_name,
    repositoryPrivate: Boolean(row.repository_private),
    associationStatus: row.association_status,
    accountLogin: row.account_login,
    installationStatus: row.installation_status,
    verifiedAt: row.verified_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Disconnects an application's GitHub repository association.
 * Deactivates association only; preserves application, deployment history, and installation records.
 */
function disconnectApplicationRepository(applicationId, options = {}) {
  if (!applicationId || typeof applicationId !== 'string') return false;

  const db = options.db || getDatabase(options);

  const result = db.prepare(`
    UPDATE application_repositories
    SET association_status = 'disconnected', updated_at = CURRENT_TIMESTAMP
    WHERE application_id = ?
  `).run(applicationId.trim());

  return result.changes > 0;
}

/**
 * Resolves the authenticated Git checkout authorization context for an application.
 * Connects the persistent application_repositories association to gitService.fetchRepository.
 *
 * @param {string} applicationId - Application UUID
 * @param {Object} options - Database and execution options
 * @returns {Object} Checkout authorization options ({ authMode: 'github-app', ... } or { authMode: 'public' })
 */
function resolveApplicationCheckoutAuth(applicationId, options = {}) {
  if (!applicationId || typeof applicationId !== 'string') {
    throw new GithubRepositoryError('Valid application UUID is required to resolve checkout authorization.', 'APPLICATION_NOT_FOUND');
  }

  const db = options.db || getDatabase(options);

  // Look up verified association
  const assoc = getApplicationRepositoryAssociation(applicationId, { ...options, db });

  // If no association exists, fallback to public anonymous checkout
  if (!assoc) {
    return {
      authMode: 'public'
    };
  }

  // Reject suspended installations
  if (assoc.installationStatus !== 'active') {
    throw new GithubRepositoryError(
      `GitHub App installation "${assoc.installationId}" is ${assoc.installationStatus}. Cannot authorize checkout.`,
      'INSTALLATION_SUSPENDED'
    );
  }

  // Reject unverified or disconnected associations
  if (assoc.associationStatus !== 'verified') {
    throw new GithubRepositoryError(
      `Application repository association status is "${assoc.associationStatus}". Re-verification required.`,
      'REPOSITORY_NOT_AUTHORIZED'
    );
  }

  // Enforce account allowlist policy (fail-closed if account was removed from allowlist)
  if (options.enforceAllowlist !== false) {
    const instRow = db.prepare('SELECT account_id FROM github_installations WHERE installation_id = ?').get(assoc.installationId);
    const accountId = instRow?.account_id;
    if (!accountId || !githubAppService.isAccountAllowlisted(accountId, options)) {
      throw new GithubRepositoryError(
        `GitHub installation account (${accountId || 'unknown'}) is not in the approved GITHUB_ALLOWED_ACCOUNT_IDS allowlist. Private checkout unauthorized.`,
        'REPOSITORY_NOT_AUTHORIZED',
        { accountId }
      );
    }
  }

  return {
    authMode: 'github-app',
    installationId: assoc.installationId,
    repositoryId: assoc.repositoryId,
    repositoryName: assoc.repositoryName,
    repositoryOwner: assoc.repositoryOwner,
    isPrivate: assoc.repositoryPrivate
  };
}

/**
 * Lists authorized repositories for a verified, allowlisted GitHub App installation.
 * Uses getDiscoveryInstallationToken to ensure minimal permissions.
 */
async function listInstallationRepositories(installationId, options = {}) {
  // 1. Verify installation is active, valid, and allowlisted
  const verifiedInst = await verifyInstallation(installationId, options);

  // 2. Obtain discovery token (metadata read only)
  let tokenResult;
  try {
    tokenResult = await githubAppService.getDiscoveryInstallationToken(installationId, options);
  } catch (err) {
    if (err instanceof githubAppService.GithubAppError) {
      throw new GithubRepositoryError(err.message, err.code, err.details);
    }
    throw new GithubRepositoryError(`Failed to authenticate repository discovery: ${err.message}`, 'GITHUB_API_ERROR');
  }

  const page = Math.max(1, parseInt(options.page, 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(options.limit || options.perPage, 10) || 30));

  const url = `${GITHUB_API_BASE}/installation/repositories?per_page=${perPage}&page=${page}`;
  const fetchFn = options.fetch || options.transport || globalThis.fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeout || 15000);

  let response;
  try {
    response = await fetchFn(url, {
      method: 'GET',
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${tokenResult.token}`,
        'X-GitHub-Api-Version': GITHUB_API_VERSION,
        'User-Agent': 'K-Panel-DevOps-Platform'
      },
      redirect: 'manual',
      signal: controller.signal
    });
  } catch (err) {
    clearTimeout(timer);
    throw new GithubRepositoryError(`Failed to fetch repositories from GitHub API: ${err.message}`, 'GITHUB_API_ERROR');
  } finally {
    clearTimeout(timer);
  }

  if (response.status >= 300 && response.status < 400) {
    throw new GithubRepositoryError('Unexpected HTTP redirect received from GitHub API.', 'GITHUB_API_ERROR');
  }

  if (!response.ok) {
    throw new GithubRepositoryError(`GitHub API rejected repository listing (${response.status}).`, 'GITHUB_API_ERROR');
  }

  const data = await response.json();
  const rawRepos = Array.isArray(data.repositories) ? data.repositories : [];

  const sanitized = rawRepos.map((r) => ({
    repository_id: String(r.id),
    repository_owner: r.owner?.login || '',
    repository_name: r.name || '',
    repository_full_name: r.full_name || `${r.owner?.login}/${r.name}`,
    repository_private: Boolean(r.private),
    installation_id: String(installationId),
    html_url: r.html_url || `https://github.com/${r.full_name}`
  }));

  return {
    data: sanitized,
    pagination: {
      page,
      limit: perPage,
      total: data.total_count !== undefined ? data.total_count : sanitized.length
    }
  };
}

module.exports = {
  verifyInstallation,
  verifyRepositoryAccess,
  associateApplicationRepository,
  getApplicationRepositoryAssociation,
  disconnectApplicationRepository,
  resolveApplicationCheckoutAuth,
  listInstallationRepositories,
  GithubRepositoryError
};
