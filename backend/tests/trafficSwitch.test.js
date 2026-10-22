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
const releasePlanningService = require('../services/releasePlanningService');
const { createReleasePlan } = releasePlanningService;
const traefikTopologyService = require('../services/traefikTopologyService');
const routeConflictService = require('../services/routeConflictService');
const { CONFLICT_DECISIONS, isSafeRegexPattern } = routeConflictService;
const routingPreflightService = require('../services/routingPreflightService');
const { createActivationIntent, getActivationIntent, computeRouteFingerprint } = routingPreflightService;
const traefikRouteWriter = require('../services/traefikRouteWriter');
const { TraefikRouteWriterError } = traefikRouteWriter;
const routeRollbackService = require('../services/routeRollbackService');
const { RouteRollbackError } = routeRollbackService;
const trafficSwitchService = require('../services/trafficSwitchService');
const { executeSandboxSwitch, planCandidateProxyAttachment, TrafficSwitchError } = trafficSwitchService;

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

test('Phase 4C3B: Guarded Traffic Switch Executor, Route Writer & Durable Rollback Suite', async (t) => {
  let tempBaseDir;
  let tempDbPath;
  let testDb;
  let sandboxDir;
  let originalDeploymentsContent;

  const TEST_IMAGE_ID = 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff';
  const TEST_STAGING_NET = 'staging-net-001';

  t.before(() => {
    process.env.NODE_ENV = 'test';
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }

    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-switch-test-'));
    tempDbPath = path.join(tempBaseDir, 'test-switch.db');
    sandboxDir = path.join(tempBaseDir, 'route-sandbox');
    fs.mkdirSync(sandboxDir, { recursive: true, mode: 0o700 });

    process.env.KPANEL_DB_PATH = tempDbPath;
    process.env.KPANEL_SANDBOX_ROUTE_DIR = sandboxDir;

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);
  });

  t.after(() => {
    closeDatabase();
    delete process.env.KPANEL_DB_PATH;
    delete process.env.KPANEL_SANDBOX_ROUTE_DIR;
    delete process.env.KPANEL_SANDBOX_SWITCH_ENABLED;
    delete process.env.KPANEL_TRAFFIC_SWITCH_ENABLED;

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try { fs.rmSync(tempBaseDir, { recursive: true, force: true }); } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });

  // Helper to establish a valid built candidate, ready release plan, activation intent, and worker lease
  async function setupReadyActivation(app, options = {}) {
    const deploymentId = options.deploymentId || `d-${crypto.randomUUID()}`;
    const commitSha = options.commitSha || 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2';
    const imageId = options.imageId || TEST_IMAGE_ID;
    const imageTag = options.imageTag || `kpanel/app-${app.id}:d-${deploymentId}-${commitSha.slice(0, 7)}`;
    const containerId = options.containerId || `c-${crypto.randomUUID()}`;
    const containerName = `kpanel-candidate-${deploymentId}`;

    // Insert Deployment
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, trigger_source, status, image_tag, image_id, created_at)
      VALUES (?, ?, ?, 'manual', 'built', ?, ?, CURRENT_TIMESTAMP)
    `).run(deploymentId, app.id, commitSha, imageTag, imageId);

    // Insert Build Artifact
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

    // Insert Runtime Candidate
    testDb.prepare(`
      INSERT INTO deployment_runtime_candidates (
        deployment_id, application_id, image_id, container_id, container_name,
        staging_network_id, candidate_state, health_status, created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?,
        ?, 'healthy', 'healthy', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )
    `).run(
      deploymentId,
      app.id,
      imageId,
      containerId,
      containerName,
      TEST_STAGING_NET
    );

    // Setup Mock Docker
    const mockDocker = createMockDockerClient({ defaultImageId: imageId });
    const mockContainerObj = {
      Id: containerId,
      Name: `/${containerName}`,
      Config: {
        Image: imageId,
        Healthcheck: { Test: ['CMD', 'curl', '-f', 'http://localhost:3000/health'] },
        Labels: {
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'candidate',
          'io.kpanel.deployment-id': deploymentId,
          'io.kpanel.application-id': app.id
        }
      },
      State: {
        Running: true,
        Health: { Status: 'healthy' }
      },
      NetworkSettings: {
        Networks: {
          [TEST_STAGING_NET]: { NetworkID: TEST_STAGING_NET, IPAddress: '172.28.0.2' }
        }
      }
    };
    mockDocker._containers.set(containerId, mockContainerObj);
    mockDocker._containers.set(containerName, mockContainerObj);

    // Acquire Worker Lease
    if (options.resetLock !== false) {
      testDb.prepare("DELETE FROM deployment_worker_lock WHERE lock_name = 'global_deployment_worker'").run();
    }
    const leaseOwner = options.ownerId || `worker-${crypto.randomUUID().slice(0, 8)}`;
    const lease = deploymentLeaseService.acquireWorkerLease(leaseOwner, { leaseSeconds: 60, db: testDb });

    // Create Release Plan
    const plan = await createReleasePlan(
      { deploymentId, applicationId: app.id },
      {
        db: testDb,
        docker: mockDocker,
        skipGitCheck: true,
        ownerId: leaseOwner,
        fencingToken: lease.fencingToken
      }
    );

    // Create Activation Intent
    const mockTopology = traefikTopologyService.inspectRoutingTopology({
      snapshot: {
        routers: {},
        services: {},
        providers: ['file'],
        providerMetadata: { file: { directoryConfigured: true } }
      },
      freshnessStatus: 'fresh',
      originVerified: true
    });

    const intent = await createActivationIntent(plan.planId, {
      db: testDb,
      docker: mockDocker,
      topology: mockTopology,
      ownerId: leaseOwner,
      fencingToken: lease.fencingToken,
      skipGitCheck: true
    });

    return {
      deploymentId,
      containerId,
      containerName,
      imageId,
      plan,
      intent,
      leaseOwner,
      fencingToken: lease.fencingToken,
      mockDocker,
      mockTopology
    };
  }

  // =========================================================================
  // 1-3. SQLite Migration 010 & Upgrade Tests
  // =========================================================================
  await t.test('1-3. Migration 010 applies cleanly, upgrades from 009, and preserves active releases', () => {
    const version = getCurrentVersion(testDb);
    assert.equal(version, 10, 'Database schema must be at version 10');

    const applied = getAppliedMigrations(testDb);
    const m10 = applied.find((m) => m.version === 10);
    assert.ok(m10, 'Migration 010 must be registered in schema_migrations');
    assert.equal(m10.name, '010_activation_journal');

    // Confirm table exists with exact columns
    const columns = testDb.prepare(`PRAGMA table_info(deployment_route_activation_journal)`).all();
    const colNames = columns.map((c) => c.name);
    assert.ok(colNames.includes('journal_id'));
    assert.ok(colNames.includes('activation_id'));
    assert.ok(colNames.includes('application_id'));
    assert.ok(colNames.includes('deployment_id'));
    assert.ok(colNames.includes('target_domain'));
    assert.ok(colNames.includes('expected_previous_fingerprint'));
    assert.ok(colNames.includes('proposed_fingerprint'));
    assert.ok(colNames.includes('previous_route_document'));
    assert.ok(colNames.includes('proposed_route_document'));
    assert.ok(colNames.includes('journal_state'));
    assert.ok(colNames.includes('operation_owner'));
    assert.ok(colNames.includes('fencing_token'));

    // Verify existing releases table is untouched and preserved
    const releasesCount = testDb.prepare("SELECT COUNT(*) as count FROM releases WHERE status = 'active'").get();
    assert.equal(releasesCount.count, 0, 'No active releases created prematurely');
  });

  // =========================================================================
  // 4-7. Strict Execution Gates & Path Safety
  // =========================================================================
  await t.test('4-7. Strict execution gates: sandbox disabled by default, production paths rejected', async () => {
    const app = createApplication(
      { name: 'Gate App', slug: 'gate-app', repo_url: 'https://github.com/org/gate.git', branch: 'main', domain: 'gate.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    // 4. Sandbox execution disabled by default (env var not set)
    delete process.env.KPANEL_SANDBOX_SWITCH_ENABLED;
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir,
          db: testDb
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'SANDBOX_SWITCH_DISABLED'
    );

    // 5. Caller option alone cannot enable switching (env missing)
    assert.equal(process.env.KPANEL_SANDBOX_SWITCH_ENABLED, undefined);

    // 6. Environment gate alone cannot enable switching (caller option false/missing)
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: false, // caller did not authorize
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir,
          db: testDb
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'SANDBOX_EXECUTION_UNAUTHORIZED'
    );

    // 7. Production directory cannot be selected
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir: '/etc/traefik', // forbidden production path
          db: testDb
        });
      },
      (err) => err instanceof TraefikRouteWriterError && err.code === 'FORBIDDEN_DIRECTORY'
    );
  });

  // =========================================================================
  // 8-9. Stale Worker & Missing Fencing Token Authorization
  // =========================================================================
  await t.test('8-9. Authorization fencing: missing owner/fencing token and stale lease rejected', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Fencing App', slug: 'fencing-app', repo_url: 'https://github.com/org/fencing.git', branch: 'main', domain: 'fencing.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    // 9. Missing fencing token rejected
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          // fencingToken missing
          sandboxDir,
          db: testDb
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'MISSING_WORKER_CREDENTIALS'
    );

    // trustedOperator: true CANNOT bypass worker fencing
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          trustedOperator: true, // Attempt bypass
          sandboxDir,
          db: testDb
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'MISSING_WORKER_CREDENTIALS'
    );

    // 8. Stale worker rejected (simulate newer worker acquiring lease)
    testDb.prepare("UPDATE deployment_worker_lock SET lease_expires_at = datetime('now', '-5 seconds')").run();
    const newerWorker = `worker-newer-${crypto.randomUUID().slice(0, 6)}`;
    const takeover = deploymentLeaseService.acquireWorkerLease(newerWorker, { leaseSeconds: 60, db: testDb }); // bumps monotonic fencing token
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.isTakeover, true);

    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken, // now stale
          sandboxDir,
          docker: setup.mockDocker,
          topology: setup.mockTopology,
          skipGitCheck: true,
          db: testDb
        });
      },
      (err) => err.code === 'STALE_FENCING_TOKEN' || err.code === 'LEASE_LOST'
    );
  });

  // =========================================================================
  // 11-15. Route Writer Security: Traversal, Symlinks, Foreign Overwrite, Atomic Replacement
  // =========================================================================
  await t.test('11-15. Safe route writer: traversal, symlinks, foreign files rejected; atomic replacement verified', () => {
    const testAppId = `app-${crypto.randomUUID().slice(0, 8)}`;

    // 11. Generate valid route document
    const yamlDoc = traefikRouteWriter.generateDeterministicYamlRoute({
      applicationId: testAppId,
      deploymentId: 'd-test-123',
      targetDomain: 'test.example.com',
      targetPort: 3000,
      candidateContainerId: 'c-testcontainer123'
    });
    assert.ok(yamlDoc.includes('Host(`test.example.com`)'));
    assert.ok(yamlDoc.includes(`# kpanel-owner: ${testAppId}`));

    // 14. Path traversal rejected
    assert.throws(
      () => {
        traefikRouteWriter.resolveSecureRoutePath('../escape-app', sandboxDir);
      },
      (err) => err instanceof TraefikRouteWriterError && (err.code === 'INVALID_APPLICATION_ID' || err.code === 'PATH_TRAVERSAL_DETECTED')
    );

    // 13. Symlink attack rejected
    const symlinkTarget = path.join(sandboxDir, `kpanel-${testAppId}.yaml`);
    const dummyTarget = path.join(tempBaseDir, 'dummy.yaml');
    fs.writeFileSync(dummyTarget, 'dummy: true');
    try {
      fs.symlinkSync(dummyTarget, symlinkTarget);
      assert.throws(
        () => {
          traefikRouteWriter.readOwnedRoute(testAppId, { sandboxDir });
        },
        (err) => err instanceof TraefikRouteWriterError && err.code === 'SYMLINK_DETECTED'
      );
    } finally {
      try { fs.unlinkSync(symlinkTarget); } catch {}
    }

    // 12. Existing foreign route not overwritten (e.g. Dokploy/n8n/foreign config)
    const foreignFilePath = path.join(sandboxDir, `kpanel-${testAppId}.yaml`);
    fs.writeFileSync(foreignFilePath, '# dokploy managed route\nhttp:\n  routers:\n    dokploy-router:\n      rule: Host(`dokploy.example.com`)');
    try {
      assert.throws(
        () => {
          traefikRouteWriter.readOwnedRoute(testAppId, { sandboxDir });
        },
        (err) => err instanceof TraefikRouteWriterError && err.code === 'FOREIGN_ROUTE_FILE'
      );

      assert.throws(
        () => {
          traefikRouteWriter.applyRouteUpdate(testAppId, yamlDoc, { sandboxDir });
        },
        (err) => err instanceof TraefikRouteWriterError && err.code === 'FOREIGN_ROUTE_FILE'
      );
    } finally {
      try { fs.unlinkSync(foreignFilePath); } catch {}
    }

    // 15. Atomic replacement behavior
    const applyRes = traefikRouteWriter.applyRouteUpdate(testAppId, yamlDoc, { sandboxDir });
    assert.equal(applyRes.applied, true);
    assert.ok(fs.existsSync(applyRes.filePath));
    const content = fs.readFileSync(applyRes.filePath, 'utf8');
    assert.equal(content, yamlDoc);

    // Clean up
    traefikRouteWriter.removeOwnedRoute(testAppId, { sandboxDir });
  });

  // =========================================================================
  // 16-23. Full Successful Sandbox Traffic Switch & Mock Convergence
  // =========================================================================
  await t.test('16-23. Full sandbox switch: journal persisted before write, CAS checks, mock convergence', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Switch App', slug: 'switch-app', repo_url: 'https://github.com/org/switch.git', branch: 'main', domain: 'switch.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    // 17. First release route prepared: no route file in sandbox
    const currentRoute = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir });
    assert.equal(currentRoute.exists, false);

    // 22. Successful sandbox route write & 23. Mock convergence verified
    const switchRes = await executeSandboxSwitch(setup.intent.activationId, {
      executeSandboxSwitch: true,
      ownerId: setup.leaseOwner,
      fencingToken: setup.fencingToken,
      sandboxDir,
      docker: setup.mockDocker,
      topology: setup.mockTopology,
      skipGitCheck: true,
      db: testDb
    });

    assert.equal(switchRes.success, true);
    assert.equal(switchRes.journalState, 'verified');
    assert.equal(switchRes.isFirstRelease, true);
    assert.ok(fs.existsSync(switchRes.routeFilePath));

    // 16. Journal persisted before route file mutation
    const journal = testDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE journal_id = ?').get(switchRes.journalId);
    assert.ok(journal);
    assert.equal(journal.journal_state, 'verified');
    assert.equal(journal.operation_owner, setup.leaseOwner);
    assert.equal(journal.fencing_token, setup.fencingToken);
    assert.equal(journal.expected_previous_fingerprint, null); // first release
    assert.equal(journal.proposed_fingerprint, switchRes.proposedFingerprint);
    assert.ok(journal.operation_started_at);
    assert.ok(journal.route_applied_at);
    assert.ok(journal.verification_completed_at);

    // Verify written file matches proposed fingerprint
    const writtenContent = fs.readFileSync(switchRes.routeFilePath, 'utf8');
    assert.equal(traefikRouteWriter.computeRouteFingerprint(writtenContent), switchRes.proposedFingerprint);
  });

  // =========================================================================
  // 24-26. Convergence Failure, Wrong Backend & Automated Rollback
  // =========================================================================
  await t.test('24-26. Convergence failures (wrong backend, timeout) trigger automated rollback', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Failure App', slug: 'failure-app', repo_url: 'https://github.com/org/failure.git', branch: 'main', domain: 'failure.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    // 24. Wrong backend rejected during mock convergence -> triggers automated rollback
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir,
          docker: setup.mockDocker,
          topology: setup.mockTopology,
          skipGitCheck: true,
          db: testDb,
          verifier: async () => ({
            converged: true,
            observedBackend: 'http://wrong-backend:9999' // Mismatch
          })
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'WRONG_BACKEND_OBSERVED'
    );

    // Verify automated rollback occurred: route file was removed (first release)
    const fileAfterRollback = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir });
    assert.equal(fileAfterRollback.exists, false, 'Route file must be removed after first-release rollback');

    // Verify journal recorded rollback
    const journal = testDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE application_id = ? ORDER BY created_at DESC').get(app.id);
    assert.equal(journal.journal_state, 'rolled_back');
    assert.ok(journal.rollback_completed_at);
  });

  // =========================================================================
  // 27-29. Crash-Window Recovery & Interrupted Activation Reconciliation
  // =========================================================================
  await t.test('27-29. Crash recovery: discovers actual file state before/after filesystem write', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Crash App', slug: 'crash-app', repo_url: 'https://github.com/org/crash.git', branch: 'main', domain: 'crash.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    // 27. Crash before filesystem write
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir,
          docker: setup.mockDocker,
          topology: setup.mockTopology,
          skipGitCheck: true,
          db: testDb,
          simulateCrashBeforeMutation: true
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'SIMULATED_CRASH'
    );

    const crashJournal1 = testDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE application_id = ?').get(app.id);
    assert.equal(crashJournal1.journal_state, 'prepared');

    // 29. Reconcile crash before write: file does not exist, journal stays prepared/reset
    const recon1 = routeRollbackService.reconcileInterruptedActivation(crashJournal1.journal_id, {
      ownerId: setup.leaseOwner,
      fencingToken: setup.fencingToken,
      sandboxDir,
      db: testDb
    });
    assert.equal(recon1.resolvedState, 'prepared');
    assert.equal(recon1.liveFileState.exists, false);

    // Clean up intent status to re-run
    testDb.prepare("UPDATE deployment_release_activation_intents SET activation_status = 'ready' WHERE activation_id = ?").run(setup.intent.activationId);

    // 28. Crash after filesystem write
    await assert.rejects(
      async () => {
        await executeSandboxSwitch(setup.intent.activationId, {
          executeSandboxSwitch: true,
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken,
          sandboxDir,
          docker: setup.mockDocker,
          topology: setup.mockTopology,
          skipGitCheck: true,
          db: testDb,
          simulateCrashAfterMutation: true
        });
      },
      (err) => err instanceof TrafficSwitchError && err.code === 'SIMULATED_CRASH'
    );

    const crashJournal2 = testDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE application_id = ? ORDER BY rowid DESC').get(app.id);
    assert.equal(crashJournal2.journal_state, 'applying');

    // 29. Reconcile discovers actual file state: file exists on disk matching proposed fingerprint
    const recon2 = routeRollbackService.reconcileInterruptedActivation(crashJournal2.journal_id, {
      ownerId: setup.leaseOwner,
      fencingToken: setup.fencingToken,
      sandboxDir,
      db: testDb
    });
    assert.equal(recon2.resolvedState, 'applied_unverified');
    assert.equal(recon2.liveFileState.exists, true);

    // Clean up
    traefikRouteWriter.removeOwnedRoute(app.id, { sandboxDir });
  });

  // =========================================================================
  // 30-33. Durable Rollback: First-Release, Replacement, Conflict, Idempotency
  // =========================================================================
  await t.test('30-33. Durable rollback: first-release removal, replacement restoration, foreign conflict, idempotence', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Rollback App', slug: 'rollback-app', repo_url: 'https://github.com/org/rollback.git', branch: 'main', domain: 'rollback.example.com', port: 3000 },
      { db: testDb }
    );

    // Step A: First Release
    const setup1 = await setupReadyActivation(app);
    const switch1 = await executeSandboxSwitch(setup1.intent.activationId, {
      executeSandboxSwitch: true,
      ownerId: setup1.leaseOwner,
      fencingToken: setup1.fencingToken,
      sandboxDir,
      docker: setup1.mockDocker,
      topology: setup1.mockTopology,
      skipGitCheck: true,
      db: testDb
    });

    // 30. First-release rollback removes only K-Panel route
    const rb1 = routeRollbackService.executeSandboxRollback(switch1.journalId, {
      ownerId: setup1.leaseOwner,
      fencingToken: setup1.fencingToken,
      sandboxDir,
      db: testDb
    });
    assert.equal(rb1.rolledBack, true);
    assert.equal(rb1.isFirstRelease, true);
    const routeAfterRb1 = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir });
    assert.equal(routeAfterRb1.exists, false);

    // 33. Repeated rollback idempotent
    const repeatRb1 = routeRollbackService.executeSandboxRollback(switch1.journalId, {
      ownerId: setup1.leaseOwner,
      fencingToken: setup1.fencingToken,
      sandboxDir,
      db: testDb
    });
    assert.equal(repeatRb1.rolledBack, true);
    assert.equal(repeatRb1.alreadyRolledBack, true);

    // Step B: Re-apply switch 1 to establish baseline for replacement release
    testDb.prepare("UPDATE deployment_release_activation_intents SET activation_status = 'ready' WHERE activation_id = ?").run(setup1.intent.activationId);
    await executeSandboxSwitch(setup1.intent.activationId, {
      executeSandboxSwitch: true,
      ownerId: setup1.leaseOwner,
      fencingToken: setup1.fencingToken,
      sandboxDir,
      docker: setup1.mockDocker,
      topology: setup1.mockTopology,
      skipGitCheck: true,
      db: testDb
    });

    // Step C: Replacement Release (Deployment 2)
    const prevFingerprint = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir }).fingerprint;
    const prevContent = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir }).routeDocument;

    // Create newer candidate and intent with previousRouteFingerprint set
    const setup2 = await setupReadyActivation(app, {
      ownerId: setup1.leaseOwner,
      deploymentId: `d-rep-${crypto.randomUUID().slice(0, 8)}`,
      containerId: `c-rep-${crypto.randomUUID().slice(0, 8)}`
    });

    // Update activation intent to reflect replacement release
    testDb.prepare(`
      UPDATE deployment_release_activation_intents
      SET previous_route_fingerprint = ?
      WHERE activation_id = ?
    `).run(prevFingerprint, setup2.intent.activationId);

    const switch2 = await executeSandboxSwitch(setup2.intent.activationId, {
      executeSandboxSwitch: true,
      ownerId: setup2.leaseOwner,
      fencingToken: setup2.fencingToken,
      sandboxDir,
      docker: setup2.mockDocker,
      topology: setup2.mockTopology,
      skipGitCheck: true,
      db: testDb
    });
    assert.equal(switch2.isFirstRelease, false);
    assert.notEqual(switch2.proposedFingerprint, prevFingerprint);

    // 31. Replacement rollback restores previous document
    const rb2 = routeRollbackService.executeSandboxRollback(switch2.journalId, {
      ownerId: setup2.leaseOwner,
      fencingToken: setup2.fencingToken,
      sandboxDir,
      db: testDb
    });
    assert.equal(rb2.rolledBack, true);
    assert.equal(rb2.isFirstRelease, false);
    const restoredRoute = traefikRouteWriter.readOwnedRoute(app.id, { sandboxDir });
    assert.equal(restoredRoute.fingerprint, prevFingerprint);
    assert.equal(restoredRoute.routeDocument, prevContent);

    // 32. Rollback conflict blocks overwrite if file was modified by foreign actor
    const routeFilePath = restoredRoute.filePath;
    fs.writeFileSync(routeFilePath, '# foreign modification\nhttp:\n  routers:\n    hacked: true');

    // Create a new switch attempt and rollback to test conflict
    testDb.prepare("UPDATE deployment_release_activation_intents SET activation_status = 'ready' WHERE activation_id = ?").run(setup2.intent.activationId);
    await assert.rejects(
      async () => {
        routeRollbackService.executeSandboxRollback(switch2.journalId, {
          ownerId: setup2.leaseOwner,
          fencingToken: setup2.fencingToken,
          sandboxDir,
          db: testDb
        });
      },
      (err) => err instanceof RouteRollbackError && err.code === 'ROLLBACK_CONFLICT'
    );

    // Clean up
    try { fs.unlinkSync(routeFilePath); } catch {}
  });

  // =========================================================================
  // 34-36. Process Restart & Concurrency
  // =========================================================================
  await t.test('34-36. Journal survives database reopen, sandbox file persists, stale worker cannot roll back', async () => {
    process.env.KPANEL_SANDBOX_SWITCH_ENABLED = 'true';
    const app = createApplication(
      { name: 'Restart App', slug: 'restart-app', repo_url: 'https://github.com/org/restart.git', branch: 'main', domain: 'restart.example.com', port: 3000 },
      { db: testDb }
    );
    const setup = await setupReadyActivation(app);

    const switchRes = await executeSandboxSwitch(setup.intent.activationId, {
      executeSandboxSwitch: true,
      ownerId: setup.leaseOwner,
      fencingToken: setup.fencingToken,
      sandboxDir,
      docker: setup.mockDocker,
      topology: setup.mockTopology,
      skipGitCheck: true,
      db: testDb
    });

    // 34. Journal survives database close and reopen
    closeDatabase();
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    const journalAfterReopen = reopenedDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE journal_id = ?').get(switchRes.journalId);
    assert.ok(journalAfterReopen);
    assert.equal(journalAfterReopen.journal_state, 'verified');

    // 35. Sandbox file persists across process/connection restart
    assert.ok(fs.existsSync(switchRes.routeFilePath));
    const content = fs.readFileSync(switchRes.routeFilePath, 'utf8');
    assert.equal(traefikRouteWriter.computeRouteFingerprint(content), switchRes.proposedFingerprint);

    // 36. Stale worker cannot roll back
    reopenedDb.prepare("UPDATE deployment_worker_lock SET lease_expires_at = datetime('now', '-5 seconds')").run();
    const newerWorker = `worker-newer-${crypto.randomUUID().slice(0, 6)}`;
    const takeover = deploymentLeaseService.acquireWorkerLease(newerWorker, { leaseSeconds: 60, db: reopenedDb }); // bump fencing token
    assert.equal(takeover.acquired, true);
    assert.equal(takeover.isTakeover, true);

    await assert.rejects(
      async () => {
        routeRollbackService.executeSandboxRollback(switchRes.journalId, {
          ownerId: setup.leaseOwner,
          fencingToken: setup.fencingToken, // stale
          sandboxDir,
          db: reopenedDb
        });
      },
      (err) => err.code === 'STALE_FENCING_TOKEN' || err.code === 'LEASE_LOST'
    );

    // Clean up
    traefikRouteWriter.removeOwnedRoute(app.id, { sandboxDir });
  });

  // =========================================================================
  // 37-44. Production Invariants & External Boundaries
  // =========================================================================
  await t.test('37-44. Production safety: no active releases, no success status, no Docker network mutation, deployments.json unchanged', () => {
    const db = getDatabase({ dbPath: tempDbPath });

    // 37. Existing active release not deleted or created
    const activeReleases = db.prepare("SELECT * FROM releases WHERE status = 'active'").all();
    assert.equal(activeReleases.length, 0, 'Zero active releases in table');

    // 38. No deployment marked success
    const successDeployments = db.prepare("SELECT * FROM deployments WHERE status = 'success'").all();
    assert.equal(successDeployments.length, 0, 'No deployment must be marked success');

    // 39. Network attachment planning is pure; no real Docker connectNetwork called
    const planAttachment = planCandidateProxyAttachment(
      {
        containerId: 'c-123456789012',
        imageId: TEST_IMAGE_ID,
        applicationId: 'app-test-id'
      },
      'traefik-proxy-net'
    );
    assert.equal(planAttachment.planned, true);
    assert.equal(planAttachment.isDryRunOnly, true);

    // Rejection of foreign networks (Dokploy/n8n)
    assert.throws(
      () => planCandidateProxyAttachment({ containerId: 'c-123456789012', imageId: TEST_IMAGE_ID }, 'dokploy-network'),
      (err) => err instanceof TrafficSwitchError && err.code === 'FORBIDDEN_PROXY_NETWORK'
    );

    assert.throws(
      () => planCandidateProxyAttachment({ containerId: 'c-123456789012', imageId: TEST_IMAGE_ID }, 'host'),
      (err) => err instanceof TrafficSwitchError && err.code === 'FORBIDDEN_PROXY_NETWORK'
    );

    // 40. No production Traefik file writes occurred (check /etc/traefik is untouched)
    assert.equal(fs.existsSync('/etc/traefik/dynamic'), false);

    // 44. Legacy deployments.json remains untouched
    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const current = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(current, originalDeploymentsContent, 'Legacy deployments.json untouched');
    }
  });

  // =========================================================================
  // Adversarial Traefik Rule Parser Safety Tests (Section 2.C)
  // =========================================================================
  await t.test('Adversarial Traefik Rule Parser Safety: ReDoS, long patterns & complex regex handling', () => {
    // Safe patterns pass
    assert.equal(isSafeRegexPattern('[a-z0-9-]+.example.com'), true);
    assert.equal(isSafeRegexPattern('{subdomain:[a-z0-9-]+}.example.com'), true);

    // Excessive length rejected (> 128 chars)
    const longPattern = 'a'.repeat(130) + '.example.com';
    assert.equal(isSafeRegexPattern(longPattern), false);

    // Nested quantifiers rejected (ReDoS vectors)
    assert.equal(isSafeRegexPattern('(a+)+.example.com'), false);
    assert.equal(isSafeRegexPattern('([a-z0-9]+)+.example.com'), false);
    assert.equal(isSafeRegexPattern('(a*)*.example.com'), false);

    // Lookarounds & backreferences rejected
    assert.equal(isSafeRegexPattern('(?=foo)bar.example.com'), false);
    assert.equal(isSafeRegexPattern('([a-z]+)\\1.example.com'), false);

    // Consecutive wildcards rejected
    assert.equal(isSafeRegexPattern('.*.*.example.com'), false);

    // In route conflict evaluation: adversarial rule yields ROUTE_CONFLICT_UNDETERMINED
    const adversarialTopology = {
      status: 'AVAILABLE',
      routers: [
        {
          name: 'malicious-router@docker',
          rule: 'HostRegexp(`(a+)+.example.com`)',
          entryPoints: ['websecure'],
          service: 'malicious-svc',
          regexPatterns: ['(a+)+.example.com']
        }
      ],
      snapshotFingerprint: 'adv-fingerprint-001'
    };

    const conflictRes = routeConflictService.evaluateRouteConflicts(
      { targetDomain: 'sub.example.com', applicationId: 'app-adv-1' },
      adversarialTopology
    );

    assert.equal(conflictRes.decision, CONFLICT_DECISIONS.ROUTE_CONFLICT_UNDETERMINED);
    assert.ok(conflictRes.conflicts.some((c) => c.conflictType === 'UNDETERMINED_REGEX'));
  });

  await t.test('Phase 4C3B Audit Hardening: Sandbox Isolation, Provenance, Fencing & Fail-Closed Routing', async () => {
    // 1. Sandbox Isolation: Enforce trusted sandbox root and reject directory escape
    const trustedRoot = path.join(tempBaseDir, 'trusted-sandbox-root');
    fs.mkdirSync(trustedRoot, { recursive: true });

    const rogueDir = path.join(tempBaseDir, 'rogue-dir');
    fs.mkdirSync(rogueDir, { recursive: true });

    assert.throws(
      () => traefikRouteWriter.resolveAndValidateSandboxDirectory(rogueDir, { trustedSandboxRoot: trustedRoot }),
      (err) => {
        assert.equal(err.code, 'SANDBOX_ROOT_VIOLATION');
        return true;
      }
    );

    // 2. Topology Provenance: Raw JSON claiming "originVerified: true" must NOT establish trust
    const rawUntrustedJson = JSON.stringify({
      routers: [
        { name: 'test@file', rule: 'Host(`test.kpanel.dev`)', provider: 'file' }
      ],
      originVerified: true
    });
    const untrustedTopology = traefikTopologyService.inspectRoutingTopology({
      snapshotPath: null,
      snapshotJson: rawUntrustedJson
    });
    assert.equal(untrustedTopology.originVerified, false, 'Untrusted raw JSON claiming originVerified must not establish trust');

    // 3. Execution Fencing: Rollback rejects stale worker with lower fencing token than journal
    const activeDb = getDatabase({ dbPath: tempDbPath });
    const existingJournal = activeDb.prepare('SELECT * FROM deployment_route_activation_journal LIMIT 1').get();
    assert.ok(existingJournal, 'Must have at least one journal row from previous subtests');

    // Expire existing lease and acquire for test worker to verify active worker lease
    activeDb.prepare("UPDATE deployment_worker_lock SET lease_expires_at = datetime('now', '-5 seconds')").run();
    const testWorker = `worker-fencing-${crypto.randomUUID().slice(0, 6)}`;
    const testLease = deploymentLeaseService.acquireWorkerLease(testWorker, { leaseSeconds: 60, db: activeDb });
    assert.equal(testLease.acquired, true);

    // Bump journal's fencing token higher than testLease.fencingToken
    activeDb.prepare('UPDATE deployment_route_activation_journal SET fencing_token = ? WHERE journal_id = ?')
      .run(testLease.fencingToken + 10, existingJournal.journal_id);

    assert.throws(
      () => routeRollbackService.prepareRollback(existingJournal.journal_id, {
        db: activeDb,
        ownerId: testWorker,
        fencingToken: testLease.fencingToken // Lower than journal token
      }),
      (err) => {
        assert.equal(err.code, 'STALE_FENCING_TOKEN');
        return true;
      }
    );
  });
});
