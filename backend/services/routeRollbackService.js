const { getDatabase } = require('../config/database');
const runtimeService = require('./runtimeService');
const traefikRouteWriter = require('./traefikRouteWriter');
const { TraefikRouteWriterError } = traefikRouteWriter;

/**
 * Structured service error class for Route Rollback operations.
 */
class RouteRollbackError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'RouteRollbackError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Prepares a durable rollback operation for an activation journal.
 * Pure inspection; validates worker authorization, retrieves journal record,
 * and confirms rollback eligibility.
 *
 * @param {string} journalId - Journal UUID
 * @param {Object} options - Options ({ db, ownerId, fencingToken, sandboxDir })
 * @returns {Object} Structured rollback preparation descriptor
 */
function prepareRollback(journalId, options = {}) {
  if (!journalId || typeof journalId !== 'string') {
    throw new RouteRollbackError('Valid journal ID is required for rollback.', 'INVALID_JOURNAL_ID');
  }

  const cleanJournalId = journalId.trim();
  const db = options.db || getDatabase(options);

  // 1. Mandatory Worker Lease & Fencing Token Authorization
  const ownerId = String(options.ownerId || '').trim();
  const fencingToken = parseInt(options.fencingToken, 10);
  if (!ownerId || isNaN(fencingToken)) {
    throw new RouteRollbackError(
      'Worker lease ownership (ownerId) and monotonic fencingToken are strictly required to execute rollback.',
      'UNAUTHORIZED_WORKER'
    );
  }
  runtimeService.verifyActiveWorkerLease(ownerId, fencingToken, db);

  // 2. Retrieve Journal Record
  const journal = db.prepare('SELECT * FROM deployment_route_activation_journal WHERE journal_id = ?').get(cleanJournalId);
  if (!journal) {
    throw new RouteRollbackError(`Activation journal "${cleanJournalId}" not found.`, 'JOURNAL_NOT_FOUND');
  }

  // Fencing check: A stale worker with a lower fencing token cannot mutate or rollback a newer worker's journal
  if (fencingToken < journal.fencing_token) {
    throw new RouteRollbackError(
      `Stale worker fencing token (${fencingToken}) cannot mutate or roll back journal created with newer token (${journal.fencing_token}).`,
      'STALE_FENCING_TOKEN'
    );
  }

  const isFirstRelease = !journal.previous_route_document;

  return {
    prepared: true,
    journalId: cleanJournalId,
    activationId: journal.activation_id,
    applicationId: journal.application_id,
    deploymentId: journal.deployment_id,
    targetDomain: journal.target_domain,
    currentState: journal.journal_state,
    isFirstRelease,
    expectedPreviousFingerprint: journal.expected_previous_fingerprint,
    proposedFingerprint: journal.proposed_fingerprint,
    ownerId,
    fencingToken
  };
}

/**
 * Executes a safe, idempotent sandbox rollback of an applied or partially applied route.
 * Strictly respects worker lease fencing, CAS fingerprints, and never overwrites foreign mutations.
 *
 * @param {string} journalId - Journal UUID
 * @param {Object} options - Options ({ db, ownerId, fencingToken, sandboxDir, reason })
 * @returns {Object} Rollback execution outcome
 */
function executeSandboxRollback(journalId, options = {}) {
  const prep = prepareRollback(journalId, options);
  const db = options.db || getDatabase(options);
  const sandboxDir = options.sandboxDir || process.env.KPANEL_SANDBOX_ROUTE_DIR;

  // 1. Check if already successfully rolled back (Idempotency)
  if (prep.currentState === 'rolled_back') {
    let liveRoute;
    try {
      liveRoute = traefikRouteWriter.readOwnedRoute(prep.applicationId, { sandboxDir });
    } catch (readErr) {
      if (readErr.code === 'FOREIGN_ROUTE_FILE' || readErr.code === 'SYMLINK_DETECTED') {
        db.prepare(`
          UPDATE deployment_route_activation_journal
          SET journal_state = 'recovery_required',
              error_code = 'ROLLBACK_CONFLICT',
              updated_at = CURRENT_TIMESTAMP
          WHERE journal_id = ?
        `).run(prep.journalId);

        throw new RouteRollbackError(
          `Rollback blocked: route file is foreign or symlink-corrupted. ${readErr.message}`,
          'ROLLBACK_CONFLICT'
        );
      }
      throw readErr;
    }

    // If first release: file should be absent
    // If replacement: file should match expectedPreviousFingerprint
    if (prep.isFirstRelease && !liveRoute.exists) {
      return {
        rolledBack: true,
        alreadyRolledBack: true,
        journalId: prep.journalId,
        applicationId: prep.applicationId,
        state: 'rolled_back',
        message: 'Rollback already completed; route file is absent.'
      };
    } else if (!prep.isFirstRelease && liveRoute.exists && liveRoute.fingerprint === prep.expectedPreviousFingerprint) {
      return {
        rolledBack: true,
        alreadyRolledBack: true,
        journalId: prep.journalId,
        applicationId: prep.applicationId,
        state: 'rolled_back',
        message: 'Rollback already completed; previous route document is restored.'
      };
    }
  }

  // 2. Inspect live route state on the sandbox filesystem
  let liveRoute;
  try {
    liveRoute = traefikRouteWriter.readOwnedRoute(prep.applicationId, { sandboxDir });
  } catch (readErr) {
    if (readErr.code === 'FOREIGN_ROUTE_FILE' || readErr.code === 'SYMLINK_DETECTED') {
      // Foreign route detected! Fail closed and mark recovery_required
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'recovery_required',
            error_code = 'ROLLBACK_CONFLICT',
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);

      throw new RouteRollbackError(
        `Rollback blocked: route file is foreign or symlink-corrupted. ${readErr.message}`,
        'ROLLBACK_CONFLICT'
      );
    }
    throw readErr;
  }

  // 3. Mark Journal state: 'rolling_back' under transaction with lease re-verification
  const beginRollbackTx = db.transaction(() => {
    runtimeService.verifyActiveWorkerLease(prep.ownerId, prep.fencingToken, db);
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'rolling_back',
          rollback_started_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(prep.journalId);
  });
  beginRollbackTx.immediate();

  // 4. Inspect for foreign mutation drift
  // If the file exists and its fingerprint matches NEITHER the proposed fingerprint NOR the expected previous:
  // Another actor or process modified it!
  if (liveRoute.exists) {
    const isProposed = liveRoute.fingerprint === prep.proposedFingerprint;
    const isPrevious = prep.expectedPreviousFingerprint && liveRoute.fingerprint === prep.expectedPreviousFingerprint;

    if (!isProposed && !isPrevious) {
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'recovery_required',
            error_code = 'ROLLBACK_CONFLICT',
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);

      throw new RouteRollbackError(
        `Rollback aborted due to foreign route mutation. Live fingerprint "${liveRoute.fingerprint}" matches neither proposed ("${prep.proposedFingerprint}") nor previous ("${prep.expectedPreviousFingerprint}").`,
        'ROLLBACK_CONFLICT'
      );
    }

    // If it's already in the previous state, we can consider the filesystem already rolled back
    if (isPrevious) {
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'rolled_back',
            rollback_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      `).run(prep.journalId);

      return {
        rolledBack: true,
        alreadyRolledBack: true,
        journalId: prep.journalId,
        applicationId: prep.applicationId,
        state: 'rolled_back',
        message: 'Route was already restored to previous fingerprint.'
      };
    }
  } else {
    // File does not exist
    if (prep.isFirstRelease) {
      // Already rolled back for first release!
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'rolled_back',
            rollback_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      `).run(prep.journalId);

      return {
        rolledBack: true,
        alreadyRolledBack: true,
        journalId: prep.journalId,
        applicationId: prep.applicationId,
        state: 'rolled_back',
        message: 'First-release route was already absent.'
      };
    }
  }

  // 5. Re-verify worker lease immediately before filesystem mutation (fencing check)
  runtimeService.verifyActiveWorkerLease(prep.ownerId, prep.fencingToken, db);

  // 6. Execute atomic filesystem mutation
  const journal = db.prepare('SELECT previous_route_document FROM deployment_route_activation_journal WHERE journal_id = ?').get(prep.journalId);

  try {
    if (prep.isFirstRelease) {
      // First release: Remove only the K-Panel route file we introduced
      traefikRouteWriter.removeOwnedRoute(prep.applicationId, {
        sandboxDir,
        expectedFingerprint: prep.proposedFingerprint
      });
    } else {
      // Replacement release: Restore exact prior route document
      traefikRouteWriter.restorePreviousRoute(prep.applicationId, journal.previous_route_document, {
        sandboxDir,
        expectedFingerprint: prep.proposedFingerprint,
        expectedPreviousFingerprint: prep.proposedFingerprint
      });
    }
  } catch (writeErr) {
    // If write or CAS fails due to foreign mutation
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'recovery_required',
          error_code = 'ROLLBACK_WRITE_FAILED',
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(prep.journalId);

    throw new RouteRollbackError(`Rollback filesystem operation failed: ${writeErr.message}`, 'ROLLBACK_WRITE_FAILED', {
      originalError: writeErr.message
    });
  }

  // 7. Update journal to 'rolled_back' state under atomic transaction
  const completeRollbackTx = db.transaction(() => {
    runtimeService.verifyActiveWorkerLease(prep.ownerId, prep.fencingToken, db);
    db.prepare(`
      UPDATE deployment_route_activation_journal
      SET journal_state = 'rolled_back',
          rollback_completed_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE journal_id = ?
    `).run(prep.journalId);

    // Also update activation intent to 'rolled_back' if present
    db.prepare(`
      UPDATE deployment_release_activation_intents
      SET activation_status = 'rolled_back',
          updated_at = CURRENT_TIMESTAMP
      WHERE activation_id = ?
    `).run(prep.activationId);
  });
  completeRollbackTx.immediate();

  return {
    rolledBack: true,
    journalId: prep.journalId,
    activationId: prep.activationId,
    applicationId: prep.applicationId,
    isFirstRelease: prep.isFirstRelease,
    restoredPreviousFingerprint: prep.expectedPreviousFingerprint,
    completedAt: new Date().toISOString()
  };
}

/**
 * Reconciles an interrupted or crashed activation operation.
 * Inspects durable journal state and live filesystem route state to detect crash-window discrepancies.
 *
 * @param {string} journalId - Journal UUID
 * @param {Object} options - Options ({ db, ownerId, fencingToken, sandboxDir })
 * @returns {Object} Reconciliation outcome report
 */
function reconcileInterruptedActivation(journalId, options = {}) {
  const prep = prepareRollback(journalId, options);
  const db = options.db || getDatabase(options);
  const sandboxDir = options.sandboxDir || process.env.KPANEL_SANDBOX_ROUTE_DIR;

  // 1. Read actual live file state
  let liveRoute = null;
  let fileError = null;
  try {
    liveRoute = traefikRouteWriter.readOwnedRoute(prep.applicationId, { sandboxDir });
  } catch (err) {
    fileError = err;
  }

  const liveExists = Boolean(liveRoute && liveRoute.exists);
  const liveFingerprint = liveRoute ? liveRoute.fingerprint : null;

  let reconciliationAction = 'none';
  let resolvedState = prep.currentState;

  // Crash Case A: Journal in 'applying' state
  // Check if file was written before crash
  if (prep.currentState === 'applying') {
    if (liveExists && liveFingerprint === prep.proposedFingerprint) {
      // Route file was written to disk before crash acknowledgment
      resolvedState = 'applied_unverified';
      reconciliationAction = 'mark_applied_unverified';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'applied_unverified',
            route_applied_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);
    } else if (!liveExists || liveFingerprint === prep.expectedPreviousFingerprint) {
      // Process crashed before file write or write never completed
      resolvedState = 'prepared';
      reconciliationAction = 'reset_to_prepared';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'prepared',
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);
    } else {
      // Unrecognized file state
      resolvedState = 'recovery_required';
      reconciliationAction = 'flag_recovery_required';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'recovery_required',
            error_code = 'CRASH_STATE_UNRESOLVED',
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);
    }
  }

  // Crash Case B: Journal in 'rolling_back' state
  if (prep.currentState === 'rolling_back') {
    if (prep.isFirstRelease && !liveExists) {
      // First release rollback completed file removal before crash
      resolvedState = 'rolled_back';
      reconciliationAction = 'mark_rolled_back';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'rolled_back',
            rollback_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      `).run(prep.journalId);
    } else if (!prep.isFirstRelease && liveExists && liveFingerprint === prep.expectedPreviousFingerprint) {
      // Replacement release rollback completed file restoration before crash
      resolvedState = 'rolled_back';
      reconciliationAction = 'mark_rolled_back';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'rolled_back',
            rollback_completed_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
      `).run(prep.journalId);
    } else {
      resolvedState = 'recovery_required';
      reconciliationAction = 'flag_recovery_required';
      db.prepare(`
        UPDATE deployment_route_activation_journal
        SET journal_state = 'recovery_required',
            error_code = 'ROLLBACK_INTERRUPTED',
            updated_at = CURRENT_TIMESTAMP
        WHERE journal_id = ?
      `).run(prep.journalId);
    }
  }

  return {
    reconciled: true,
    journalId: prep.journalId,
    priorState: prep.currentState,
    resolvedState,
    reconciliationAction,
    liveFileState: {
      exists: liveExists,
      fingerprint: liveFingerprint,
      fileError: fileError?.message || null
    },
    checkedAt: new Date().toISOString()
  };
}

module.exports = {
  prepareRollback,
  executeSandboxRollback,
  reconcileInterruptedActivation,
  RouteRollbackError
};
