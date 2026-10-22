const express = require('express');
const githubAppService = require('../services/githubAppService');
const githubRepositoryService = require('../services/githubRepositoryService');
const { GithubAppError } = githubAppService;
const { GithubRepositoryError } = githubRepositoryService;

const router = express.Router();

/**
 * Maps GitHub App and repository service errors to structured HTTP JSON error responses.
 */
function sendErrorResponse(res, err) {
  if (err instanceof GithubAppError || err instanceof GithubRepositoryError) {
    const statusMap = {
      GITHUB_APP_NOT_CONFIGURED: 503,
      GITHUB_APP_INVALID_ID: 400,
      GITHUB_APP_INVALID_KEY: 500,
      GITHUB_INSTALLATION_NOT_FOUND: 404,
      INSTALLATION_NOT_FOUND: 404,
      INSTALLATION_SUSPENDED: 403,
      INSTALLATION_NOT_VERIFIED: 403,
      REPOSITORY_NOT_FOUND: 404,
      REPOSITORY_NOT_AUTHORIZED: 403,
      REPOSITORY_ID_MISMATCH: 400,
      REPOSITORY_IDENTITY_MISMATCH: 400,
      APPLICATION_NOT_FOUND: 404,
      APPLICATION_REPOSITORY_CHANGED: 409,
      GITHUB_PERMISSION_DENIED: 403,
      GITHUB_AUTH_FAILED: 502,
      GITHUB_API_TIMEOUT: 504,
      GITHUB_RATE_LIMITED: 429,
      GITHUB_INVALID_RESPONSE: 502,
      GITHUB_API_ERROR: 502,
      DATABASE_ERROR: 500
    };
    const statusCode = statusMap[err.code] || 500;
    return res.status(statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || null
      }
    });
  }

  console.error('[GitHub API Route Error]', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred while communicating with GitHub services.'
    }
  });
}

/**
 * GET /api/github/status
 * Returns sanitized configuration status of GitHub App identity and account allowlist.
 */
router.get('/status', async (req, res) => {
  try {
    const isConfigured = githubAppService.isGithubAppConfigured();
    const allowedAccounts = githubAppService.parseAllowedAccountIds();
    const allowlistConfigured = allowedAccounts.size > 0;

    let appInfo = null;
    if (isConfigured) {
      try {
        const info = await githubAppService.getAuthenticatedAppInfo();
        appInfo = {
          id: info.id,
          name: info.name,
          slug: info.slug
        };
      } catch (err) {
        // App identity could not be verified with GitHub API
        appInfo = null;
      }
    }

    return res.json({
      configured: isConfigured,
      allowlistConfigured,
      app: appInfo
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * GET /api/github/install-url
 * Returns verified installation URL derived strictly from authenticated GitHub App slug.
 */
router.get('/install-url', async (req, res) => {
  try {
    if (!githubAppService.isGithubAppConfigured()) {
      return res.status(503).json({
        error: {
          code: 'GITHUB_APP_NOT_CONFIGURED',
          message: 'GitHub App identity is not configured on this server.'
        }
      });
    }

    const appInfo = await githubAppService.getAuthenticatedAppInfo();
    return res.json({
      installUrl: appInfo.installUrl,
      slug: appInfo.slug
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * GET /api/github/installations
 * Returns paginated, sanitized list of installations for the configured GitHub App.
 */
router.get('/installations', async (req, res) => {
  try {
    if (!githubAppService.isGithubAppConfigured()) {
      return res.status(503).json({
        error: {
          code: 'GITHUB_APP_NOT_CONFIGURED',
          message: 'GitHub App identity is not configured on this server.'
        }
      });
    }

    let page = 1;
    let limit = 30;

    if (req.query.page !== undefined) {
      const pageStr = String(req.query.page).trim();
      if (!/^[1-9]\d*$/.test(pageStr)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'page' must be a positive integer."
          }
        });
      }
      page = parseInt(pageStr, 10);
    }

    if (req.query.limit !== undefined) {
      const limitStr = String(req.query.limit).trim();
      if (!/^[1-9]\d*$/.test(limitStr)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'limit' must be an integer between 1 and 100."
          }
        });
      }
      limit = parseInt(limitStr, 10);
      if (limit > 100) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'limit' must not exceed 100."
          }
        });
      }
    }

    const result = await githubAppService.listAppInstallations({ page, limit });
    return res.json(result);
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * GET /api/github/installations/:id/repositories
 * Lists authorized repositories accessible to an active, allowlisted GitHub App installation.
 */
router.get('/installations/:id/repositories', async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || !/^[1-9]\d*$/.test(String(id).trim())) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Installation ID parameter must be a positive integer.'
        }
      });
    }

    if (!githubAppService.isGithubAppConfigured()) {
      return res.status(503).json({
        error: {
          code: 'GITHUB_APP_NOT_CONFIGURED',
          message: 'GitHub App identity is not configured on this server.'
        }
      });
    }

    let page = 1;
    let limit = 30;

    if (req.query.page !== undefined) {
      const pageStr = String(req.query.page).trim();
      if (!/^[1-9]\d*$/.test(pageStr)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'page' must be a positive integer."
          }
        });
      }
      page = parseInt(pageStr, 10);
    }

    if (req.query.limit !== undefined) {
      const limitStr = String(req.query.limit).trim();
      if (!/^[1-9]\d*$/.test(limitStr)) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'limit' must be an integer between 1 and 100."
          }
        });
      }
      limit = parseInt(limitStr, 10);
      if (limit > 100) {
        return res.status(400).json({
          error: {
            code: 'VALIDATION_ERROR',
            message: "Query parameter 'limit' must not exceed 100."
          }
        });
      }
    }

    const result = await githubRepositoryService.listInstallationRepositories(id.trim(), { page, limit });
    return res.json(result);
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

module.exports = router;
