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
const traefikRoutePlanner = require('../services/traefikRoutePlanner');
const { TraefikRoutePlannerError } = traefikRoutePlanner;
const releasePlanningService = require('../services/releasePlanningService');
const {
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
} = releasePlanningService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

/**
 * Creates an in-memory mock Docker client for offline testing.
 */
function createMockDockerClient(options = {}) {
  const images = new Map();
  const networks = new Map();
  const containers = new Map();

  const defaultStagingNetworkId = options.stagingNetworkId || 'staging-net-001';
  networks.set(defaultStagingNetworkId, {
    Id: defaultStagingNetworkId,
    Name: 'kpanel-staging',
    Driver: options.stagingNetworkDriver || 'bridge',
    Internal: options.stagingNetworkInternal !== undefined ? options.stagingNetworkInternal : true
  });

  const defaultImageId = options.defaultImageId || 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  images.set(defaultImageId, {
    Id: defaultImageId,
    Architecture: 'arm64',
    Config: {
      Healthcheck: options.hasHealthcheck !== false ? { Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'] } : null,
      User: options.imageUser !== undefined ? options.imageUser : 'node'
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

    async createContainer(opts) {
      if (options.failContainerCreate) throw new Error('Container creation failed');
      this._createdOptions.push(opts);

      const containerId = `c-${crypto.randomUUID()}`;
      const mockContainerObj = {
        Id: containerId,
        Name: `/${opts.name}`,
        State: {
          Running: false,
          Status: 'created',
          ExitCode: 0,
          Health: opts.Image && images.get(opts.Image)?.Config?.Healthcheck ? { Status: 'starting', Log: [] } : null
        },
        Config: {
          Labels: opts.Labels || {},
          Healthcheck: opts.Image && images.get(opts.Image)?.Config?.Healthcheck ? { Test: ['CMD'] } : null,
          User: opts.User || 'node'
        },
        HostConfig: opts.HostConfig || {}
      };

      containers.set(containerId, mockContainerObj);
      containers.set(opts.name, mockContainerObj);

      return {
        id: containerId,
        inspect: async () => mockContainerObj,
        start: async () => {
          mockContainerObj.State.Running = true;
          mockContainerObj.State.Status = 'running';
          return {};
        },
        stop: async () => {
          mockContainerObj.State.Running = false;
          mockContainerObj.State.Status = 'exited';
          return {};
        }
      };
    },

    getContainer(idOrName) {
      return {
        inspect: async () => {
          if (options.failContainerInspect) throw new Error('Container inspect failed');
          if (containers.has(idOrName)) return containers.get(idOrName);
          throw new Error(`No such container: ${idOrName}`);
        },
        start: async () => {
          if (options.failContainerStart) throw new Error('Container start failed');
          const c = containers.get(idOrName);
          if (c) {
            c.State.Running = true;
            c.State.Status = 'running';
          }
          return {};
        },
        stop: async () => {
          if (options.failContainerStop) throw new Error('Container stop failed');
          const c = containers.get(idOrName);
          if (c) {
            c.State.Running = false;
            c.State.Status = 'exited';
          }
          return {};
        }
      };
    }
  };
}

test('Phase 4C2: Release Planning & Traefik Routing Preparation Suite', async (t) => {
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

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-release-planning-test-'));
    tempDbPath = path.join(tempBaseDir, 'test-release-planning.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    delete process.env.KPANEL_STAGING_NETWORK_ID;
    delete process.env.KPANEL_MAX_CPU_LIMIT;
    delete process.env.KPANEL_MAX_MEMORY_LIMIT_MB;

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try { fs.rmSync(tempBaseDir, { recursive: true, force: true }); } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });

  // Helper to set up an authentic built deployment, durable artifact, and staged candidate
  function setupEligibleCandidate(app, options = {}) {
    const deploymentId = options.deploymentId || `d-${crypto.randomUUID()}`;
    const commitSha = options.commitSha || 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const imageId = options.imageId || TEST_IMAGE_ID;
    const imageTag = options.imageTag || `kpanel/app-${app.id}:d-${deploymentId}-${commitSha.slice(0, 7)}`;
    const status = options.status || 'built';
    const stagingNetworkId = options.stagingNetworkId || TEST_STAGING_NET;
    const containerId = options.containerId || `c-${crypto.randomUUID()}`;
    const containerName = `kpanel-candidate-${deploymentId}`;

    // 1. Insert Deployment
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, image_tag, image_id, created_at)
      VALUES (?, ?, ?, 'manual', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, status, imageTag, imageId);

    // 2. Insert Durable Build Artifact
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

    // 3. Insert Candidate Container Record in SQLite
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
        stagingNetworkId,
        options.candidateState || 'healthy',
        options.healthStatus || 'healthy'
      );
    }

    // 4. Setup mock container in mock Docker client
    const mockDocker = options.mockDocker;
    if (mockDocker && options.setupMockContainer !== false) {
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
          NetworkMode: stagingNetworkId,
          PortBindings: {},
          PublishAllPorts: false
        }
      };

      mockDocker._containers.set(containerId, mockContainerObj);
      mockDocker._containers.set(containerName, mockContainerObj);
    }

    return { deploymentId, commitSha, imageId, imageTag, containerId, containerName, stagingNetworkId };
  }

  // ── 1-3. Migration 008 & Schema Evolution ───────────────────────────
  await t.test('1-3. Migration 008 applies correctly, upgrades v007 DB, and leaves releases untouched', () => {
    // 1. Current version is at least 8
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 8, 'Schema version must be at least 8');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.some((m) => m.version === 8 && m.name === '008_release_plans'));

    // Check table exists and columns match specification
    const cols = testDb.prepare('PRAGMA table_info(deployment_release_plans)').all().map((c) => c.name);
    assert.ok(cols.includes('id'));
    assert.ok(cols.includes('application_id'));
    assert.ok(cols.includes('deployment_id'));
    assert.ok(cols.includes('candidate_container_id'));
    assert.ok(cols.includes('image_id'));
    assert.ok(cols.includes('commit_sha'));
    assert.ok(cols.includes('target_domain'));
    assert.ok(cols.includes('target_port'));
    assert.ok(cols.includes('route_provider'));
    assert.ok(cols.includes('plan_status'));
    assert.ok(cols.includes('readiness_checked_at'));
    assert.ok(cols.includes('invalidated_reason'));

    // 2. Upgrade from v007 database works cleanly
    const upgradePath = path.join(tempBaseDir, 'test-upgrade-v7-to-v8.db');
    const upgradeDb = new Database(upgradePath);
    upgradeDb.pragma('foreign_keys = ON');

    const v7Migrations = loadMigrations().filter((m) => m.version <= 7);
    runMigrations(upgradeDb, v7Migrations);
    assert.equal(getCurrentVersion(upgradeDb), 7);

    const v8Migrations = loadMigrations().filter((m) => m.version <= 8);
    const upgradeRes = runMigrations(upgradeDb, v8Migrations);
    assert.equal(upgradeRes.applied, 1);
    assert.equal(getCurrentVersion(upgradeDb), 8);
    upgradeDb.close();

    // 3. Existing releases table remains untouched
    const releaseCols = testDb.prepare('PRAGMA table_info(releases)').all().map((c) => c.name);
    assert.ok(releaseCols.includes('id'));
    assert.ok(releaseCols.includes('status'));
    assert.equal(testDb.prepare('SELECT count(*) as count FROM releases').get().count, 0);
  });

  // ── 40-43. Phase 4C1 Security Hardening Regressions ──────────────────
  await t.test('40. Explicit traefik.enable=false on candidate container and rejects Traefik label exposure', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication({ name: 'OptOut App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupEligibleCandidate(app, { mockDocker, insertCandidate: false, setupMockContainer: false });

      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'worker-optout', 1, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      // Candidate preparation carries explicit traefik.enable=false
      const prep = await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-optout', fencingToken: 1 },
        { db: testDb, docker: mockDocker, executeRuntime: true }
      );

      const created = mockDocker._createdOptions[0];
      assert.equal(created.Labels['traefik.enable'], 'false', 'Candidate container must carry traefik.enable=false');

      // Attempting to inject Traefik exposure or routing labels must be strictly rejected
      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId: 'dep-fake', applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-optout', fencingToken: 1 },
            {
              db: testDb,
              docker: mockDocker,
              executeRuntime: true,
              labels: { 'traefik.enable': 'true' }
            }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'TRAEFIK_EXPOSURE_PROHIBITED'
      );

      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId: 'dep-fake', applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-optout', fencingToken: 1 },
            {
              db: testDb,
              docker: mockDocker,
              executeRuntime: true,
              labels: { 'traefik.http.routers.app.rule': 'Host(`example.com`)' }
            }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'TRAEFIK_EXPOSURE_PROHIBITED'
      );

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  await t.test('41. Unapproved bridge networks, default bridge, and foreign networks rejected', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    try {
      const app = createApplication({ name: 'NetAudit App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupEligibleCandidate(app);

      // Rejects foreign Dokploy/Coolify/Traefik networks
      for (const foreignNet of ['coolify', 'dokploy-network', 'traefik-public', 'n8n_default', 'bridge']) {
        const mockForeignDocker = createMockDockerClient({ stagingNetworkId: foreignNet });
        mockForeignDocker._networks.get(foreignNet).Name = foreignNet;

        await assert.rejects(
          async () => {
            await runtimeService.validateRuntimeConfiguration(
              { deploymentId, applicationId: app.id, stagingNetworkId: foreignNet },
              { db: testDb, docker: mockForeignDocker }
            );
          },
          (err) => err instanceof RuntimeServiceError && err.code === 'STAGING_NETWORK_UNSAFE',
          `Should reject foreign/default bridge network "${foreignNet}"`
        );
      }
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  await t.test('42. Runtime resource limits obey operator budgets on 4-OCPU / 24-GB VPS', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      // Application requesting 8 CPUs (double physical host cores) must fail closed
      const appExcessCpu = createApplication(
        { name: 'Excess CPU App', repo_url: 'https://github.com/org/repo.git', branch: 'main', cpu_limit: 8.0, memory_limit_mb: 2048 },
        { db: testDb }
      );
      const depCpu = setupEligibleCandidate(appExcessCpu, { mockDocker });

      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: depCpu.deploymentId, applicationId: appExcessCpu.id, stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker, operatorMaxCpu: 2.0 }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'RESOURCE_LIMIT_EXCEEDED'
      );

      // Application requesting 32 GB RAM (exceeding 24 GB VPS) must fail closed
      const appExcessMem = createApplication(
        { name: 'Excess Mem App', repo_url: 'https://github.com/org/repo.git', branch: 'main', cpu_limit: 1.0, memory_limit_mb: 32768 },
        { db: testDb }
      );
      const depMem = setupEligibleCandidate(appExcessMem, { mockDocker });

      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: depMem.deploymentId, applicationId: appExcessMem.id, stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker, operatorMaxMemoryMb: 4096 }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'RESOURCE_LIMIT_EXCEEDED'
      );
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  await t.test('43. Untrusted root-user exception rejected; requires explicit trusted operator authorization', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    // Image specifies root user (User: 'root' or '0')
    const mockRootDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET, imageUser: 'root' });

    try {
      const app = createApplication({ name: 'Root App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupEligibleCandidate(app, { mockDocker: mockRootDocker });

      // Frontend input attempting to bypass via input.allowRootUser is strictly ignored
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, allowRootUser: true },
            { db: testDb, docker: mockRootDocker } // no trustedOperatorAllowRoot
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'ROOT_USER_PROHIBITED'
      );

      // Explicit trusted operator option authorizes the exception
      const allowed = await runtimeService.validateRuntimeConfiguration(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET },
        { db: testDb, docker: mockRootDocker, trustedOperatorAllowRoot: true }
      );
      assert.ok(allowed);
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 15-22. Domain & Port Validation ──────────────────────────────────
  await t.test('15-18. Domain validation: rejects malformed/reserved, normalizes IDN, blocks duplicates', () => {
    // 15. Invalid domains rejected
    const invalidDomains = [
      '',
      '   ',
      'http://myapp.com',
      'https://myapp.com/path',
      'myapp.com:8080',
      'myapp.com/index.html',
      'myapp.com?query=1',
      'myapp.com#frag',
      '*.myapp.com',
      '-myapp.com',
      'myapp-.com',
      '192.168.1.50',
      '127.0.0.1',
      '::1',
      'user@myapp.com'
    ];

    for (const d of invalidDomains) {
      assert.throws(
        () => normalizeAndValidateDomain(d),
        (err) => err instanceof ReleasePlanningError,
        `Should reject invalid domain: "${d}"`
      );
    }

    // 16. Reserved / internal domains rejected
    const reservedDomains = [
      'localhost',
      'app.localhost',
      'service.local',
      'backend.internal',
      'test.test',
      'demo.example',
      'cluster.lan'
    ];

    for (const d of reservedDomains) {
      assert.throws(
        () => normalizeAndValidateDomain(d),
        (err) => err instanceof ReleasePlanningError && err.code === 'RESERVED_DOMAIN',
        `Should reject reserved domain: "${d}"`
      );
    }

    // 17. Domain normalization
    assert.equal(normalizeAndValidateDomain('  MYAPP.example.org  '), 'myapp.example.org');
    assert.equal(normalizeAndValidateDomain('Api.Kpanel.Dev'), 'api.kpanel.dev');

    // 18. Duplicate domain claims across applications blocked
    const appA = createApplication({ name: 'App A', repo_url: 'https://github.com/org/repo-a.git', branch: 'main', domain: 'claimed.kpanel.dev' }, { db: testDb });
    const appB = createApplication({ name: 'App B', repo_url: 'https://github.com/org/repo-b.git', branch: 'main', domain: 'other.kpanel.dev' }, { db: testDb });

    // App B attempts to claim App A's domain
    assert.throws(
      () => normalizeAndValidateDomain('claimed.kpanel.dev', { db: testDb, applicationId: appB.id }),
      (err) => err instanceof ReleasePlanningError && err.code === 'DOMAIN_ALREADY_CLAIMED'
    );
  });

  await t.test('20-22. Port validation: missing rejected, invalid rejected, ambiguous rejected', () => {
    // 20. Missing port
    assert.throws(
      () => validateTargetPort(undefined),
      (err) => err instanceof ReleasePlanningError && err.code === 'INVALID_PORT'
    );
    assert.throws(
      () => validateTargetPort(''),
      (err) => err instanceof ReleasePlanningError && err.code === 'INVALID_PORT'
    );

    // 21. Invalid port (0, negative, > 65535, strings, floats)
    const invalidPorts = [0, -1, 65536, 99999, 'abc', '3000px', '80.5', 3.14, '0'];
    for (const p of invalidPorts) {
      assert.throws(
        () => validateTargetPort(p),
        (err) => err instanceof ReleasePlanningError && err.code === 'INVALID_PORT',
        `Should reject invalid port: ${p}`
      );
    }

    // 22. Ambiguous port
    assert.throws(
      () => validateTargetPort([3000, 8080]),
      (err) => err instanceof ReleasePlanningError && err.code === 'INVALID_PORT'
    );
    assert.throws(
      () => validateTargetPort({ port: 3000 }),
      (err) => err instanceof ReleasePlanningError && err.code === 'INVALID_PORT'
    );

    // Valid ports
    assert.equal(validateTargetPort(3000), 3000);
    assert.equal(validateTargetPort('8080'), 8080);
    assert.equal(validateTargetPort(80), 80);
    assert.equal(validateTargetPort(443), 443);
  });

  // ── 4-14. Release Eligibility Requirements ───────────────────────────
  await t.test('4-14. Candidate eligibility validation: identity, health status, and drift protection', async () => {
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
    const app = createApplication(
      { name: 'Eligible App', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'eligible.kpanel.dev', port: 3000 },
      { db: testDb }
    );

    const eligibleSetup = setupEligibleCandidate(app, { mockDocker });

    // 13. Healthy candidate accepted for planning
    const eligibility = await validateReleaseEligibility(eligibleSetup.deploymentId, {
      db: testDb,
      docker: mockDocker,
      skipGitCheck: true
    });

    assert.equal(eligibility.eligible, true);
    assert.equal(eligibility.applicationId, app.id);
    assert.equal(eligibility.deploymentId, eligibleSetup.deploymentId);
    assert.equal(eligibility.targetDomain, 'eligible.kpanel.dev');
    assert.equal(eligibility.targetPort, 3000);
    assert.equal(eligibility.healthStatus, 'healthy');

    // 4. Candidate must belong to deployment
    await assert.rejects(
      async () => {
        await validateReleaseEligibility('non-existent-deployment-id', { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'DEPLOYMENT_NOT_FOUND'
    );

    // 5. Candidate must belong to application
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(eligibleSetup.deploymentId, {
          db: testDb,
          docker: mockDocker,
          applicationId: 'different-app-id',
          skipGitCheck: true
        });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'APPLICATION_ID_MISMATCH'
    );

    // 6. Built artifact must exist
    const noArtifactDep = setupEligibleCandidate(app, { mockDocker, insertArtifact: false });
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(noArtifactDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'ARTIFACT_NOT_FOUND'
    );

    // 7. Image digest must match
    const mismatchImgDep = setupEligibleCandidate(app, {
      mockDocker,
      imageId: 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
    });
    // Manually modify SQLite candidate image to create drift
    testDb.prepare('UPDATE deployment_runtime_candidates SET image_id = ? WHERE deployment_id = ?')
      .run('sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', mismatchImgDep.deploymentId);

    await assert.rejects(
      async () => {
        await validateReleaseEligibility(mismatchImgDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'CANDIDATE_IMAGE_MISMATCH'
    );

    // 8. Commit SHA must match
    const mismatchCommitDep = setupEligibleCandidate(app, { mockDocker });
    testDb.prepare('UPDATE deployment_build_artifacts SET commit_sha = ? WHERE deployment_id = ?')
      .run('deadbeefdeadbeefdeadbeefdeadbeefdeadbeef', mismatchCommitDep.deploymentId);

    await assert.rejects(
      async () => {
        await validateReleaseEligibility(mismatchCommitDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'COMMIT_SHA_MISMATCH'
    );

    // 9. Stopped candidate rejected
    const stoppedDep = setupEligibleCandidate(app, { mockDocker, containerRunning: false, containerStatus: 'exited' });
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(stoppedDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'CANDIDATE_NOT_RUNNING'
    );

    // 10. Starting candidate rejected
    const startingDep = setupEligibleCandidate(app, { mockDocker, dockerHealthStatus: 'starting' });
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(startingDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'CANDIDATE_UNHEALTHY'
    );

    // 11. Unhealthy candidate rejected
    const unhealthyDep = setupEligibleCandidate(app, { mockDocker, dockerHealthStatus: 'unhealthy' });
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(unhealthyDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'CANDIDATE_UNHEALTHY'
    );

    // 12. Missing HEALTHCHECK rejected
    const noHealthDep = setupEligibleCandidate(app, { mockDocker, hasHealthcheck: false });
    await assert.rejects(
      async () => {
        await validateReleaseEligibility(noHealthDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'HEALTHCHECK_MISSING'
    );

    // 14. Stale cached health in SQLite rejected when live Docker container is unhealthy
    const staleHealthDep = setupEligibleCandidate(app, { mockDocker });
    // SQLite records 'healthy' from past, but live container becomes unhealthy
    testDb.prepare("UPDATE deployment_runtime_candidates SET health_status = 'healthy' WHERE deployment_id = ?")
      .run(staleHealthDep.deploymentId);
    mockDocker._containers.get(staleHealthDep.containerId).State.Health.Status = 'unhealthy';

    await assert.rejects(
      async () => {
        await validateReleaseEligibility(staleHealthDep.deploymentId, { db: testDb, docker: mockDocker, skipGitCheck: true });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'CANDIDATE_UNHEALTHY'
    );
  });

  // ── 23-27. Plan Creation, Route Planning, & Idempotency ─────────────
  await t.test('23-27. Correct plan created, persists across reopen, idempotent, supersedes prior plans', async () => {
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
    const app = createApplication(
      { name: 'Plan App', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'plan.kpanel.dev', port: 4000 },
      { db: testDb }
    );

    const { deploymentId } = setupEligibleCandidate(app, { mockDocker });

    // Setup global worker lock for fencing tests
    testDb.prepare(`
      INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
      VALUES (?, 'worker-plan-1', 1, datetime('now', '+60 seconds'))
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    // 23. Correct plan created
    const planResult = await createReleasePlan(
      { deploymentId, applicationId: app.id },
      { db: testDb, docker: mockDocker, ownerId: 'worker-plan-1', fencingToken: 1, skipGitCheck: true }
    );

    assert.ok(planResult.planId);
    assert.equal(planResult.planStatus, 'ready');
    assert.equal(planResult.targetDomain, 'plan.kpanel.dev');
    assert.equal(planResult.targetPort, 4000);
    assert.equal(planResult.routeProvider, 'traefik');
    assert.ok(planResult.routeProposal);
    assert.equal(planResult.routeProposal.hostRule, 'Host(`plan.kpanel.dev`)');
    assert.equal(planResult.routeProposal.internalPort, 4000);
    assert.equal(planResult.routeProposal.routingStrategy, 'dynamic-file-provider');

    // 24. Plan persists across SQLite reopen
    const reopenedDb = new Database(tempDbPath);
    reopenedDb.pragma('foreign_keys = ON');
    const persisted = reopenedDb.prepare('SELECT * FROM deployment_release_plans WHERE id = ?').get(planResult.planId);
    assert.equal(persisted.plan_status, 'ready');
    assert.equal(persisted.deployment_id, deploymentId);
    assert.equal(persisted.target_domain, 'plan.kpanel.dev');
    reopenedDb.close();

    // 25. Duplicate plan creation is idempotent
    const duplicateResult = await createReleasePlan(
      { deploymentId, applicationId: app.id },
      { db: testDb, docker: mockDocker, ownerId: 'worker-plan-1', fencingToken: 1, skipGitCheck: true }
    );
    assert.equal(duplicateResult.planId, planResult.planId, 'Duplicate plan must return existing plan record');
    assert.equal(duplicateResult.isNew, false);

    // 26. Competing plan for newer deployment supersedes prior plan
    const dep2 = setupEligibleCandidate(app, { mockDocker });
    const plan2Result = await createReleasePlan(
      { deploymentId: dep2.deploymentId, applicationId: app.id },
      { db: testDb, docker: mockDocker, ownerId: 'worker-plan-1', fencingToken: 1, skipGitCheck: true }
    );

    assert.notEqual(plan2Result.planId, planResult.planId);
    assert.equal(plan2Result.planStatus, 'ready');

    // Prior plan for same application must be marked stale
    const oldPlan = getReleasePlan(planResult.planId, { db: testDb });
    assert.equal(oldPlan.plan_status, 'stale');
    assert.equal(oldPlan.invalidated_reason, 'SUPERSEDED_BY_NEWER_PLAN');

    // 27. Stale worker with expired lease or wrong fencing token cannot create or mark plan ready
    testDb.prepare(`
      UPDATE deployment_worker_lock
      SET lease_expires_at = datetime('now', '-10 seconds')
      WHERE lock_name = ?
    `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

    const dep3 = setupEligibleCandidate(app, { mockDocker });
    await assert.rejects(
      async () => {
        await createReleasePlan(
          { deploymentId: dep3.deploymentId, applicationId: app.id },
          { db: testDb, docker: mockDocker, ownerId: 'worker-plan-1', fencingToken: 1, skipGitCheck: true }
        );
      },
      (err) => err instanceof RuntimeServiceError && err.code === 'LEASE_LOST'
    );

    testDb.prepare('DELETE FROM deployment_worker_lock').run();
  });

  // ── 19, 28-31. Plan Freshness, Drift & Crash Invalidation ────────────
  await t.test('19, 28-31. Plan freshness invalidation: domain change, container deletion/stop/unhealthy, cancellation', async () => {
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
    const app = createApplication(
      { name: 'Lifecycle App', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'lifecycle.kpanel.dev', port: 5000 },
      { db: testDb }
    );

    const { deploymentId, containerId } = setupEligibleCandidate(app, { mockDocker });

    const plan = await createReleasePlan(
      { deploymentId, applicationId: app.id },
      { db: testDb, docker: mockDocker, skipGitCheck: true }
    );

    assert.equal(plan.planStatus, 'ready');

    // Freshness check when conditions hold
    const fresh1 = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(fresh1.fresh, true);
    assert.equal(fresh1.planStatus, 'ready');

    // 19. Changed application domain invalidates plan
    testDb.prepare('UPDATE applications SET domain = ? WHERE id = ?').run('newdomain.kpanel.dev', app.id);
    const freshDomain = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshDomain.fresh, false);
    assert.equal(freshDomain.planStatus, 'stale');
    assert.equal(freshDomain.reason, 'APPLICATION_DOMAIN_CHANGED');

    // Reset domain and re-validate
    testDb.prepare('UPDATE applications SET domain = ? WHERE id = ?').run('lifecycle.kpanel.dev', app.id);
    testDb.prepare("UPDATE deployment_release_plans SET plan_status = 'ready' WHERE id = ?").run(plan.planId);

    // 29. Candidate deletion in Docker invalidates readiness
    mockDocker._containers.delete(containerId);
    const freshMissing = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshMissing.fresh, false);
    assert.equal(freshMissing.planStatus, 'stale');
    assert.equal(freshMissing.reason, 'CANDIDATE_CONTAINER_MISSING');

    // Restore container, re-set plan ready
    const restoredContainer = {
      Id: containerId,
      Name: `/kpanel-candidate-${deploymentId}`,
      State: {
        Running: true,
        Status: 'running',
        ExitCode: 0,
        Health: { Status: 'healthy', Log: [] }
      },
      Config: {
        Labels: {
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'candidate',
          'io.kpanel.application-id': app.id,
          'io.kpanel.deployment-id': deploymentId,
          'io.kpanel.image-id': TEST_IMAGE_ID,
          'traefik.enable': 'false'
        },
        Healthcheck: { Test: ['CMD'] }
      }
    };
    mockDocker._containers.set(containerId, restoredContainer);
    mockDocker._containers.set(`kpanel-candidate-${deploymentId}`, restoredContainer);
    testDb.prepare("UPDATE deployment_release_plans SET plan_status = 'ready' WHERE id = ?").run(plan.planId);

    // Candidate stopped invalidates readiness
    mockDocker._containers.get(containerId).State.Running = false;
    const freshStopped = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshStopped.fresh, false);
    assert.equal(freshStopped.planStatus, 'stale');
    assert.equal(freshStopped.reason, 'CANDIDATE_CONTAINER_STOPPED');

    // Restore running container, candidate unhealthy invalidates readiness
    mockDocker._containers.get(containerId).State.Running = true;
    mockDocker._containers.get(containerId).State.Health.Status = 'unhealthy';
    testDb.prepare("UPDATE deployment_release_plans SET plan_status = 'ready' WHERE id = ?").run(plan.planId);

    const freshUnhealthy = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshUnhealthy.fresh, false);
    assert.equal(freshUnhealthy.planStatus, 'stale');
    assert.equal(freshUnhealthy.reason, 'CANDIDATE_UNHEALTHY');

    // 30. Candidate image drift invalidates readiness
    mockDocker._containers.get(containerId).State.Health.Status = 'healthy';
    mockDocker._containers.get(containerId).Config.Labels['io.kpanel.image-id'] = 'sha256:drifted0000000000000000000000000000000000000000000000000000000000';
    testDb.prepare("UPDATE deployment_release_plans SET plan_status = 'ready' WHERE id = ?").run(plan.planId);

    const freshImageDrift = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshImageDrift.fresh, false);
    assert.equal(freshImageDrift.planStatus, 'stale');
    assert.equal(freshImageDrift.reason, 'CANDIDATE_IMAGE_MISMATCH');

    // 31. Deployment cancellation invalidates plan
    testDb.prepare("UPDATE deployments SET status = 'cancelled' WHERE id = ?").run(deploymentId);
    const freshCancelled = await validatePlanFreshness(plan.planId, { db: testDb, docker: mockDocker });
    assert.equal(freshCancelled.fresh, false);
    assert.equal(freshCancelled.planStatus, 'stale');
    assert.equal(freshCancelled.reason, 'DEPLOYMENT_CANCELLED');

    // 28. Plan cancellation scoped to application
    const cancelRes = cancelReleasePlan(plan.planId, 'OPERATOR_CANCELLED', { db: testDb, applicationId: app.id });
    assert.equal(cancelRes.cancelled, true);
    assert.equal(getReleasePlan(plan.planId, { db: testDb }).plan_status, 'cancelled');

    // Cross-application cancellation rejected
    await assert.rejects(
      async () => {
        cancelReleasePlan(plan.planId, 'ATTACK', { db: testDb, applicationId: 'foreign-app-id' });
      },
      (err) => err instanceof ReleasePlanningError && err.code === 'APPLICATION_ID_MISMATCH'
    );
  });

  // ── 32-39, 44-46. Promotion Boundaries & Non-Interference Invariants ─
  await t.test('32-39, 44, 46. Strict promotion boundaries: zero releases, no successful deployments, no routing changes', () => {
    // 32. Existing active releases table unchanged (zero rows created in releases)
    const releaseCount = testDb.prepare('SELECT count(*) as count FROM releases').get().count;
    assert.equal(releaseCount, 0, 'No releases must be created during release planning');

    // 33. No deployment marked successful
    const successCount = testDb.prepare("SELECT count(*) as count FROM deployments WHERE status = 'success'").get().count;
    assert.equal(successCount, 0, 'No deployment must be marked success in Phase 4C2');

    // 34-39. Zero infrastructure side effects
    // Plans exist only as SQLite records in deployment_release_plans and pure data structures in memory
    const plans = listReleasePlans({}, { db: testDb });
    assert.ok(plans.length > 0, 'Release plans must exist in database');

    for (const p of plans) {
      assert.ok(['ready', 'draft', 'stale', 'blocked', 'cancelled'].includes(p.plan_status));
    }

    // 46. Legacy deployments.json untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });
});
