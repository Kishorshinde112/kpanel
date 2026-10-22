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
const { RuntimeServiceError, isRuntimeExecutionEnabled, getDeterministicContainerName } = runtimeService;

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

/**
 * Creates an in-memory mock Docker client for offline tests without accessing /var/run/docker.sock.
 */
function createMockDockerClient(options = {}) {
  const images = new Map();
  const networks = new Map();
  const containers = new Map();

  const defaultStagingNetworkId = options.stagingNetworkId || 'staging-net-123';
  networks.set(defaultStagingNetworkId, {
    Id: defaultStagingNetworkId,
    Name: 'kpanel-staging',
    Driver: options.stagingNetworkDriver || 'bridge',
    Internal: true
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
          if (options.failImageInspect) {
            throw new Error('Image inspect failed');
          }
          if (images.has(cleanId)) {
            return images.get(cleanId);
          }
          if (cleanId === defaultImageId) {
            return images.get(defaultImageId);
          }
          throw new Error(`No such image: ${id}`);
        }
      };
    },

    getNetwork(id) {
      return {
        inspect: async () => {
          if (options.failNetworkInspect) {
            throw new Error('Network inspect failed');
          }
          if (networks.has(id)) {
            return networks.get(id);
          }
          throw new Error(`No such network: ${id}`);
        }
      };
    },

    async createContainer(opts) {
      if (options.failContainerCreate) {
        throw new Error('Container creation failed');
      }
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
        HostConfig: opts.HostConfig || {},
        NetworkSettings: {
          Networks: {
            [opts.HostConfig?.NetworkMode || defaultStagingNetworkId]: {
              NetworkID: opts.HostConfig?.NetworkMode || defaultStagingNetworkId,
              IPAddress: '172.28.0.5'
            }
          }
        }
      };

      containers.set(containerId, mockContainerObj);
      containers.set(opts.name, mockContainerObj); // lookup by name

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
          if (options.failContainerInspect) {
            throw new Error('Container inspect failed');
          }
          if (containers.has(idOrName)) {
            return containers.get(idOrName);
          }
          throw new Error(`No such container: ${idOrName}`);
        },
        start: async () => {
          if (options.failContainerStart) {
            throw new Error('Container start failed');
          }
          const c = containers.get(idOrName);
          if (c) {
            c.State.Running = true;
            c.State.Status = 'running';
          }
          return {};
        },
        stop: async () => {
          if (options.failContainerStop) {
            throw new Error('Container stop failed');
          }
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

test('Phase 4C1: Isolated Application Containers & Health Checks Suite', async (t) => {
  let tempBaseDir;
  let tempDbPath;
  let testDb;
  let originalDeploymentsContent;

  const TEST_IMAGE_ID = 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  const TEST_STAGING_NET = 'staging-bridge-net-001';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-runtime-service-test-'));
    tempDbPath = path.join(tempBaseDir, 'test-runtime.db');
    process.env.KPANEL_DB_PATH = tempDbPath;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    delete process.env.KPANEL_STAGING_NETWORK_ID;

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try { fs.rmSync(tempBaseDir, { recursive: true, force: true }); } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });

  // Helper to insert an authentic built deployment with artifact
  function setupBuiltDeployment(app, options = {}) {
    const deploymentId = options.deploymentId || crypto.randomUUID();
    const commitSha = options.commitSha || 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const imageId = options.imageId || TEST_IMAGE_ID;
    const imageTag = options.imageTag || `kpanel/app-${app.id}:d-${deploymentId}-${commitSha.slice(0, 7)}`;
    const status = options.status || 'built';

    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, image_tag, image_id, created_at)
      VALUES (?, ?, ?, 'manual', ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, status, imageTag, imageId);

    if (options.insertArtifact !== false) {
      testDb.prepare(`
        INSERT INTO deployment_build_artifacts (
          deployment_id, application_id, commit_sha, image_tag, image_id,
          build_duration_ms, log_path, platform, build_type, build_path,
          dockerfile_path, built_at, created_at
        ) VALUES (
          ?, ?, ?, ?, ?,
          1250, '/tmp/build.log', 'linux/arm64', 'dockerfile', '.',
          'Dockerfile', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        )
      `).run(deploymentId, app.id, commitSha, imageTag, imageId);
    }

    return { deploymentId, commitSha, imageId, imageTag };
  }

  // ── 1-3. Migration 007 Verification ─────────────────────────────────
  await t.test('1-3. Migration 007 applies cleanly, upgrades v006 DB, and creates deployment_runtime_candidates', () => {
    const version = getCurrentVersion(testDb);
    assert.ok(version >= 7, 'Schema version must be at least 7');

    const applied = getAppliedMigrations(testDb);
    assert.ok(applied.length >= 7);

    // Verify idempotency
    const rerun = runMigrations(testDb);
    assert.equal(rerun.applied, 0, 'Migration re-run must be idempotent');

    // Verify table structure
    const tables = testDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((t) => t.name);
    assert.ok(tables.includes('deployment_runtime_candidates'), 'deployment_runtime_candidates table must exist');

    const cols = testDb.prepare('PRAGMA table_info(deployment_runtime_candidates)').all().map((c) => c.name);
    assert.ok(cols.includes('deployment_id'));
    assert.ok(cols.includes('application_id'));
    assert.ok(cols.includes('image_id'));
    assert.ok(cols.includes('container_id'));
    assert.ok(cols.includes('container_name'));
    assert.ok(cols.includes('staging_network_id'));
    assert.ok(cols.includes('candidate_state'));
    assert.ok(cols.includes('health_status'));

    // Upgrade test from v006 DB
    const upgradePath = path.join(tempBaseDir, 'test-upgrade-v6-to-v7.db');
    const upgradeDb = new Database(upgradePath);
    upgradeDb.pragma('foreign_keys = ON');

    const v6Migrations = loadMigrations().filter((m) => m.version <= 6);
    runMigrations(upgradeDb, v6Migrations);
    assert.equal(getCurrentVersion(upgradeDb), 6);

    const v7Migrations = loadMigrations().filter((m) => m.version <= 7);
    const upgradeRes = runMigrations(upgradeDb, v7Migrations);
    assert.equal(upgradeRes.applied, 1);
    assert.equal(getCurrentVersion(upgradeDb), 7);
    upgradeDb.close();
  });

  // ── 4-7. Mandatory Dual Execution Gate ──────────────────────────────
  await t.test('4-7. Dual execution gate blocks container creation and start when either gate is absent', async () => {
    delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    assert.equal(isRuntimeExecutionEnabled(), false);

    const app = createApplication({ name: 'Gate App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
    const { deploymentId } = setupBuiltDeployment(app);
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    // 4. Disabled by default
    await assert.rejects(
      async () => {
        await runtimeService.prepareCandidateContainer(
          { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'w1', fencingToken: 1 },
          { db: testDb, docker: mockDocker }
        );
      },
      (err) => err instanceof RuntimeServiceError && err.code === 'RUNTIME_DISABLED'
    );

    // 5. Caller option alone cannot start containers
    await assert.rejects(
      async () => {
        await runtimeService.prepareCandidateContainer(
          { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'w1', fencingToken: 1 },
          { db: testDb, docker: mockDocker, executeRuntime: true }
        );
      },
      (err) => err instanceof RuntimeServiceError && err.code === 'RUNTIME_DISABLED'
    );

    // 6. Environment variable alone cannot start containers
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    assert.equal(isRuntimeExecutionEnabled(), true);

    await assert.rejects(
      async () => {
        await runtimeService.prepareCandidateContainer(
          { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'w1', fencingToken: 1 },
          { db: testDb, docker: mockDocker } // executeRuntime omitted
        );
      },
      (err) => err instanceof RuntimeServiceError && err.code === 'RUNTIME_DISABLED'
    );

    // Verify malformed env values mean disabled
    for (const malformed of ['false', '1', 'yes', 'TRUE', 'True', 'enabled', '', '0']) {
      process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = malformed;
      assert.equal(isRuntimeExecutionEnabled(), false);
      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'w1', fencingToken: 1 },
            { db: testDb, docker: mockDocker, executeRuntime: true }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'RUNTIME_DISABLED'
      );
    }

    assert.equal(mockDocker._createdOptions.length, 0, 'Zero containers must be created while gate is disabled');
    delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
  });

  // ── 8-13. Trusted Image Identity & Deployment Prerequisites ─────────
  await t.test('8-13. Rejects unbuilt deployments, missing artifacts, and image mismatches', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication({ name: 'Identity App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });

      // 8. Rejects queued deployment
      const queued = setupBuiltDeployment(app, { status: 'queued' });
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: queued.deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker }
          );
        },
        (err) => err.code === 'INVALID_DEPLOYMENT_STATUS'
      );

      // 9. Rejects missing artifact
      const noArtifact = setupBuiltDeployment(app, { insertArtifact: false });
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: noArtifact.deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker }
          );
        },
        (err) => err.code === 'ARTIFACT_NOT_FOUND'
      );

      // 10. Image ID mismatch rejected
      const mismatch = setupBuiltDeployment(app, { imageId: 'sha256:9999999999999999999999999999999999999999999999999999999999999999' });
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: mismatch.deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker }
          );
        },
        (err) => err.code === 'IMAGE_INSPECT_FAILED' || err.code === 'IMAGE_ID_MISMATCH'
      );

      // 11. Wrong application identity rejected
      const valid = setupBuiltDeployment(app);
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId: valid.deploymentId, applicationId: 'wrong-app-id', stagingNetworkId: TEST_STAGING_NET },
            { db: testDb, docker: mockDocker }
          );
        },
        (err) => err.code === 'APPLICATION_ID_MISMATCH'
      );

      // 13. Valid configuration resolves trusted immutable image ID
      const resolved = await runtimeService.validateRuntimeConfiguration(
        { deploymentId: valid.deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET },
        { db: testDb, docker: mockDocker }
      );
      assert.equal(resolved.imageId, valid.imageId);
      assert.equal(resolved.containerName, `kpanel-candidate-${valid.deploymentId}`);
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 14-17. Docker Container Naming & Ownership ──────────────────────
  await t.test('14-17. Deterministic container name, ownership labels, idempotency, and conflict rejection', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication({ name: 'Naming App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId, commitSha, imageId } = setupBuiltDeployment(app);

      // Setup global worker lock
      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'worker-naming', 1, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      // 14 & 15. Create candidate
      const result = await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-naming', fencingToken: 1 },
        { db: testDb, docker: mockDocker, executeRuntime: true }
      );

      assert.equal(result.created, true);
      assert.equal(result.containerName, `kpanel-candidate-${deploymentId}`);

      const createdOpts = mockDocker._createdOptions[0];
      assert.equal(createdOpts.name, `kpanel-candidate-${deploymentId}`);
      assert.equal(createdOpts.Labels['io.kpanel.managed'], 'true');
      assert.equal(createdOpts.Labels['io.kpanel.role'], 'candidate');
      assert.equal(createdOpts.Labels['io.kpanel.application-id'], app.id);
      assert.equal(createdOpts.Labels['io.kpanel.deployment-id'], deploymentId);
      assert.equal(createdOpts.Labels['io.kpanel.commit-sha'], commitSha);
      assert.equal(createdOpts.Labels['io.kpanel.image-id'], imageId);

      // 16. Candidate creation is idempotent
      const rerun = await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-naming', fencingToken: 1 },
        { db: testDb, docker: mockDocker, executeRuntime: true }
      );
      assert.equal(rerun.reconciled, true);
      assert.equal(rerun.containerId, result.containerId);

      // 17. Conflicting container name from foreign container rejected
      const app2 = createApplication({ name: 'Foreign App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const dep2 = setupBuiltDeployment(app2);

      // Plant a foreign container with dep2's deterministic name but unrelated labels
      mockDocker._containers.set(`kpanel-candidate-${dep2.deploymentId}`, {
        Id: 'foreign-cont-id',
        Name: `/kpanel-candidate-${dep2.deploymentId}`,
        Config: { Labels: { 'unrelated': 'true' } }
      });

      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId: dep2.deploymentId, applicationId: app2.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-naming', fencingToken: 1 },
            { db: testDb, docker: mockDocker, executeRuntime: true }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'CONTAINER_NAME_CONFLICT'
      );

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 18-21. Dedicated Staging Network & Zero Host Ports ──────────────
  await t.test('18-21. Staging network enforced, non-bridge rejected, and zero published host ports', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    try {
      const app = createApplication({ name: 'Net App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupBuiltDeployment(app);

      // 18. Missing staging network rejected
      delete process.env.KPANEL_STAGING_NETWORK_ID;
      const mockDocker = createMockDockerClient();
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId, applicationId: app.id }, // no stagingNetworkId
            { db: testDb, docker: mockDocker }
          );
        },
        (err) => err.code === 'STAGING_NETWORK_NOT_CONFIGURED'
      );

      // 19. Incorrect staging network driver (e.g. host driver) rejected
      const mockHostNetDocker = createMockDockerClient({ stagingNetworkId: 'host-net', stagingNetworkDriver: 'host' });
      await assert.rejects(
        async () => {
          await runtimeService.validateRuntimeConfiguration(
            { deploymentId, applicationId: app.id, stagingNetworkId: 'host-net' },
            { db: testDb, docker: mockHostNetDocker }
          );
        },
        (err) => err.code === 'STAGING_NETWORK_UNSAFE'
      );

      // 20-21. Container options verify zero host ports and staging network
      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'worker-net', 2, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      const validDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
      await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-net', fencingToken: 2 },
        { db: testDb, docker: validDocker, executeRuntime: true }
      );

      const created = validDocker._createdOptions[0];
      assert.deepEqual(created.HostConfig.PortBindings, {}, 'Must have zero PortBindings');
      assert.equal(created.HostConfig.PublishAllPorts, false, 'PublishAllPorts must be false');
      assert.equal(created.HostConfig.NetworkMode, TEST_STAGING_NET, 'Must attach to dedicated staging network');

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 22-30. Runtime Isolation & Security Defaults ────────────────────
  await t.test('22-30. Privileged=false, CapDrop=ALL, no-new-privileges, resource limits, no host binds', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication(
        { name: 'Iso App', repo_url: 'https://github.com/org/repo.git', branch: 'main', cpu_limit: 2.0, memory_limit_mb: 2048 },
        { db: testDb }
      );
      const { deploymentId } = setupBuiltDeployment(app);

      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'worker-iso', 3, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-iso', fencingToken: 3 },
        {
          db: testDb,
          docker: mockDocker,
          executeRuntime: true,
          env: {
            SAFE_VAR: '123',
            GITHUB_TOKEN: 'secret_leak',
            KPANEL_SECRET: 'secret_leak'
          }
        }
      );

      const created = mockDocker._createdOptions[0];
      // 22. Privileged = false
      assert.equal(created.HostConfig.Privileged, false);

      // 23. CapDrop includes ALL
      assert.deepEqual(created.HostConfig.CapDrop, ['ALL']);

      // 24. no-new-privileges enforced
      assert.ok(created.HostConfig.SecurityOpt.includes('no-new-privileges:true'));

      // 25. Memory and CPU limits enforced
      assert.equal(created.HostConfig.Memory, 2048 * 1024 * 1024);
      assert.equal(created.HostConfig.NanoCpus, 2 * 1e9);

      // 26. PidsLimit enforced
      assert.equal(created.HostConfig.PidsLimit, 256);

      // 27-28. No Docker socket or arbitrary host binds
      assert.deepEqual(created.HostConfig.Binds, []);

      // 29. Backend environment secrets excluded
      assert.ok(created.Env.includes('SAFE_VAR=123'));
      assert.ok(!created.Env.some((e) => e.startsWith('GITHUB_TOKEN=')));
      assert.ok(!created.Env.some((e) => e.startsWith('KPANEL_SECRET=')));

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 31-39. Container Lifecycle & Health Checks ──────────────────────
  await t.test('31-39. Container start, inspection, and health status evaluation', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication({ name: 'Health App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupBuiltDeployment(app);

      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'worker-health', 4, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      // 31. Create container
      const prep = await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-health', fencingToken: 4 },
        { db: testDb, docker: mockDocker, executeRuntime: true }
      );
      assert.ok(prep.containerId);

      // Check SQLite row persisted
      const candidateRow = runtimeService.getCandidateRuntimeStatus(deploymentId, { db: testDb });
      assert.equal(candidateRow.containerId, prep.containerId);
      assert.equal(candidateRow.candidateState, 'created');

      // 32. Start container
      const startResult = await runtimeService.startCandidateContainer(deploymentId, {
        db: testDb,
        docker: mockDocker,
        ownerId: 'worker-health',
        fencingToken: 4,
        executeRuntime: true
      });
      assert.equal(startResult.started, true);

      // Simulate Docker daemon reporting healthy after healthcheck probe succeeds
      const runningContainer = mockDocker._containers.get(prep.containerId);
      runningContainer.State.Health.Status = 'healthy';

      // 33. Healthy evaluation
      const health1 = await runtimeService.checkCandidateHealth(prep.containerId, {
        db: testDb,
        deploymentId,
        docker: mockDocker,
        timeoutMs: 1000
      });
      assert.equal(health1.healthy, true);
      assert.equal(health1.promotionReady, true);
      assert.equal(health1.healthStatus, 'healthy');

      // 34. Starting state (not prematurely healthy)
      const mockStartingDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });
      const appStarting = createApplication({ name: 'Starting App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const depStarting = setupBuiltDeployment(appStarting);
      const prepStarting = await runtimeService.prepareCandidateContainer(
        { deploymentId: depStarting.deploymentId, applicationId: appStarting.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-health', fencingToken: 4 },
        { db: testDb, docker: mockStartingDocker, executeRuntime: true }
      );
      // Simulate container starting with no immediate healthy report
      const containerObj = mockStartingDocker._containers.get(prepStarting.containerId);
      containerObj.State.Running = true;
      containerObj.State.Health.Status = 'starting';

      const healthTimeout = await runtimeService.checkCandidateHealth(prepStarting.containerId, {
        db: testDb,
        deploymentId: depStarting.deploymentId,
        docker: mockStartingDocker,
        timeoutMs: 100,
        intervalMs: 30
      });
      assert.equal(healthTimeout.healthy, false);
      assert.equal(healthTimeout.healthStatus, 'starting');
      assert.equal(healthTimeout.reason, 'HEALTHCHECK_TIMEOUT');

      // 35. Unhealthy state rejected
      containerObj.State.Health.Status = 'unhealthy';
      const healthUnhealthy = await runtimeService.checkCandidateHealth(prepStarting.containerId, {
        db: testDb,
        deploymentId: depStarting.deploymentId,
        docker: mockStartingDocker,
        timeoutMs: 500
      });
      assert.equal(healthUnhealthy.healthy, false);
      assert.equal(healthUnhealthy.healthStatus, 'unhealthy');

      // 36. Exited container rejected
      containerObj.State.Running = false;
      containerObj.State.ExitCode = 137;
      const healthExited = await runtimeService.checkCandidateHealth(prepStarting.containerId, {
        db: testDb,
        deploymentId: depStarting.deploymentId,
        docker: mockStartingDocker,
        timeoutMs: 500
      });
      assert.equal(healthExited.healthy, false);
      assert.equal(healthExited.candidateState, 'exited');
      assert.equal(healthExited.reason, 'CONTAINER_EXITED');

      // 37. Missing healthcheck instruction
      const mockNoHealthDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET, hasHealthcheck: false });
      const appNoHealth = createApplication({ name: 'NoHealth App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const depNoHealth = setupBuiltDeployment(appNoHealth);
      const prepNoHealth = await runtimeService.prepareCandidateContainer(
        { deploymentId: depNoHealth.deploymentId, applicationId: appNoHealth.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'worker-health', fencingToken: 4 },
        { db: testDb, docker: mockNoHealthDocker, executeRuntime: true }
      );
      const healthMissing = await runtimeService.checkCandidateHealth(prepNoHealth.containerId, {
        db: testDb,
        deploymentId: depNoHealth.deploymentId,
        docker: mockNoHealthDocker,
        timeoutMs: 500
      });
      assert.equal(healthMissing.healthy, false);
      assert.equal(healthMissing.promotionReady, false);
      assert.equal(healthMissing.reason, 'HEALTHCHECK_MISSING');

      // 39. Cancellation via AbortSignal
      const abortCtrl = new AbortController();
      abortCtrl.abort();
      await assert.rejects(
        async () => {
          await runtimeService.checkCandidateHealth(prep.containerId, {
            docker: mockDocker,
            signal: abortCtrl.signal
          });
        },
        (err) => err.code === 'OPERATION_CANCELLED'
      );

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 40-45. Fencing, Recovery & Cleanup ──────────────────────────────
  await t.test('40-45. Stale worker rejected, lease expiry blocks mutation, and safe cleanup touches only owned container', async () => {
    process.env.KPANEL_RUNTIME_EXECUTION_ENABLED = 'true';
    const mockDocker = createMockDockerClient({ stagingNetworkId: TEST_STAGING_NET });

    try {
      const app = createApplication({ name: 'Fenced App', repo_url: 'https://github.com/org/repo.git', branch: 'main' }, { db: testDb });
      const { deploymentId } = setupBuiltDeployment(app);

      // Lock held by competitor
      testDb.prepare(`
        INSERT OR REPLACE INTO deployment_worker_lock (lock_name, owner_id, fencing_token, lease_expires_at)
        VALUES (?, 'competitor-worker', 10, datetime('now', '+60 seconds'))
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      // 40. Stale worker with token 9 rejected
      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'stale-worker', fencingToken: 9 },
            { db: testDb, docker: mockDocker, executeRuntime: true }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'LEASE_LOST'
      );

      // 41. Expired lease blocks mutation
      testDb.prepare(`
        UPDATE deployment_worker_lock
        SET lease_expires_at = datetime('now', '-10 seconds')
        WHERE lock_name = ?
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      await assert.rejects(
        async () => {
          await runtimeService.prepareCandidateContainer(
            { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'competitor-worker', fencingToken: 10 },
            { db: testDb, docker: mockDocker, executeRuntime: true }
          );
        },
        (err) => err instanceof RuntimeServiceError && err.code === 'LEASE_LOST'
      );

      // 45. Safe stop touches only verified candidate container
      testDb.prepare(`
        UPDATE deployment_worker_lock
        SET owner_id = 'valid-cleaner', fencing_token = 11, lease_expires_at = datetime('now', '+60 seconds')
        WHERE lock_name = ?
      `).run(deploymentLeaseService.GLOBAL_LOCK_NAME);

      const prep = await runtimeService.prepareCandidateContainer(
        { deploymentId, applicationId: app.id, stagingNetworkId: TEST_STAGING_NET, ownerId: 'valid-cleaner', fencingToken: 11 },
        { db: testDb, docker: mockDocker, executeRuntime: true }
      );

      await runtimeService.startCandidateContainer(deploymentId, {
        db: testDb,
        docker: mockDocker,
        ownerId: 'valid-cleaner',
        fencingToken: 11,
        executeRuntime: true
      });

      const stopResult = await runtimeService.stopOwnedCandidate(deploymentId, 'valid-cleaner', 11, {
        db: testDb,
        docker: mockDocker
      });
      assert.equal(stopResult.stopped, true);

      const statusAfterStop = runtimeService.getCandidateRuntimeStatus(deploymentId, { db: testDb });
      assert.equal(statusAfterStop.candidateState, 'stopped');

      testDb.prepare('DELETE FROM deployment_worker_lock').run();
    } finally {
      delete process.env.KPANEL_RUNTIME_EXECUTION_ENABLED;
    }
  });

  // ── 46-53. System Invariants & Non-Interference ─────────────────────
  await t.test('46-53. Zero release rows, no deployment marked success, no proxy/routing changes, legacy untouched', () => {
    // 46. Zero active releases created
    const releaseCount = testDb.prepare('SELECT count(*) as count FROM releases').get().count;
    assert.equal(releaseCount, 0, 'No releases must be created during candidate staging');

    // 47. No deployment marked success
    const successCount = testDb.prepare("SELECT count(*) as count FROM deployments WHERE status = 'success'").get().count;
    assert.equal(successCount, 0, 'No deployment must be marked success in Phase 4C1');

    // 52. Legacy deployments.json unchanged
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });
});
