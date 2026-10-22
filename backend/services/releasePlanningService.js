const crypto = require('crypto');
const { getDatabase } = require('../config/database');
const deploymentLeaseService = require('./deploymentLeaseService');
const runtimeService = require('./runtimeService');
const githubRepositoryService = require('./githubRepositoryService');
const githubAppService = require('./githubAppService');
const traefikRoutePlanner = require('./traefikRoutePlanner');

/**
 * Structured service error class for Release Planning operations.
 */
class ReleasePlanningError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'ReleasePlanningError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates and normalizes an application domain hostname (RFC 1123).
 * Strictly rejects URLs, protocols, ports, paths, IP literals, reserved/internal hostnames,
 * wildcards, and cross-application duplicate claims within K-Panel.
 *
 * @param {string} domain - Domain string to validate
 * @param {Object} [options] - Options ({ db, applicationId })
 * @returns {string} Normalized domain hostname
 */
function normalizeAndValidateDomain(domain, options = {}) {
  if (!domain || typeof domain !== 'string') {
    throw new ReleasePlanningError('Domain is required and must be a non-empty string.', 'INVALID_DOMAIN');
  }

  const raw = domain.trim();

  // Reject schemes or path separators
  if (raw.includes('://') || raw.includes('/') || raw.includes('\\') || raw.includes('@')) {
    throw new ReleasePlanningError('Domain must be a bare hostname without protocol, path, or credentials.', 'INVALID_DOMAIN');
  }

  // Reject ports
  if (raw.includes(':')) {
    throw new ReleasePlanningError('Domain must not include a port number.', 'INVALID_DOMAIN');
  }

  // Reject queries or fragments
  if (raw.includes('?') || raw.includes('#')) {
    throw new ReleasePlanningError('Domain must not include query parameters or fragments.', 'INVALID_DOMAIN');
  }

  // Reject wildcards or catch-alls
  if (raw.includes('*') || raw.startsWith('.')) {
    throw new ReleasePlanningError('Wildcard or catch-all domains are not permitted.', 'INVALID_DOMAIN');
  }

  // Normalize case
  let normalized = raw.toLowerCase();

  // IDN Punycode conversion if necessary
  if (/[^\x00-\x7F]/.test(normalized)) {
    try {
      const url = new URL(`http://${normalized}`);
      normalized = url.hostname.toLowerCase();
    } catch {
      throw new ReleasePlanningError('Internationalized domain name conversion failed.', 'INVALID_DOMAIN');
    }
  }

  // Length check
  if (normalized.length < 3 || normalized.length > 253) {
    throw new ReleasePlanningError('Domain must be between 3 and 253 characters.', 'INVALID_DOMAIN');
  }

  // Reject IPv4 literals (e.g. 127.0.0.1, 192.168.1.1, 10.0.0.1)
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(normalized)) {
    throw new ReleasePlanningError('IP address literals are not allowed as public deployment domains.', 'INVALID_DOMAIN');
  }

  // Reject IPv6 literals
  if (/^[0-9a-f:]+$/i.test(normalized) && normalized.includes(':')) {
    throw new ReleasePlanningError('IPv6 address literals are not allowed as public deployment domains.', 'INVALID_DOMAIN');
  }

  // Reserved and internal TLDs / hostnames
  const reservedTlds = ['.localhost', '.local', '.internal', '.test', '.example', '.invalid', '.lan', '.home', '.corp'];
  if (
    normalized === 'localhost' ||
    reservedTlds.some((tld) => normalized.endsWith(tld))
  ) {
    throw new ReleasePlanningError(`Domain "${normalized}" is a reserved or internal hostname and cannot be used for public routing.`, 'RESERVED_DOMAIN');
  }

  // RFC 1123 hostname syntax check: each label 1-63 chars, alphanumeric + hyphen, cannot start/end with hyphen
  const rfc1123Regex = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  if (!rfc1123Regex.test(normalized)) {
    throw new ReleasePlanningError(`Domain "${normalized}" is not a valid RFC 1123 fully qualified domain name.`, 'INVALID_DOMAIN');
  }

  // Check duplicate domain claims across applications in K-Panel database
  const db = options.db;
  const applicationId = options.applicationId;
  if (db && applicationId) {
    // 1. Check if another application currently configures this domain
    const conflictingApp = db.prepare(`
      SELECT id, name FROM applications
      WHERE domain = ? AND id != ?
    `).get(normalized, applicationId);

    if (conflictingApp) {
      throw new ReleasePlanningError(
        `Domain "${normalized}" is already assigned to another application ("${conflictingApp.name}").`,
        'DOMAIN_ALREADY_CLAIMED'
      );
    }

    // 2. Check if another application has an active release plan claiming this domain
    const conflictingPlan = db.prepare(`
      SELECT p.id, p.application_id, a.name as application_name
      FROM deployment_release_plans p
      JOIN applications a ON p.application_id = a.id
      WHERE p.target_domain = ?
        AND p.application_id != ?
        AND p.plan_status IN ('ready', 'draft')
    `).get(normalized, applicationId);

    if (conflictingPlan) {
      throw new ReleasePlanningError(
        `Domain "${normalized}" is already claimed by an active release plan for application "${conflictingPlan.application_name}".`,
        'DOMAIN_ALREADY_CLAIMED'
      );
    }
  }

  return normalized;
}

/**
 * Validates internal application service port.
 * Must be an integer between 1 and 65535.
 *
 * @param {any} port - Port to validate
 * @returns {number} Validated integer port
 */
function validateTargetPort(port) {
  if (port === undefined || port === null || port === '') {
    throw new ReleasePlanningError('Target port is required.', 'INVALID_PORT');
  }

  if (Array.isArray(port) || (typeof port === 'object')) {
    throw new ReleasePlanningError('Ambiguous container port configuration.', 'INVALID_PORT');
  }

  let num;
  if (typeof port === 'number') {
    num = port;
  } else if (typeof port === 'string') {
    if (!/^\d+$/.test(port.trim())) {
      throw new ReleasePlanningError(`Port "${port}" is not a valid integer.`, 'INVALID_PORT');
    }
    num = parseInt(port.trim(), 10);
  } else {
    throw new ReleasePlanningError('Port must be an integer between 1 and 65535.', 'INVALID_PORT');
  }

  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new ReleasePlanningError(`Port must be an integer between 1 and 65535 (received: ${port}).`, 'INVALID_PORT');
  }

  return num;
}

/**
 * Validates complete release eligibility for a built deployment and staging candidate container.
 * Performs fresh live inspection of Docker container state (never relies solely on cached DB health).
 *
 * @param {string} deploymentId - Deployment UUID
 * @param {Object} [options] - Options ({ db, docker, applicationId, skipGitCheck, enforceAllowlist })
 * @returns {Promise<Object>} Validated eligibility context
 */
async function validateReleaseEligibility(deploymentId, options = {}) {
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new ReleasePlanningError('Valid deployment ID is required to validate release eligibility.', 'INVALID_DEPLOYMENT_ID');
  }

  const cleanDeploymentId = deploymentId.trim();
  const db = options.db || getDatabase(options);

  // 1. Verify Deployment Record exists
  const deployment = db.prepare(`
    SELECT id, application_id, commit_sha, status, image_tag, image_id
    FROM deployments
    WHERE id = ?
  `).get(cleanDeploymentId);

  if (!deployment) {
    throw new ReleasePlanningError(`Deployment "${cleanDeploymentId}" not found.`, 'DEPLOYMENT_NOT_FOUND');
  }

  // 2. Verify Application identity
  if (options.applicationId && deployment.application_id !== options.applicationId) {
    throw new ReleasePlanningError(
      `Deployment applicationId "${deployment.application_id}" does not match requested applicationId "${options.applicationId}".`,
      'APPLICATION_ID_MISMATCH'
    );
  }

  // 3. Verify Deployment status is strictly 'built'
  if (deployment.status !== 'built') {
    throw new ReleasePlanningError(
      `Deployment "${cleanDeploymentId}" is in status "${deployment.status}". Only "built" deployments are eligible for release planning.`,
      'INVALID_DEPLOYMENT_STATUS'
    );
  }

  // 4. Verify Application Record exists
  const application = db.prepare(`
    SELECT id, name, slug, repo_url, branch, port, domain
    FROM applications
    WHERE id = ?
  `).get(deployment.application_id);

  if (!application) {
    throw new ReleasePlanningError(`Application "${deployment.application_id}" not found.`, 'APPLICATION_NOT_FOUND');
  }

  // 5. Verify Target Port
  const targetPort = validateTargetPort(application.port);

  // 6. Verify Target Domain
  if (!application.domain) {
    throw new ReleasePlanningError(
      `Application "${application.name}" has no target domain configured. Public routing preparation requires a valid domain.`,
      'DOMAIN_MISSING'
    );
  }
  const targetDomain = normalizeAndValidateDomain(application.domain, { db, applicationId: application.id });

  // 7. Verify Durable Build Artifact exists
  const artifact = deploymentLeaseService.getDeploymentArtifact(cleanDeploymentId, { db });
  if (!artifact) {
    throw new ReleasePlanningError(
      `No durable build artifact record found for deployment "${cleanDeploymentId}".`,
      'ARTIFACT_NOT_FOUND'
    );
  }

  // 8. Verify Commit SHA matches immutable source
  if (artifact.commit_sha.toLowerCase() !== (deployment.commit_sha || '').toLowerCase()) {
    throw new ReleasePlanningError(
      `Artifact commit SHA "${artifact.commit_sha}" does not match deployment commit SHA "${deployment.commit_sha}".`,
      'COMMIT_SHA_MISMATCH'
    );
  }

  // 9. Verify Candidate container record exists in SQLite
  const candidate = runtimeService.getCandidateRuntimeStatus(cleanDeploymentId, { db });
  if (!candidate || !candidate.containerId) {
    throw new ReleasePlanningError(
      `No staged runtime candidate container record found for deployment "${cleanDeploymentId}". Candidate container must be staged first.`,
      'CANDIDATE_NOT_FOUND'
    );
  }

  if (candidate.applicationId !== deployment.application_id) {
    throw new ReleasePlanningError('Candidate application_id does not match deployment record.', 'CANDIDATE_INTEGRITY_MISMATCH');
  }

  // 10. Verify Candidate image ID matches the persisted build artifact
  if (candidate.imageId.toLowerCase() !== artifact.image_id.toLowerCase()) {
    throw new ReleasePlanningError(
      `Candidate container image ID "${candidate.imageId}" does not match durable build artifact image ID "${artifact.image_id}".`,
      'CANDIDATE_IMAGE_MISMATCH'
    );
  }

  // 11. Fresh Live Docker Inspection (Never trust cached DB status as permanent readiness)
  let inspect;
  try {
    inspect = await runtimeService.inspectCandidateContainer(candidate.containerId, options);
  } catch (inspectErr) {
    throw new ReleasePlanningError(
      `Failed to inspect candidate container "${candidate.containerId}" in Docker: ${inspectErr.message}`,
      'CANDIDATE_INSPECT_FAILED'
    );
  }

  // 12. Verify Candidate Container is currently running
  if (!inspect.running) {
    throw new ReleasePlanningError(
      `Candidate container "${candidate.containerId}" is not running (state: "${inspect.status}"). Candidate must be active and healthy.`,
      'CANDIDATE_NOT_RUNNING'
    );
  }

  // 13. Verify Container Ownership Labels
  const labels = inspect.labels || {};
  if (
    labels['io.kpanel.managed'] !== 'true' ||
    labels['io.kpanel.role'] !== 'candidate' ||
    labels['io.kpanel.deployment-id'] !== cleanDeploymentId ||
    labels['io.kpanel.application-id'] !== application.id
  ) {
    throw new ReleasePlanningError(
      `Candidate container "${candidate.containerId}" failed K-Panel ownership label verification.`,
      'CANDIDATE_OWNERSHIP_INVALID'
    );
  }

  // 14. Verify Docker HEALTHCHECK instruction is defined
  if (!inspect.hasHealthcheck) {
    throw new ReleasePlanningError(
      'Candidate container image has no defined HEALTHCHECK instruction. Cannot determine release readiness without health verification.',
      'HEALTHCHECK_MISSING'
    );
  }

  // 15. Verify Docker Health Status is strictly 'healthy'
  if (inspect.healthStatus !== 'healthy') {
    throw new ReleasePlanningError(
      `Candidate container health status is "${inspect.healthStatus}". Only verified "healthy" candidates are eligible for release planning.`,
      'CANDIDATE_UNHEALTHY'
    );
  }

  // 16. Verify GitHub repository authorization has not drifted
  if (options.skipGitCheck !== true) {
    try {
      const assoc = githubRepositoryService.getApplicationRepositoryAssociation(application.id, { db, ...options });
      if (assoc) {
        if (assoc.associationStatus !== 'verified') {
          throw new ReleasePlanningError('Application repository association is not verified.', 'REPOSITORY_ASSOCIATION_STALE');
        }
        if (assoc.installationStatus !== 'active') {
          throw new ReleasePlanningError(`GitHub installation is ${assoc.installationStatus}.`, 'INSTALLATION_NOT_AUTHORIZED');
        }
        if (options.enforceAllowlist !== false) {
          const instRow = db.prepare('SELECT account_id FROM github_installations WHERE installation_id = ?').get(assoc.installationId);
          const accountId = instRow?.account_id || assoc.accountId;
          if (accountId && !githubAppService.isAccountAllowlisted(accountId, options)) {
            throw new ReleasePlanningError(`GitHub account (${accountId}) is not allowlisted in GITHUB_ALLOWED_ACCOUNT_IDS.`, 'INSTALLATION_NOT_AUTHORIZED');
          }
        }
      }
    } catch (err) {
      if (err instanceof ReleasePlanningError) throw err;
      if (err.name === 'GithubRepositoryError') {
        throw new ReleasePlanningError(err.message, 'REPOSITORY_ASSOCIATION_STALE');
      }
      throw err;
    }
  }

  return {
    eligible: true,
    deploymentId: cleanDeploymentId,
    applicationId: application.id,
    applicationName: application.name,
    commitSha: artifact.commit_sha,
    imageId: artifact.image_id,
    imageTag: artifact.image_tag,
    candidateContainerId: candidate.containerId,
    stagingNetworkId: candidate.stagingNetworkId,
    targetDomain,
    targetPort,
    healthStatus: inspect.healthStatus,
    inspectedAt: new Date().toISOString()
  };
}

/**
 * Creates or reconciles a durable release plan for a verified built candidate.
 * Guarantees atomic transaction execution, fencing token validation, deterministic route proposal,
 * and enforcement of single actionable plan per application.
 *
 * @param {Object} input - Input { deploymentId, applicationId, targetDomain, targetPort, ... }
 * @param {Object} [options] - Options ({ db, docker, ownerId, fencingToken, ... })
 * @returns {Promise<Object>} Created or reconciled release plan record with route proposal
 */
async function createReleasePlan(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new ReleasePlanningError('Release plan input object is required.', 'INVALID_INPUT');
  }

  const { deploymentId, applicationId } = input;
  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new ReleasePlanningError('Valid deployment ID is required to create release plan.', 'INVALID_DEPLOYMENT_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanDeploymentId = deploymentId.trim();

  // 1. Worker Lease and Fencing Token Verification (where worker execution is involved)
  const cleanOwnerId = String(options.ownerId || input.ownerId || '').trim();
  const tokenNum = parseInt(options.fencingToken !== undefined ? options.fencingToken : input.fencingToken, 10);
  if (cleanOwnerId && !isNaN(tokenNum)) {
    runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
  }

  // 2. Validate Complete Release Eligibility (including fresh Docker health inspection)
  const eligibility = await validateReleaseEligibility(cleanDeploymentId, {
    ...options,
    applicationId
  });

  // 3. Generate Structured Pure Traefik Routing Proposal
  const routeProposal = traefikRoutePlanner.planTraefikRoute({
    applicationId: eligibility.applicationId,
    deploymentId: eligibility.deploymentId,
    targetDomain: eligibility.targetDomain,
    targetPort: eligibility.targetPort,
    candidateContainerId: eligibility.candidateContainerId,
    targetNetwork: eligibility.stagingNetworkId
  }, options);

  // 4. Atomically Persist Release Plan to SQLite
  const planTx = db.transaction(() => {
    // Re-verify worker lease inside transaction if fenced
    if (cleanOwnerId && !isNaN(tokenNum)) {
      runtimeService.verifyActiveWorkerLease(cleanOwnerId, tokenNum, db);
    }

    // Check for existing plan for this exact deployment (Idempotency)
    const existing = db.prepare(`
      SELECT * FROM deployment_release_plans WHERE deployment_id = ?
    `).get(cleanDeploymentId);

    if (existing) {
      // Reconcile existing plan for this deployment
      db.prepare(`
        UPDATE deployment_release_plans
        SET candidate_container_id = ?,
            image_id = ?,
            commit_sha = ?,
            target_domain = ?,
            target_port = ?,
            route_provider = 'traefik',
            plan_status = 'ready',
            readiness_checked_at = CURRENT_TIMESTAMP,
            invalidated_reason = NULL,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        eligibility.candidateContainerId,
        eligibility.imageId,
        eligibility.commitSha,
        eligibility.targetDomain,
        eligibility.targetPort,
        existing.id
      );

      const updated = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(existing.id);
      return { plan: updated, isNew: false };
    }

    // Invalidate / Stale any prior actionable plans for the same application so there is only one current plan
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'SUPERSEDED_BY_NEWER_PLAN',
          updated_at = CURRENT_TIMESTAMP
      WHERE application_id = ? AND plan_status IN ('ready', 'draft')
    `).run(eligibility.applicationId);

    // Create new release plan
    const planId = `plan-${crypto.randomUUID()}`;
    db.prepare(`
      INSERT INTO deployment_release_plans (
        id, application_id, deployment_id, candidate_container_id, image_id,
        commit_sha, target_domain, target_port, route_provider, plan_status,
        readiness_checked_at, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, ?, ?, 'traefik', 'ready',
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run(
      planId,
      eligibility.applicationId,
      eligibility.deploymentId,
      eligibility.candidateContainerId,
      eligibility.imageId,
      eligibility.commitSha,
      eligibility.targetDomain,
      eligibility.targetPort
    );

    const created = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(planId);
    return { plan: created, isNew: true };
  });

  const { plan, isNew } = planTx.immediate();

  return {
    planId: plan.id,
    applicationId: plan.application_id,
    deploymentId: plan.deployment_id,
    candidateContainerId: plan.candidate_container_id,
    imageId: plan.image_id,
    commitSha: plan.commit_sha,
    targetDomain: plan.target_domain,
    targetPort: plan.target_port,
    routeProvider: plan.route_provider,
    planStatus: plan.plan_status,
    readinessCheckedAt: plan.readiness_checked_at,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    invalidatedReason: plan.invalidated_reason,
    isNew,
    routeProposal
  };
}

/**
 * Retrieves a release plan by ID.
 *
 * @param {string} planId - Release Plan UUID
 * @param {Object} [options] - Options ({ db })
 * @returns {Object|null} Sanitized plan record or null
 */
function getReleasePlan(planId, options = {}) {
  if (!planId || typeof planId !== 'string') return null;
  const db = options.db || getDatabase(options);
  const row = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(planId.trim());
  return row || null;
}

/**
 * Retrieves a release plan by deployment ID.
 *
 * @param {string} deploymentId - Deployment UUID
 * @param {Object} [options] - Options ({ db })
 * @returns {Object|null} Sanitized plan record or null
 */
function getReleasePlanByDeployment(deploymentId, options = {}) {
  if (!deploymentId || typeof deploymentId !== 'string') return null;
  const db = options.db || getDatabase(options);
  const row = db.prepare('SELECT * FROM deployment_release_plans WHERE deployment_id = ?').get(deploymentId.trim());
  return row || null;
}

/**
 * Lists release plans with optional filtering.
 *
 * @param {Object} [filter] - Filter options ({ applicationId, planStatus, deploymentId })
 * @param {Object} [options] - Options ({ db })
 * @returns {Array<Object>} List of release plans
 */
function listReleasePlans(filter = {}, options = {}) {
  const db = options.db || getDatabase(options);
  let query = 'SELECT * FROM deployment_release_plans WHERE 1=1';
  const params = [];

  if (filter.applicationId) {
    query += ' AND application_id = ?';
    params.push(filter.applicationId.trim());
  }

  if (filter.deploymentId) {
    query += ' AND deployment_id = ?';
    params.push(filter.deploymentId.trim());
  }

  if (filter.planStatus) {
    query += ' AND plan_status = ?';
    params.push(filter.planStatus.trim());
  }

  query += ' ORDER BY created_at DESC';
  return db.prepare(query).all(...params);
}

/**
 * Validates freshness and ongoing readiness of an existing release plan.
 * Re-inspects live Docker container status, image integrity, and application configuration.
 * Atomically marks the plan 'stale' or 'blocked' if any condition has drifted.
 *
 * @param {string} planId - Release Plan UUID
 * @param {Object} [options] - Options ({ db, docker })
 * @returns {Promise<Object>} Freshness evaluation result
 */
async function validatePlanFreshness(planId, options = {}) {
  if (!planId || typeof planId !== 'string') {
    throw new ReleasePlanningError('Valid plan ID is required to validate freshness.', 'INVALID_PLAN_ID');
  }

  const db = options.db || getDatabase(options);
  const plan = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(planId.trim());

  if (!plan) {
    throw new ReleasePlanningError(`Release plan "${planId}" not found.`, 'PLAN_NOT_FOUND');
  }

  // 1. Check Deployment status
  const deployment = db.prepare('SELECT status, commit_sha FROM deployments WHERE id = ?').get(plan.deployment_id);
  if (!deployment || deployment.status === 'cancelled' || deployment.status === 'failed') {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'DEPLOYMENT_CANCELLED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'DEPLOYMENT_CANCELLED' };
  }

  // 2. Check Application Configuration Drift (Domain or Port change)
  const application = db.prepare('SELECT domain, port FROM applications WHERE id = ?').get(plan.application_id);
  if (!application) {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'APPLICATION_REMOVED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'APPLICATION_REMOVED' };
  }

  const currentDomain = (application.domain || '').trim().toLowerCase();
  if (currentDomain !== (plan.target_domain || '').toLowerCase()) {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'APPLICATION_DOMAIN_CHANGED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'APPLICATION_DOMAIN_CHANGED' };
  }

  if (Number(application.port) !== Number(plan.target_port)) {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'APPLICATION_PORT_CHANGED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'APPLICATION_PORT_CHANGED' };
  }

  // 3. Inspect Live Docker Candidate Container
  let inspect;
  try {
    inspect = await runtimeService.inspectCandidateContainer(plan.candidate_container_id, options);
  } catch (err) {
    // Container missing or inspect failed
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'CANDIDATE_CONTAINER_MISSING',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'CANDIDATE_CONTAINER_MISSING' };
  }

  if (!inspect.running) {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'CANDIDATE_CONTAINER_STOPPED',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'CANDIDATE_CONTAINER_STOPPED' };
  }

  if (inspect.healthStatus !== 'healthy') {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'CANDIDATE_UNHEALTHY',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'CANDIDATE_UNHEALTHY' };
  }

  // 4. Verify Image Drift
  const inspectedImageId = String(inspect.labels?.['io.kpanel.image-id'] || '').toLowerCase();
  if (inspectedImageId && inspectedImageId !== plan.image_id.toLowerCase()) {
    db.prepare(`
      UPDATE deployment_release_plans
      SET plan_status = 'stale',
          invalidated_reason = 'CANDIDATE_IMAGE_MISMATCH',
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(plan.id);

    return { fresh: false, planStatus: 'stale', reason: 'CANDIDATE_IMAGE_MISMATCH' };
  }

  // Plan is completely fresh and verified
  db.prepare(`
    UPDATE deployment_release_plans
    SET readiness_checked_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(plan.id);

  return {
    fresh: true,
    planStatus: 'ready',
    planId: plan.id,
    readinessCheckedAt: new Date().toISOString()
  };
}

/**
 * Invalidates an active release plan.
 *
 * @param {string} planId - Release Plan UUID
 * @param {string} reason - Invalidation reason
 * @param {Object} [options] - Options ({ db })
 * @returns {Object} Invalidation result
 */
function invalidateReleasePlan(planId, reason, options = {}) {
  if (!planId || typeof planId !== 'string') {
    throw new ReleasePlanningError('Valid plan ID is required to invalidate plan.', 'INVALID_PLAN_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanPlanId = planId.trim();
  const cleanReason = String(reason || 'MANUALLY_INVALIDATED').slice(0, 500);

  const result = db.prepare(`
    UPDATE deployment_release_plans
    SET plan_status = 'stale',
        invalidated_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(cleanReason, cleanPlanId);

  return {
    invalidated: result.changes > 0,
    planId: cleanPlanId,
    reason: cleanReason
  };
}

/**
 * Cancels a release plan, strictly scoped to the requesting application.
 *
 * @param {string} planId - Release Plan UUID
 * @param {string} reason - Cancellation reason
 * @param {Object} [options] - Options ({ db, applicationId })
 * @returns {Object} Cancellation result
 */
function cancelReleasePlan(planId, reason, options = {}) {
  if (!planId || typeof planId !== 'string') {
    throw new ReleasePlanningError('Valid plan ID is required to cancel plan.', 'INVALID_PLAN_ID');
  }

  const db = options.db || getDatabase(options);
  const cleanPlanId = planId.trim();
  const cleanReason = String(reason || 'PLAN_CANCELLED').slice(0, 500);

  const plan = db.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(cleanPlanId);
  if (!plan) {
    throw new ReleasePlanningError(`Release plan "${cleanPlanId}" not found.`, 'PLAN_NOT_FOUND');
  }

  // Scoped cancellation: protect against cross-application manipulation
  if (options.applicationId && plan.application_id !== options.applicationId) {
    throw new ReleasePlanningError('Release plan does not belong to the specified application.', 'APPLICATION_ID_MISMATCH');
  }

  db.prepare(`
    UPDATE deployment_release_plans
    SET plan_status = 'cancelled',
        invalidated_reason = ?,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(cleanReason, cleanPlanId);

  return {
    cancelled: true,
    planId: cleanPlanId,
    applicationId: plan.application_id,
    reason: cleanReason
  };
}

module.exports = {
  normalizeAndValidateDomain,
  validateTargetPort,
  validateReleaseEligibility,
  createReleasePlan,
  getReleasePlan,
  getReleasePlanByDeployment,
  listReleasePlans,
  validatePlanFreshness,
  invalidateReleasePlan,
  cancelReleasePlan,
  ReleasePlanningError
};
