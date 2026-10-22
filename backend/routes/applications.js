const express = require('express');
const {
  createApplication,
  getApplicationById,
  listApplications,
  updateApplication,
  ApplicationServiceError
} = require('../services/applicationService');
const githubRepositoryService = require('../services/githubRepositoryService');
const { GithubRepositoryError } = githubRepositoryService;
const { getDatabase } = require('../config/database');
const { runMigrations } = require('../db/migrate');

const router = express.Router();

let isDbInitialized = false;

/**
 * Ensures database migrations have been executed before handling application requests.
 * Runs migrations lazily on the first request and caches initialization state.
 */
function ensureDatabaseReady() {
  if (isDbInitialized) return;
  try {
    const db = getDatabase();
    runMigrations(db);
    isDbInitialized = true;
  } catch (err) {
    console.error('[Application Router DB Init Error]', err);
    throw new ApplicationServiceError('Database storage is currently unavailable.', 'DATABASE_ERROR');
  }
}

/**
 * Maps service-level errors to structured HTTP JSON error responses.
 */
function sendErrorResponse(res, err) {
  if (err instanceof ApplicationServiceError || err instanceof GithubRepositoryError) {
    const statusMap = {
      VALIDATION_ERROR: 400,
      APPLICATION_NOT_FOUND: 404,
      DUPLICATE_SLUG: 409,
      DATABASE_ERROR: 500,
      INSTALLATION_NOT_FOUND: 404,
      INSTALLATION_SUSPENDED: 403,
      INSTALLATION_NOT_VERIFIED: 403,
      REPOSITORY_NOT_FOUND: 404,
      REPOSITORY_NOT_AUTHORIZED: 403,
      REPOSITORY_ID_MISMATCH: 400,
      REPOSITORY_IDENTITY_MISMATCH: 400,
      APPLICATION_REPOSITORY_CHANGED: 409,
      ASSOCIATION_CONFLICT: 409,
      GITHUB_API_ERROR: 502
    };
    const statusCode = statusMap[err.code] || 400;
    return res.status(statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details || null
      }
    });
  }

  // Fallback for unexpected internal errors without leaking internals
  console.error('[Application Router Unhandled Error]', err);
  return res.status(500).json({
    error: {
      code: 'INTERNAL_ERROR',
      message: 'An unexpected internal error occurred.'
    }
  });
}

/**
 * CSRF and Origin check middleware for state-changing operations.
 * Validates that Origin or Referer header matches the host for cookie-authenticated mutation requests.
 */
function verifySameOrigin(req, res, next) {
  const originHeader = req.headers.origin || req.headers.referer;
  const hostHeader = req.headers.host;

  if (originHeader && hostHeader) {
    try {
      const parsedOrigin = new URL(originHeader);
      if (parsedOrigin.host.toLowerCase() !== hostHeader.toLowerCase()) {
        return res.status(403).json({
          error: {
            code: 'CSRF_REJECTED',
            message: 'Cross-origin mutation request rejected.'
          }
        });
      }
    } catch {
      return res.status(403).json({
        error: {
          code: 'CSRF_REJECTED',
          message: 'Malformed origin header.'
        }
      });
    }
  }
  next();
}

/**
 * GET /api/applications
 * Returns a paginated list of applications.
 */
router.get('/', (req, res) => {
  try {
    // Validate pagination parameters at HTTP layer
    let page = 1;
    let limit = 20;

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

    ensureDatabaseReady();
    const result = listApplications({ page, limit });
    return res.json(result);
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * POST /api/applications
 * Creates a new application record.
 */
router.post('/', (req, res) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a valid JSON object.'
        }
      });
    }

    ensureDatabaseReady();
    const created = createApplication(req.body);
    return res.status(201).json({
      data: created
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * GET /api/applications/:id
 * Retrieves an application by UUID.
 */
router.get('/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Application ID parameter is required.'
        }
      });
    }

    ensureDatabaseReady();
    const application = getApplicationById(id.trim());

    if (!application) {
      return res.status(404).json({
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: `Application with ID "${id}" was not found.`
        }
      });
    }

    return res.json({
      data: application
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * PUT /api/applications/:id
 * Updates editable fields of an existing application.
 */
router.put('/:id', (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Application ID parameter is required.'
        }
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a non-empty JSON object.'
        }
      });
    }

    ensureDatabaseReady();
    const updated = updateApplication(id.trim(), req.body);

    return res.json({
      data: updated
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * GET /api/applications/:id/github-repository
 * Returns verified GitHub repository association metadata for an application.
 */
router.get('/:id/github-repository', (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Application ID parameter is required.'
        }
      });
    }

    ensureDatabaseReady();
    const app = getApplicationById(id.trim());
    if (!app) {
      return res.status(404).json({
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: `Application with ID "${id}" was not found.`
        }
      });
    }

    const association = githubRepositoryService.getApplicationRepositoryAssociation(id.trim());
    if (!association) {
      return res.status(404).json({
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: 'No active repository association found for this application.'
        }
      });
    }

    return res.json({
      data: association
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * POST /api/applications/:id/github-repository
 * Associates an application with an authorized, verified GitHub App repository.
 */
router.post('/:id/github-repository', verifySameOrigin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Application ID parameter is required.'
        }
      });
    }

    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request body must be a valid JSON object.'
        }
      });
    }

    const { installation_id, repository_id } = req.body;
    if (!installation_id || !repository_id) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Both installation_id and repository_id are required to associate repository.'
        }
      });
    }

    ensureDatabaseReady();
    const app = getApplicationById(id.trim());
    if (!app) {
      return res.status(404).json({
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: `Application with ID "${id}" was not found.`
        }
      });
    }

    const association = await githubRepositoryService.associateApplicationRepository({
      applicationId: id.trim(),
      installationId: installation_id,
      repositoryId: repository_id
    });

    return res.json({
      data: association
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

/**
 * DELETE /api/applications/:id/github-repository
 * Deactivates repository association for an application.
 */
router.delete('/:id/github-repository', verifySameOrigin, (req, res) => {
  try {
    const { id } = req.params;
    if (!id || typeof id !== 'string' || id.trim().length === 0) {
      return res.status(400).json({
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Application ID parameter is required.'
        }
      });
    }

    ensureDatabaseReady();
    const app = getApplicationById(id.trim());
    if (!app) {
      return res.status(404).json({
        error: {
          code: 'APPLICATION_NOT_FOUND',
          message: `Application with ID "${id}" was not found.`
        }
      });
    }

    const unlinked = githubRepositoryService.disconnectApplicationRepository(id.trim());
    return res.json({
      success: true,
      unlinked,
      message: 'Repository unlinked successfully.'
    });
  } catch (err) {
    return sendErrorResponse(res, err);
  }
});

// Helper for testing to reset cached initialization flag
router.resetInitState = () => {
  isDbInitialized = false;
};

module.exports = router;
