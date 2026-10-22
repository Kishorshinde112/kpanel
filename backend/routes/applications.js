const express = require('express');
const {
  createApplication,
  getApplicationById,
  listApplications,
  updateApplication,
  ApplicationServiceError
} = require('../services/applicationService');
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
  if (err instanceof ApplicationServiceError) {
    const statusMap = {
      VALIDATION_ERROR: 400,
      APPLICATION_NOT_FOUND: 404,
      DUPLICATE_SLUG: 409,
      DATABASE_ERROR: 500
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

// Helper for testing to reset cached initialization flag
router.resetInitState = () => {
  isDbInitialized = false;
};

module.exports = router;
