const express = require('express');
const githubWebhookService = require('../services/githubWebhookService');
const { GithubWebhookError } = githubWebhookService;
const { getDatabase } = require('../config/database');
const { runMigrations } = require('../db/migrate');

const router = express.Router();

let isDbInitialized = false;

function ensureDatabaseReady() {
  if (isDbInitialized) return;
  try {
    const db = getDatabase();
    runMigrations(db);
    isDbInitialized = true;
  } catch (err) {
    console.error('[Webhooks Router DB Init Error]', err);
    throw new GithubWebhookError('Database storage is currently unavailable.', 'DATABASE_ERROR');
  }
}

/**
 * Route-specific parser: raw JSON buffer up to 1 MB.
 * Preserves the exact bytes required for cryptographic HMAC-SHA256 verification.
 */
const rawJsonParser = express.raw({
  type: 'application/json',
  limit: '1mb'
});

/**
 * POST /api/webhooks/github
 * Secure GitHub Webhook Ingress Endpoint.
 */
router.post('/github', (req, res, next) => {
  // Enforce Content-Type: application/json
  const contentType = req.headers['content-type'] || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return res.status(415).json({
      error: {
        code: 'UNSUPPORTED_MEDIA_TYPE',
        message: 'Unsupported content type. Expected application/json.'
      }
    });
  }

  // Parse raw body buffer
  rawJsonParser(req, res, async (err) => {
    if (err) {
      if (err.type === 'entity.too.large' || err.status === 413) {
        return res.status(413).json({
          error: {
            code: 'PAYLOAD_TOO_LARGE',
            message: 'Webhook payload exceeds maximum size limit (1MB).'
          }
        });
      }
      return res.status(400).json({
        error: {
          code: 'INVALID_PAYLOAD',
          message: 'Failed to process request payload bytes.'
        }
      });
    }

    try {
      const secret = githubWebhookService.getWebhookSecret();
      if (!secret) {
        return res.status(503).json({
          error: {
            code: 'WEBHOOK_SECRET_NOT_CONFIGURED',
            message: 'GitHub Webhook Secret is not configured on this server.'
          }
        });
      }

      const signatureHeader = req.headers['x-hub-signature-256'];
      const rawBody = req.body;

      // 1. Cryptographic HMAC-SHA256 signature verification
      try {
        githubWebhookService.verifyWebhookSignature(rawBody, signatureHeader, secret);
      } catch (sigErr) {
        return res.status(401).json({
          error: {
            code: sigErr.code || 'INVALID_SIGNATURE',
            message: sigErr.message || 'Invalid webhook signature.'
          }
        });
      }

      // 2. Validate X-GitHub-Delivery header
      const deliveryHeader = req.headers['x-github-delivery'];
      let deliveryId;
      try {
        deliveryId = githubWebhookService.validateDeliveryId(deliveryHeader);
      } catch (delErr) {
        return res.status(400).json({
          error: {
            code: delErr.code || 'MALFORMED_DELIVERY_ID',
            message: delErr.message
          }
        });
      }

      // 3. Evaluate X-GitHub-Event header
      const eventName = String(req.headers['x-github-event'] || '').toLowerCase();
      if (!eventName) {
        return res.status(400).json({
          error: {
            code: 'INVALID_PAYLOAD',
            message: 'Missing X-GitHub-Event header.'
          }
        });
      }

      ensureDatabaseReady();

      // Handle 'ping' event
      if (eventName === 'ping') {
        const pingRecord = githubWebhookService.recordWebhookDelivery({
          deliveryId,
          eventName: 'ping',
          rawBody,
          decision: 'accepted'
        });
        return res.status(200).json({
          status: 'ok',
          event: 'ping',
          deliveryId,
          message: 'Ping event acknowledged.'
        });
      }

      // Handle 'push' event
      if (eventName === 'push') {
        let payload;
        try {
          payload = githubWebhookService.parseWebhookJsonSafely(rawBody);
        } catch {
          return res.status(400).json({
            error: {
              code: 'INVALID_PAYLOAD',
              message: 'Malformed JSON payload in push event.'
            }
          });
        }

        const pushEvent = githubWebhookService.validatePushEvent(payload);

        // Check if event should be ignored (e.g. tag push, branch deleted)
        if (pushEvent.isIgnored) {
          githubWebhookService.recordWebhookDelivery({
            deliveryId,
            eventName: 'push',
            rawBody,
            ref: pushEvent.ref || null,
            decision: 'ignored'
          });
          return res.status(200).json({
            status: 'ignored',
            deliveryId,
            reason: pushEvent.reason
          });
        }

        // Find registered applications in SQLite that match this push event
        const matchedApps = githubWebhookService.findMatchingApplicationsForPush(pushEvent);

        if (matchedApps.length === 0) {
          githubWebhookService.recordWebhookDelivery({
            deliveryId,
            eventName: 'push',
            rawBody,
            installationId: pushEvent.installationId,
            repositoryId: pushEvent.repositoryId,
            ref: pushEvent.ref,
            commitSha: pushEvent.commitSha,
            decision: 'unmatched'
          });
          return res.status(200).json({
            status: 'unmatched',
            deliveryId,
            message: 'No registered applications matched this push event.'
          });
        }

        // Persist delivery and targets in inbox
        const recordResult = githubWebhookService.recordWebhookDelivery(
          {
            deliveryId,
            eventName: 'push',
            rawBody,
            installationId: pushEvent.installationId,
            repositoryId: pushEvent.repositoryId,
            ref: pushEvent.ref,
            commitSha: pushEvent.commitSha,
            decision: 'accepted'
          },
          matchedApps
        );

        if (recordResult.duplicate) {
          return res.status(200).json({
            status: 'duplicate',
            deliveryId,
            message: recordResult.message
          });
        }

        // 202 Accepted: Event persisted in inbox for future deployment worker
        return res.status(202).json({
          status: 'accepted',
          deliveryId,
          matchedApplications: matchedApps.length
        });
      }

      // Other event types safely ignored
      githubWebhookService.recordWebhookDelivery({
        deliveryId,
        eventName,
        rawBody,
        decision: 'ignored'
      });
      return res.status(200).json({
        status: 'ignored',
        event: eventName,
        message: `Event type "${eventName}" acknowledged and ignored.`
      });
    } catch (err) {
      if (err instanceof GithubWebhookError) {
        if (err.code === 'DELIVERY_CONFLICT') {
          return res.status(409).json({
            error: {
              code: err.code,
              message: err.message
            }
          });
        }
        if (err.code === 'DATABASE_ERROR') {
          return res.status(503).json({
            error: {
              code: err.code,
              message: 'Database storage is currently unavailable.'
            }
          });
        }
        return res.status(400).json({
          error: {
            code: err.code,
            message: err.message
          }
        });
      }

      console.error('[GitHub Webhook Ingress Error]', err);
      return res.status(500).json({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'An unexpected internal error occurred.'
        }
      });
    }
  });
});

// Explicitly reject non-POST methods on the webhook route
router.all('/github', (req, res) => {
  res.status(405).json({
    error: {
      code: 'METHOD_NOT_ALLOWED',
      message: 'Method not allowed. Only POST requests are accepted.'
    }
  });
});

module.exports = router;
