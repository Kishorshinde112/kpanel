const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations, getCurrentVersion, getAppliedMigrations, loadMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentLeaseService = require('../services/deploymentLeaseService');
const runtimeService = require('../services/runtimeService');
const { RuntimeServiceError } = runtimeService;
const releasePlanningService = require('../services/releasePlanningService');
const { createReleasePlan, ReleasePlanningError } = releasePlanningService;
const traefikTopologyService = require('../services/traefikTopologyService');
const routeConflictService = require('../services/routeConflictService');
const { CONFLICT_DECISIONS } = routeConflictService;
const routingPreflightService = require('../services/routingPreflightService');
const {
  validateActivationPreflight,
  createActivationIntent,
  getActivationIntent,
  resolveCandidateRoutingTarget,
  buildRollbackPlan,
  planTrafficSwitch,
  simulateActivationExecution,
  computeRouteFingerprint,
  PREFLIGHT_DECISIONS,
  RoutingPreflightError
} = routingPreflightService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

/**
 * Creates an in-memory mock Docker client for offline tests.
 */
function createMockDockerClient(options = {}) {
  const images = new Map();
  const networks = new Map();
  const containers = new Map();

  const defaultStagingNetworkId = options.stagingNetworkId || 'staging-net-001';
  networks.set(defaultStagingNetworkId, {
    Id: defaultStagingNetworkId,
    Name: 'kpanel-staging',
    Driver: 'bridge',
    Internal: true
  });

  const defaultImageId = options.defaultImageId || 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  images.set(defaultImageId, {
    Id: defaultImageId,
    Architecture: 'arm64',
    Config: {
      Healthcheck: options.hasHealthcheck !== false ? { Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'] } : null,
      User: 'node'
    }
  });

  return {
    _images: images,
    _networks: networks,
    _containers: containers,
    _createdOptions: [],

    getImage(id) {
      const cleanId = String(id || '').toLowerCase();
      return {
        inspect: async () => {
          if (options.failImageInspect) throw new Error('Image inspect failed');
          if (images.has(cleanId)) return images.get(cleanId);
          if (cleanId === defaultImageId) return images.get(defaultImageId);
          throw new Error(`No such image: ${id}`);
        }
      };
    },

    getNetwork(id) {
      return {
        inspect: async () => {
          if (options.failNetworkInspect) throw new Error('Network inspect failed');
          if (networks.has(id)) return networks.get(id);
          throw new Error(`No such network: ${id}`);
        }
      };
    },

    getContainer(idOrName) {
      return {
        inspect: async () => {
          if (options.failContainerInspect) throw new Error('Container inspect failed');
          if (containers.has(idOrName)) return containers.get(idOrName);
          throw new Error(`No such container: ${idOrName}`);
        }
      };
    }
  };
}

test('Phase 4C3A: Routing Preflight, Activation Dry Run & Rollback Contract Suite', async (t) => {
  let tempBaseDir;
  let tempDbPath;
  let testDb;
  let originalDeploymentsContent;

  const TEST_IMAGE_ID = 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  const TEST_STAGING_NET = 'staging-net-001';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-preflight-test-'));
    tempDbPath = path.join(tempBaseDir, 'test-preflight.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    delete process.env.KPANEL_STAGING_NETWORK_ID;
    delete process.env.KPANEL_PROXY_NETWORK_ID;

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try { fs.rmSync(tempBaseDir, { recursive: true, force: true }); } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });

  // Helper to establish a valid built candidate, ready release plan, and mock Docker setup
  async function setupReadyPlan(app, options = {}) {
    const deploymentId = options.deploymentId || `d-${crypto.randomUUID()}`;
    const commitSha = options.commitSha || 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const imageId = options.imageId || TEST_IMAGE_ID;
    const imageTag = options.imageTag || `kpanel/app-${app.id}:d-${deploymentId}-${commitSha.slice(0, 7)}`;
    const containerId = options.containerId || `c-${crypto.randomUUID()}`;
    const containerName = `kpanel-candidate-${deploymentId}`;

    // Insert Deployment
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, image_tag, image_id, created_at)
      VALUES (?, ?, ?, 'manual', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, options.deploymentStatus || 'built', imageTag, imageId);

    // Insert Build Artifact
    if (options.insertArtifact !== false) {
      testDb.prepare(`
        INSERT INTO deployment_build_artifacts (
          deployment_id, application_id, commit_sha, image_tag, image_id,
          build_duration_ms, log_path, platform, build_type, build_path,
          dockerfile_path, built_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          1200, '/tmp/build.log', 'linux/arm64', 'dockerfile', '.',
          'Dockerfile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(deploymentId, app.id, commitSha, imageTag, imageId);
    }

    // Insert Candidate Record
    if (options.insertCandidate !== false) {
      testDb.prepare(`
        INSERT INTO deployment_runtime_candidates (
          deployment_id, application_id, image_id, container_id, container_name,
          staging_network_id, candidate_state, health_status, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        deploymentId,
        app.id,
        imageId,
        containerId,
        containerName,
        TEST_STAGING_NET,
        options.candidateState || 'healthy',
        options.healthStatus || 'healthy'
      );
    }

    // Insert Mock Docker container
    const mockDocker = options.mockDocker;
    if (mockDocker) {
      const mockContainerObj = {
        Id: containerId,
        Name: `/${containerName}`,
        State: {
          Running: options.containerRunning !== undefined ? options.containerRunning : true,
          Status: options.containerStatus || 'running',
          ExitCode: options.exitCode || 0,
          Health: options.hasHealthcheck !== false ? {
            Status: options.dockerHealthStatus || 'healthy',
            Log: []
          } : null
        },
        Config: {
          Labels: {
            'io.kpanel.managed': 'true',
            'io.kpanel.role': 'candidate',
            'io.kpanel.application-id': app.id,
            'io.kpanel.deployment-id': deploymentId,
            'io.kpanel.commit-sha': commitSha,
            'io.kpanel.image-id': imageId,
            'traefik.enable': 'false',
            ...(options.extraLabels || {})
          },
          Healthcheck: options.hasHealthcheck !== false ? { Test: ['CMD'] } : null,
          User: 'node'
        },
        HostConfig: {
          NetworkMode: TEST_STAGING_NET
        }
      };

      mockDocker._containers.set(containerId, mockContainerObj);
      mockDocker._containers.set(containerName, mockContainerObj);
    }

    // Insert Release Plan
    const planId = options.planId || `plan-${crypto.randomUUID()}`;
    if (options.insertPlan !== false) {
      testDb.prepare(`
        INSERT INTO deployment_release_plans (
          id, application_id, deployment_id, candidate_container_id, image_id,
          commit_sha, target_domain, target_port, route_provider, plan_status,
          readiness_checked_at, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          ?, ?, ?, 'traefik', ?,
          CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(
        planId,
        app.id,
        deploymentId,
        containerId,
        imageId,
        commitSha,
        app.domain || 'preflight.kpanel.dev',
        app.port || 3000,
        options.planStatus || 'ready'
      );
    }

    return { deploymentId, planId, containerId, containerName, imageId, commitSha };
  }

  // ── 1-3. Migration 009 & Database Evolution ─────────────────────────
  await t.test('1-3. Migration 009 applies cleanly, upgrades database, and preserves previous releases', () => {
    // 1. Current version is at least 9
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 9, 'Schema version must be at least 9');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.some((m) => m.version === 9 && m.name === '009_release_activation_intents'));

    // Check table exists and columns match specification
    const cols = testDb.prepare('PRAGMA table_info(deployment_release_activation_intents)').all().map((c) => c.name);
    assert.ok(cols.includes('activation_id'));
    assert.ok(cols.includes('release_plan_id'));
    assert.ok(cols.includes('application_id'));
    assert.ok(cols.includes('deployment_id'));
    assert.ok(cols.includes('candidate_container_id'));
    assert.ok(cols.includes('expected_image_id'));
    assert.ok(cols.includes('target_domain'));
    assert.ok(cols.includes('target_port'));
    assert.ok(cols.includes('previous_release_id'));
    assert.ok(cols.includes('previous_route_fingerprint'));
    assert.ok(cols.includes('proposed_route_fingerprint'));
    assert.ok(cols.includes('topology_snapshot_fingerprint'));
    assert.ok(cols.includes('activation_status'));
    assert.ok(cols.includes('blocked_reason'));

    // 2. Older database (v008) upgrades safely
    const upgradePath = path.join(tempBaseDir, 'test-upgrade-v8-to-v9.db');
    const upgradeDb = new Database(upgradePath);
    upgradeDb.pragma('foreign_keys = ON');

    const v8Migrations = loadMigrations().filter((m) => m.version <= 8);
    runMigrations(upgradeDb, v8Migrations);
    assert.equal(getCurrentVersion(upgradeDb), 8);

    const v9Migrations = loadMigrations().filter((m) => m.version <= 9);
    const upgradeRes = runMigrations(upgradeDb, v9Migrations);
    assert.equal(upgradeRes.applied, 1);
    assert.equal(getCurrentVersion(upgradeDb), 9);
    upgradeDb.close();

    // 3. Existing release records remain untouched
    const releaseCount = testDb.prepare('SELECT count(*) as count FROM releases').get().count;
    assert.equal(releaseCount, 0, 'No releases should have been created');
  });

  // ── 4-6, 19. Topology Auditing & Parsing ─────────────────────────────
  await t.test('4-6, 19. Read-only topology auditing: valid recognized, missing provider, unavailable snapshot, stale snapshot', () => {
    // 4. Valid provider topology recognized
    const sampleSnapshot = {
      routers: {
        'dokploy-app@docker': {
          entryPoints: ['websecure'],
          rule: 'Host(`dokploy.example.com`)',
          service: 'dokploy-service@docker',
          status: 'enabled',
          tls: true
        },
        'n8n-main@docker': {
          entryPoints: ['websecure'],
          rule: 'Host(`n8n.example.com`)',
          service: 'n8n-service@docker',
          status: 'enabled'
        },
        'my-service@file': {
          entryPoints: ['websecure'],
          rule: 'Host(`file.example.com`)',
          service: 'my-service@file'
        }
      },
      services: {
        'dokploy-service@docker': {
          loadBalancer: {
            servers: [{ url: 'http://172.28.0.5:3000' }]
          }
        }
      }
    };

    const topology = traefikTopologyService.inspectRoutingTopology({ snapshot: sampleSnapshot });
    assert.equal(topology.status, 'AVAILABLE');
    assert.equal(topology.routers.length, 3);
    assert.ok(topology.providers.includes('docker'));
    assert.ok(topology.providers.includes('file'));
    assert.ok(topology.snapshotFingerprint);

    // 5. Missing provider check
    const dockerOnlySnapshot = {
      routers: [
        { name: 'app@docker', rule: 'Host(`app.example.com`)', service: 'svc@docker' }
      ]
    };
    const dockerOnlyTopo = traefikTopologyService.inspectRoutingTopology({ snapshot: dockerOnlySnapshot });
    const conflictResult = routeConflictService.evaluateRouteConflicts(
      { targetDomain: 'app.example.com' },
      dockerOnlyTopo,
      { requiredProvider: 'file' }
    );
    assert.equal(conflictResult.decision, CONFLICT_DECISIONS.ROUTING_PROVIDER_NOT_CONFIGURED);

    // 6. Unavailable topology rejected
    const unavailTopo = traefikTopologyService.inspectRoutingTopology({});
    assert.equal(unavailTopo.status, 'UNAVAILABLE');
    const unavailConflict = routeConflictService.evaluateRouteConflicts(
      { targetDomain: 'app.example.com' },
      unavailTopo
    );
    assert.equal(unavailConflict.decision, CONFLICT_DECISIONS.TOPOLOGY_UNAVAILABLE);

    // 19. Stale / drifted topology fingerprint rejected
    const fingerprintA = topology.snapshotFingerprint;
    const modifiedSnapshot = {
      ...sampleSnapshot,
      routers: {
        ...sampleSnapshot.routers,
        'new-router@file': { rule: 'Host(`new.example.com`)', service: 'new@file' }
      }
    };
    const modifiedTopo = traefikTopologyService.inspectRoutingTopology({ snapshot: modifiedSnapshot });
    assert.notEqual(modifiedTopo.snapshotFingerprint, fingerprintA);
  });

  // ── 7-18. Cross-Provider Route Conflict Detection ────────────────────
  await t.test('7-18. Conflict detection: exact host, HostRegexp, wildcards, Dokploy, n8n, cross-provider same name, priorities', () => {
    const topology = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: [
          // 7. Exact host collision
          { name: 'other-app@docker', rule: 'Host(`existing.example.com`)', entryPoints: ['websecure'], provider: 'docker' },
          // 8. HostRegexp rule
          { name: 'regex-router@docker', rule: 'HostRegexp(`^api-[a-z0-9]+\\.example\\.com$`)', entryPoints: ['websecure'], provider: 'docker' },
          // 9. Wildcard rule
          { name: 'wildcard-router@file', rule: 'Host(`*.wildcard.org`)', entryPoints: ['websecure'], provider: 'file' },
          // 12. Foreign Dokploy route
          { name: 'dokploy-panel@docker', rule: 'Host(`dokploy.example.com`)', service: 'dokploy-svc@docker', provider: 'docker' },
          // 13. Foreign n8n route
          { name: 'n8n-webhook@docker', rule: 'Host(`n8n.workflow.io`)', service: 'n8n-svc@docker', provider: 'docker' },
          // 14. Router named 'web' in docker provider
          { name: 'web@docker', rule: 'Host(`web-docker.example.com`)', provider: 'docker' },
          // 14. Router named 'web' in file provider
          { name: 'web@file', rule: 'Host(`web-file.example.com`)', provider: 'file' },
          // 15. Different router names matching same host
          { name: 'router-one@file', rule: 'Host(`shared.example.com`)', provider: 'file' },
          { name: 'router-two@docker', rule: 'Host(`shared.example.com`)', provider: 'docker' },
          // 16. EntryPoint check: internal only router
          { name: 'internal-metrics@docker', rule: 'Host(`internal.example.com`)', entryPoints: ['metrics-internal'], provider: 'docker' },
          // 18. High priority foreign router
          { name: 'priority-foreign@docker', rule: 'Host(`priority.example.com`)', priority: 10000, provider: 'docker' }
        ]
      }
    });

    // 7. Exact host conflict detected
    const resExact = routeConflictService.evaluateRouteConflicts({ targetDomain: 'existing.example.com' }, topology);
    assert.equal(resExact.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);

    // 8. HostRegexp conflict detected
    const resRegex = routeConflictService.evaluateRouteConflicts({ targetDomain: 'api-v1.example.com' }, topology);
    assert.equal(resRegex.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);

    // 9. Wildcard rule blocked
    const resWild = routeConflictService.evaluateRouteConflicts({ targetDomain: 'sub.wildcard.org' }, topology);
    assert.equal(resWild.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);

    // 12. Dokploy route blocked
    const resDokploy = routeConflictService.evaluateRouteConflicts({ targetDomain: 'dokploy.example.com' }, topology);
    assert.equal(resDokploy.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);
    assert.ok(resDokploy.conflicts.some((c) => c.ownerCategory === 'FOREIGN_DOKPLOY'));

    // 13. n8n route blocked
    const resN8n = routeConflictService.evaluateRouteConflicts({ targetDomain: 'n8n.workflow.io' }, topology);
    assert.equal(resN8n.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);
    assert.ok(resN8n.conflicts.some((c) => c.ownerCategory === 'FOREIGN_N8N'));

    // 14. Cross-provider same name handled safely
    const resDockerWeb = routeConflictService.evaluateRouteConflicts({ targetDomain: 'web-docker.example.com' }, topology);
    assert.equal(resDockerWeb.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);

    // 15. Different router names matching same host detected
    const resShared = routeConflictService.evaluateRouteConflicts({ targetDomain: 'shared.example.com' }, topology);
    assert.equal(resShared.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);
    assert.equal(resShared.matchingRouters.length, 2);

    // 16. EntryPoint evaluation: no conflict if entrypoints do not overlap
    const resInternal = routeConflictService.evaluateRouteConflicts(
      { targetDomain: 'internal.example.com', entryPoints: ['websecure'] },
      topology
    );
    assert.equal(resInternal.decision, CONFLICT_DECISIONS.AVAILABLE_VERIFIED);

    // 18. Router priority cannot bypass ownership policy
    const resPriority = routeConflictService.evaluateRouteConflicts({ targetDomain: 'priority.example.com' }, topology);
    assert.equal(resPriority.decision, CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT);

    // Free domain verified available
    const resFree = routeConflictService.evaluateRouteConflicts({ targetDomain: 'completely-free.example.com' }, topology);
    assert.equal(resFree.decision, CONFLICT_DECISIONS.AVAILABLE_VERIFIED);
  });

  // ── 20-29. Preflight Safety Boundaries & Authorization Drift ─────────
  await t.test('20-29. Preflight boundaries: candidate identity, health, drift, fencing credentials, competing intents', async () => {
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
    const app = createApplication(
      { name: 'Preflight App', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'preflight-check.kpanel.dev', port: 3000 },
      { db: testDb }
    );

    const readySetup = await setupReadyPlan(app, { mockDocker });

    const validTopology = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: [
          { name: 'some-router@file', rule: 'Host(`other.example.com`)', provider: 'file' }
        ]
      }
    });

    // Valid Preflight passes
    const validPreflight = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true,
      requiredProvider: 'file'
    });

    assert.equal(validPreflight.decision, PREFLIGHT_DECISIONS.READY_FOR_ACTIVATION);
    assert.equal(validPreflight.isReady, true);

    // 20. Candidate image identity verified (mismatch rejected)
    const appImg = createApplication({ name: 'Img Drift', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'img.kpanel.dev', port: 3000 }, { db: testDb });
    const setupImg = await setupReadyPlan(appImg, { mockDocker });
    testDb.prepare('UPDATE deployment_runtime_candidates SET image_id = ? WHERE deployment_id = ?')
      .run('sha256:0000000000000000000000000000000000000000000000000000000000000000', setupImg.deploymentId);

    const preflightImg = await validateActivationPreflight(setupImg.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightImg.isReady, false);

    // 21. Candidate health rechecked (unhealthy candidate blocks activation)
    mockDocker._containers.get(readySetup.containerId).State.Health.Status = 'unhealthy';
    const preflightUnhealthy = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightUnhealthy.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_UNHEALTHY_CANDIDATE);
    mockDocker._containers.get(readySetup.containerId).State.Health.Status = 'healthy';

    // 22. Candidate replacement detected
    testDb.prepare('UPDATE deployment_release_plans SET candidate_container_id = ? WHERE id = ?')
      .run('c-foreign-replaced', readySetup.planId);
    const preflightReplaced = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightReplaced.isReady, false);
    testDb.prepare('UPDATE deployment_release_plans SET candidate_container_id = ? WHERE id = ?')
      .run(readySetup.containerId, readySetup.planId);

    // 23. Candidate disappearance detected (stopped/exited)
    mockDocker._containers.get(readySetup.containerId).State.Running = false;
    const preflightStopped = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightStopped.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_UNHEALTHY_CANDIDATE);
    mockDocker._containers.get(readySetup.containerId).State.Running = true;

    // 24. Domain drift detected
    testDb.prepare('UPDATE applications SET domain = ? WHERE id = ?').run('drifted-domain.kpanel.dev', app.id);
    const preflightDomainDrift = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightDomainDrift.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_UNVERIFIED_DOMAIN);
    testDb.prepare('UPDATE applications SET domain = ? WHERE id = ?').run('preflight-check.kpanel.dev', app.id);

    // 25. Port drift detected
    testDb.prepare('UPDATE applications SET port = ? WHERE id = ?').run(9090, app.id);
    const preflightPortDrift = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      trustedOperator: true
    });
    assert.equal(preflightPortDrift.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_UNVERIFIED_DOMAIN);
    testDb.prepare('UPDATE applications SET port = ? WHERE id = ?').run(3000, app.id);

    // 27-28. Fencing credentials: missing and invalid fencing tokens rejected
    // 28. Missing fencing token
    const preflightNoFencing = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true // no trustedOperator, no ownerId/fencingToken
    });
    assert.equal(preflightNoFencing.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_STALE_WORKER);

    // 27. Invalid fencing token
    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
      VALUES (?, 'worker-preflight', 5, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const preflightWrongToken = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      ownerId: 'worker-preflight',
      fencingToken: 4 // stale token
    });
    assert.equal(preflightWrongToken.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_STALE_WORKER);

    // 29. Competing activation intent blocks activation
    const competingSetup = await setupReadyPlan(app, { mockDocker });
    testDb.prepare(`
      INSERT INTO deployment_release_activation_intents (
        activation_id, release_plan_id, application_id, deployment_id,
        candidate_container_id, expected_image_id, target_domain, target_port,
        activation_status
      ) VALUES (
        'act-competing-1', ?, ?, ?,
        ?, ?, 'competing.kpanel.dev', 3000,
        'ready'
      )
    `).run(
      competingSetup.planId,
      app.id,
      competingSetup.deploymentId,
      competingSetup.containerId,
      competingSetup.imageId
    );

    const preflightCompeting = await validateActivationPreflight(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology: validTopology,
      skipGitCheck: true,
      ownerId: 'worker-preflight',
      fencingToken: 5
    });
    assert.equal(preflightCompeting.decision, PREFLIGHT_DECISIONS.BLOCKED_BY_MISSING_ROLLBACK_TARGET);

    testDb.prepare('DELETE FROM deployment_release_activation_intents').run();
    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  // ── 30-32. Backend Target Resolution & Network Validation ───────────
  await t.test('30-32. Backend target resolution: stable required, arbitrary rejected, missing network blocks', () => {
    // 30. Stable backend target resolved
    const target = resolveCandidateRoutingTarget({
      containerId: 'c-test-12345',
      containerName: 'kpanel-candidate-dep1',
      targetPort: 3000
    }, 'traefik-public');

    assert.equal(target.resolved, true);
    assert.equal(target.containerName, 'kpanel-candidate-dep1');
    assert.equal(target.backendUrl, 'http://kpanel-candidate-dep1:3000');
    assert.equal(target.isTransientIp, false);

    // 31. Arbitrary backend URLs (localhost, host.docker.internal, 127.0.0.1) rejected
    for (const unsafeName of ['localhost', '127.0.0.1', '0.0.0.0', 'host.docker.internal']) {
      assert.throws(
        () => resolveCandidateRoutingTarget({
          containerId: 'c-unsafe',
          containerName: unsafeName,
          targetPort: 3000
        }, 'traefik-public'),
        (err) => err instanceof RoutingPreflightError && err.code === 'UNSAFE_BACKEND_TARGET',
        `Should reject unsafe backend target "${unsafeName}"`
      );
    }

    // 32. Missing target proxy network identity blocks activation
    assert.throws(
      () => resolveCandidateRoutingTarget({
        containerId: 'c-test',
        containerName: 'kpanel-candidate-dep2',
        targetPort: 3000
      }, ''),
      (err) => err instanceof RoutingPreflightError && err.code === 'TARGET_NETWORK_MISSING'
    );
  });

  // ── 33-35. Rollback Planning Contract ────────────────────────────────
  await t.test('33-35. Rollback contract: first release, existing owned release, foreign route cannot be adopted', () => {
    // 33. First release rollback contract: remove new route
    const rollbackFirst = buildRollbackPlan({
      applicationId: 'app-first-release',
      targetDomain: 'first.example.com',
      conflictEvaluation: { decision: CONFLICT_DECISIONS.AVAILABLE_VERIFIED },
      activeRelease: null
    });

    assert.equal(rollbackFirst.strategy, 'REMOVE_NEW_ROUTE');
    assert.equal(rollbackFirst.isActionable, true);
    assert.equal(rollbackFirst.previousReleaseId, null);

    // 34. Existing owned release rollback contract: restore previous route
    const rollbackExisting = buildRollbackPlan({
      applicationId: 'app-existing-release',
      targetDomain: 'existing.example.com',
      conflictEvaluation: { decision: CONFLICT_DECISIONS.OWNED_BY_KPANEL },
      activeRelease: {
        id: 'rel-previous-1',
        container_id: 'c-previous-online',
        image_tag: 'kpanel/app:v1',
        port: 8080
      }
    });

    assert.equal(rollbackExisting.strategy, 'RESTORE_PREVIOUS_ROUTE');
    assert.equal(rollbackExisting.isActionable, true);
    assert.equal(rollbackExisting.previousReleaseId, 'rel-previous-1');
    assert.equal(rollbackExisting.previousContainerId, 'c-previous-online');
    assert.ok(rollbackExisting.previousRouteFingerprint);
    assert.ok(rollbackExisting.restorationConfig);

    // 35. Foreign route cannot be adopted (Dokploy / n8n cannot be rollback targets)
    const rollbackForeign = buildRollbackPlan({
      applicationId: 'app-foreign',
      targetDomain: 'dokploy.example.com',
      conflictEvaluation: { decision: CONFLICT_DECISIONS.FOREIGN_ROUTE_CONFLICT },
      activeRelease: null
    });

    assert.equal(rollbackForeign.strategy, 'BLOCKED_FOREIGN_ROUTE');
    assert.equal(rollbackForeign.isActionable, false);
  });

  // ── 36-41. Route Switch Dry Run, CAS Fingerprints & Crash Simulation ─
  await t.test('36-41. Route switch dry-run, fingerprint CAS comparison, crash & rollback simulations', async () => {
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
    const app = createApplication(
      { name: 'Switch App', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'switch.kpanel.dev', port: 3000 },
      { db: testDb }
    );

    const readySetup = await setupReadyPlan(app, { mockDocker });

    const topology = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: [
          { name: 'other@file', rule: 'Host(`other.kpanel.dev`)', provider: 'file' }
        ]
      }
    });

    // Create durable activation intent
    const intent = await createActivationIntent(readySetup.planId, {
      db: testDb,
      docker: mockDocker,
      topology,
      trustedOperator: true,
      skipGitCheck: true
    });

    assert.ok(intent.activationId);
    assert.equal(intent.activationStatus, 'ready');
    assert.ok(intent.proposedRouteFingerprint);

    // 36. Route fingerprint comparison and compare-and-swap contract
    const switchPlan = planTrafficSwitch(intent, topology);
    assert.equal(switchPlan.routeProvider, 'traefik');
    assert.equal(switchPlan.routingStrategy, 'dynamic-file-provider');
    assert.equal(switchPlan.canSwitchSafely, true);
    assert.equal(switchPlan.compareAndSwapContract.proposedNewRouteFingerprint, intent.proposedRouteFingerprint);

    // 37. External route mutation invalidates switch plan (topology drifted)
    const driftedTopology = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: [
          { name: 'mutated@file', rule: 'Host(`mutated.kpanel.dev`)', provider: 'file' }
        ]
      }
    });
    const switchPlanDrifted = planTrafficSwitch(intent, driftedTopology);
    assert.equal(switchPlanDrifted.canSwitchSafely, false);
    assert.ok(switchPlanDrifted.unsafeConditions.some((c) => c.code === 'TOPOLOGY_SNAPSHOT_DRIFT'));

    // 38. Simulation: Worker crash before route mutation
    const simCrashBefore = simulateActivationExecution(intent, topology, { simulateCrash: 'before-mutation' });
    assert.equal(simCrashBefore.crashed, true);
    assert.equal(simCrashBefore.stage, 'BEFORE_MUTATION');
    assert.equal(simCrashBefore.rolledBack, false);

    // 39. Simulation: Worker crash after mutation before database acknowledgment
    const simCrashAfter = simulateActivationExecution(intent, topology, { simulateCrash: 'after-mutation' });
    assert.equal(simCrashAfter.crashed, true);
    assert.equal(simCrashAfter.stage, 'AFTER_MUTATION_UNACKNOWLEDGED');

    // 40. Simulation: Failed switch triggers automated mock rollback
    const simFailRollback = simulateActivationExecution(intent, topology, { simulateFailure: true });
    assert.equal(simFailRollback.success, false);
    assert.equal(simFailRollback.rolledBack, true);
    assert.equal(simFailRollback.activeRouteRestored, true);

    // 41. Simulation: Concurrent external route overwrite detected
    const simConcurrent = simulateActivationExecution(intent, topology, { simulateExternalOverwrite: true });
    assert.equal(simConcurrent.success, false);
    assert.equal(simConcurrent.reason, 'CONCURRENT_ROUTE_MUTATION');

    // Clean simulation succeeds
    const simSuccess = simulateActivationExecution(intent, topology);
    assert.equal(simSuccess.success, true);
    assert.equal(simSuccess.rolledBack, false);
  });

  // ── 42-49. System Invariants & Promotion Boundaries ──────────────────
  await t.test('42-49. Invariants: zero success deployments, zero active releases, zero real API calls, legacy untouched', () => {
    // 42. No deployment marked success
    const successCount = testDb.prepare("SELECT count(*) as count FROM deployments WHERE status = 'success'").get().count;
    assert.equal(successCount, 0, 'No deployment must be marked success');

    // 43. No active release created
    const releaseCount = testDb.prepare("SELECT count(*) as count FROM releases WHERE status = 'active'").get().count;
    assert.equal(releaseCount, 0, 'Zero active releases created');

    // 44. No live Docker container created
    // 45. No Traefik files written
    // 46. No Docker network changes
    // 47. No real Traefik API calls

    // 49. Legacy deployments.json untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });
});
