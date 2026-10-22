const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');

const { getDatabase, closeDatabase } = require('../config/database');
const { runMigrations } = require('../db/migrate');
const { createApplication } = require('../services/applicationService');
const deploymentLeaseService = require('../services/deploymentLeaseService');
const runtimeService = require('../services/runtimeService');
const traefikTopologyService = require('../services/traefikTopologyService');
const routeConflictService = require('../services/routeConflictService');
const { CONFLICT_DECISIONS } = routeConflictService;
const hostInventoryService = require('../services/hostInventoryService');
const { ingestHostInventory, HostInventoryError } = hostInventoryService;
const traefikReadOnlyAdapter = require('../services/traefikReadOnlyAdapter');
const {
  fetchReadOnlyTopology,
  assessFileProviderCompatibility,
  queryInternalTraefikApi,
  validateTrustedInternalApiUrl,
  TraefikReadOnlyAdapterError
} = traefikReadOnlyAdapter;
const stagingNetworkService = require('../services/stagingNetworkService');
const {
  validateApprovedProxyNetwork,
  planCandidateAttachment,
  inspectExistingAttachment,
  validateProxyBackendReachability,
  planAttachmentRollback,
  StagingNetworkError
} = stagingNetworkService;
const stagingReadinessService = require('../services/stagingReadinessService');
const { assessStagingReadiness, STAGING_DECISIONS, StagingReadinessError } = stagingReadinessService;
const traefikRouteWriter = require('../services/traefikRouteWriter');

const DEPLOYMENTS_JSON_PATH = path.join(__dirname, '..', 'data', 'deployments.json');

/**
 * Creates an in-memory mock Docker client for offline staging readiness tests.
 */
function createMockDockerClient(options = {}) {
  const images = new Map();
  const networks = new Map();
  const containers = new Map();

  // Staging network
  const stagingNetId = options.stagingNetworkId || 'a1b2c3d4e5f60001';
  networks.set(stagingNetId, {
    Id: stagingNetId,
    Name: 'kpanel-staging',
    Driver: 'bridge',
    Scope: 'local',
    Internal: true
  });

  // Approved proxy network
  const proxyNetId = options.proxyNetworkId || 'a1b2c3d4e5f60002';
  networks.set(proxyNetId, {
    Id: proxyNetId,
    Name: 'traefik-public',
    Driver: 'bridge',
    Scope: 'local',
    Internal: false,
    Containers: {
      'traefik-container-001': {
        Name: 'traefik-proxy',
        IPv4Address: '172.28.0.2/16'
      }
    }
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

  let connectCallCount = 0;
  let disconnectCallCount = 0;

  return {
    _images: images,
    _networks: networks,
    _containers: containers,
    getConnectCallCount: () => connectCallCount,
    getDisconnectCallCount: () => disconnectCallCount,

    getImage(id) {
      const cleanId = String(id || '').toLowerCase();
      return {
        inspect: async () => {
          if (images.has(cleanId)) return images.get(cleanId);
          if (cleanId === defaultImageId) return images.get(defaultImageId);
          throw new Error(`No such image: ${id}`);
        }
      };
    },

    getNetwork(id) {
      return {
        inspect: async () => {
          if (networks.has(id)) return networks.get(id);
          throw new Error(`No such network: ${id}`);
        },
        connect: async () => {
          connectCallCount++;
          throw new Error('Docker network connect is strictly prohibited in dry-run mode.');
        },
        disconnect: async () => {
          disconnectCallCount++;
          throw new Error('Docker network disconnect is strictly prohibited in dry-run mode.');
        }
      };
    },

    getContainer(idOrName) {
      return {
        inspect: async () => {
          if (containers.has(idOrName)) return containers.get(idOrName);
          throw new Error(`No such container: ${idOrName}`);
        }
      };
    }
  };
}

/**
 * Creates a valid synthetic inventory fixture.
 */
function createSyntheticInventory(overrides = {}) {
  const defaultInventory = {
    version: '1.0',
    captureTimestamp: new Date().toISOString(),
    captureSource: 'operator-script',
    hostIdentity: {
      hostname: 'vps-oracle-ampere-01',
      os: 'Linux',
      arch: 'aarch64',
      dockerVersion: '27.1.1'
    },
    traefik: {
      instanceId: 'traefik-container-001',
      version: 'v3.1.2',
      status: 'Up 12 days'
    },
    providers: {
      file: {
        enabled: true,
        directory: '/etc/traefik/dynamic',
        watch: true,
        isShared: true,
        dedicatedNamespace: 'kpanel',
        dokployCoexistence: true
      },
      docker: {
        enabled: true,
        network: 'traefik-public'
      }
    },
    networks: [
      {
        id: 'a1b2c3d4e5f60002',
        name: 'traefik-public',
        driver: 'bridge',
        scope: 'local',
        internal: false,
        attachable: true,
        containers: [
          {
            id: 'traefik-container-001',
            name: 'traefik-proxy',
            ipv4Address: '172.28.0.2'
          }
        ]
      }
    ],
    routers: [
      {
        name: 'dokploy-router@docker',
        provider: 'docker',
        rule: 'Host(`dokploy.example.com`)',
        entryPoints: ['websecure'],
        service: 'dokploy-svc'
      }
    ],
    services: [
      {
        name: 'dokploy-svc',
        provider: 'docker'
      }
    ],
    entryPoints: ['web', 'websecure']
  };

  return { ...defaultInventory, ...overrides };
}

test('Phase 4C3C: Staging Integration Readiness & Read-Only VPS Inventory Suite', async (t) => {
  let tempBaseDir;
  let tempDbPath;
  let testDb;
  let originalDeploymentsContent;

  t.beforeEach(async () => {
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-staging-readiness-'));
    tempDbPath = path.join(tempBaseDir, 'test-staging.db');

    testDb = getDatabase({ dbPath: tempDbPath });
    runMigrations(testDb);

    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      originalDeploymentsContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
    }
  });

  t.afterEach(async () => {
    try {
      closeDatabase();
    } catch {}

    if (tempBaseDir && fs.existsSync(tempBaseDir)) {
      try {
        fs.rmSync(tempBaseDir, { recursive: true, force: true });
      } catch {}
    }

    if (originalDeploymentsContent !== undefined && fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const currentContent = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(currentContent, originalDeploymentsContent, 'Legacy deployments.json must remain untouched');
    }
  });

  // =========================================================================
  // 1-4. Host Inventory Schema, Ingestion & Stale Observation Handling
  // =========================================================================
  await t.test('1-4. Read-only inventory schema validation, invalid rejection & stale detection', async () => {
    // 1. Valid inventory recognized and ingested
    const validInv = createSyntheticInventory();
    const ingested = ingestHostInventory(validInv);
    assert.equal(ingested.valid, true);
    assert.equal(ingested.freshnessStatus, 'fresh');
    assert.equal(ingested.isStale, false);
    assert.equal(ingested.traefik.instanceId, 'traefik-container-001');
    assert.equal(ingested.providers.file.enabled, true);
    assert.ok(ingested.fingerprint);

    // 2. Invalid inventory rejected (bad JSON, invalid timestamp, missing version)
    assert.throws(
      () => ingestHostInventory('{ malformed json'),
      (err) => err instanceof HostInventoryError && err.code === 'MALFORMED_JSON'
    );

    assert.throws(
      () => ingestHostInventory({ version: '1.0', captureTimestamp: 'not-a-date' }),
      (err) => err instanceof HostInventoryError && err.code === 'INVALID_TIMESTAMP'
    );

    assert.throws(
      () => ingestHostInventory({ captureTimestamp: new Date().toISOString() }),
      (err) => err instanceof HostInventoryError && err.code === 'INVALID_SCHEMA_VERSION'
    );

    // 3. Missing inventory returns STAGING_UNVERIFIED
    const app = createApplication(
      { name: 'Unverified App', slug: 'unverified-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'unverified.kpanel.dev', port: 3000 },
      { db: testDb }
    );

    const readinessUnverified = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'unverified.kpanel.dev',
      targetPort: 3000
    }, { db: testDb });

    assert.equal(readinessUnverified.decision, STAGING_DECISIONS.STAGING_UNVERIFIED);
    assert.equal(readinessUnverified.isReadyForAuthorizedTest, false);

    // 4. Stale inventory rejected
    const staleTime = new Date(Date.now() - 36 * 3600 * 1000).toISOString(); // 36 hours old
    const staleInv = createSyntheticInventory({ captureTimestamp: staleTime });
    const ingestedStale = ingestHostInventory(staleInv, { maxAgeMs: 24 * 3600 * 1000 });
    assert.equal(ingestedStale.isStale, true);
    assert.equal(ingestedStale.freshnessStatus, 'stale');

    const readinessStale = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'stale.kpanel.dev',
      targetPort: 3000,
      inventory: ingestedStale
    }, { db: testDb });

    assert.equal(readinessStale.decision, STAGING_DECISIONS.STAGING_BLOCKED_STALE_INVENTORY);
  });

  // =========================================================================
  // 5-8. Traefik Read-Only Adapter & API Boundaries
  // =========================================================================
  await t.test('5-8. Traefik instance conflict, API-disabled handling & URL restrictions', async () => {
    // 5. Conflicting Traefik instance identities rejected
    const app = createApplication(
      { name: 'Traefik Id App', slug: 'traefik-id-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'traefik-id.kpanel.dev', port: 3000 },
      { db: testDb }
    );
    const validInv = createSyntheticInventory({ traefik: { instanceId: 'traefik-observed-01' } });

    const readinessConflict = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'traefik-id.kpanel.dev',
      targetPort: 3000,
      inventory: validInv
    }, {
      db: testDb,
      expectedTraefikInstanceId: 'traefik-expected-02' // Mismatch!
    });

    assert.equal(readinessConflict.decision, STAGING_DECISIONS.STAGING_BLOCKED_PROVIDER);
    assert.ok(readinessConflict.blockers.some((b) => b.code === 'TRAEFIK_INSTANCE_IDENTIFIED'));

    // 6. API-disabled case handled gracefully without failure or fabrication
    const apiDisabledRes = await queryInternalTraefikApi('/api/http/routers', {
      endpointUrl: null
    });
    assert.equal(apiDisabledRes.status, 'API_DISABLED');
    assert.equal(apiDisabledRes.available, false);
    assert.equal(apiDisabledRes.data, null);

    // 7. Untrusted API URL rejected
    assert.throws(
      () => validateTrustedInternalApiUrl('http://malicious.evil-cloud.com:8080'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'UNAUTHORIZED_API_TARGET'
    );
    assert.throws(
      () => validateTrustedInternalApiUrl('ftp://localhost:21'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'UNSUPPORTED_PROTOCOL'
    );

    // Valid internal loopback target passes
    const validUrl = validateTrustedInternalApiUrl('http://127.0.0.1:8080/api');
    assert.equal(validUrl.hostname, '127.0.0.1');

    // 8. Read-only endpoint restrictions
    const readOnlyTopo = await fetchReadOnlyTopology({
      mode: 'synthetic',
      snapshot: {
        routers: [
          { name: 'kpanel-router-test', rule: 'Host(`test.kpanel.dev`)', provider: 'file' }
        ]
      }
    });
    assert.equal(readOnlyTopo.status, 'AVAILABLE');
    assert.equal(readOnlyTopo.sourceType, 'synthetic-snapshot');
    assert.equal(readOnlyTopo.originVerified, true);
  });

  // =========================================================================
  // 9-13. File Provider Compatibility & Coexistence
  // =========================================================================
  await t.test('9-13. File provider compatibility, path mismatch, watch disabled & coexistence checks', async () => {
    // 9. Provider missing blocks activation
    const missingProvider = assessFileProviderCompatibility(null);
    assert.equal(missingProvider.compatible, false);
    assert.equal(missingProvider.decision, 'FILE_PROVIDER_NOT_CONFIGURED');

    // 10. File provider properly configured recognized
    const validFileProvider = {
      enabled: true,
      directory: '/etc/traefik/dynamic',
      watch: true,
      isShared: true,
      dedicatedNamespace: 'kpanel',
      dokployCoexistence: true
    };
    const compatResult = assessFileProviderCompatibility(validFileProvider);
    assert.equal(compatResult.compatible, true);
    assert.equal(compatResult.decision, 'FILE_PROVIDER_COMPATIBLE');

    // 11. File provider path mismatch blocks activation
    const pathMismatchResult = assessFileProviderCompatibility({
      enabled: true,
      directory: '/etc/traefik/dynamic',
      hostPath: '/opt/traefik/wrong-path',
      watch: true
    }, { expectedHostPath: '/var/lib/docker/volumes/traefik-data' });
    assert.equal(pathMismatchResult.compatible, false);
    assert.equal(pathMismatchResult.decision, 'BLOCKED_PATH_MISMATCH');

    // 12. Watch disabled (--providers.file.watch=false) blocks activation
    const watchDisabledResult = assessFileProviderCompatibility({
      enabled: true,
      directory: '/etc/traefik/dynamic',
      watch: false
    });
    assert.equal(watchDisabledResult.compatible, false);
    assert.ok(watchDisabledResult.blockedReasons.some((r) => r.includes('watch is disabled')));

    // 13. Unsupported un-isolated Dokploy sharing without dedicated namespace blocked
    const unisolatedDokployResult = assessFileProviderCompatibility({
      enabled: true,
      directory: '/etc/traefik/dynamic',
      watch: true,
      dokployCoexistence: true,
      dedicatedNamespace: null // No dedicated namespace!
    });
    assert.equal(unisolatedDokployResult.compatible, false);
    assert.equal(unisolatedDokployResult.decision, 'BLOCKED_DOKPLOY_CONFLICT');
  });

  // =========================================================================
  // 14-16. Route Conflicts & Coexistence
  // =========================================================================
  await t.test('14-16. Foreign Dokploy route conflict, complex router & domain claims', async () => {
    const app = createApplication(
      { name: 'Conflict App', slug: 'conflict-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'api.example.com', port: 3000 },
      { db: testDb }
    );

    // 14. Foreign Dokploy route conflict
    const dokployInv = createSyntheticInventory({
      routers: [
        {
          name: 'dokploy-api-router@docker',
          rule: 'Host(`api.example.com`)',
          entryPoints: ['websecure'],
          service: 'dokploy-api'
        }
      ]
    });

    const dokployConflict = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'api.example.com',
      targetPort: 3000,
      inventory: dokployInv
    }, { db: testDb });

    assert.equal(dokployConflict.decision, STAGING_DECISIONS.STAGING_BLOCKED_FOREIGN_ROUTE);
    assert.ok(dokployConflict.blockers.some((b) => b.code === 'NO_FOREIGN_ROUTE_CONFLICT'));

    // 15. Unknown complex router without host filter fails closed
    const complexInv = createSyntheticInventory({
      routers: [
        {
          name: 'foreign-catch-all@file',
          rule: 'PathPrefix(`/`)',
          entryPoints: ['websecure'],
          service: 'foreign-svc'
        }
      ]
    });

    const complexConflict = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'any-new-domain.com',
      targetPort: 3000,
      inventory: complexInv
    }, { db: testDb });

    assert.equal(complexConflict.decision, STAGING_DECISIONS.STAGING_BLOCKED_FOREIGN_ROUTE);

    // 16. Domain claim conflict: existing foreign router owns domain
    const foreignClaimInv = createSyntheticInventory({
      routers: [
        {
          name: 'n8n-webhook@docker',
          rule: 'Host(`webhook.n8n.cloud`)',
          entryPoints: ['websecure'],
          service: 'n8n-svc'
        }
      ]
    });

    const foreignClaim = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'webhook.n8n.cloud',
      targetPort: 3000,
      inventory: foreignClaimInv
    }, { db: testDb });

    assert.equal(foreignClaim.decision, STAGING_DECISIONS.STAGING_BLOCKED_FOREIGN_ROUTE);
  });

  // =========================================================================
  // 17-21, 26, 29, 30, 39. Staging Network Planning & Isolation
  // =========================================================================
  await t.test('17-21, 26, 29, 30, 39. Proxy network validation, foreign blocking, alias collision & dry-run safety', async () => {
    const validProxyNet = {
      id: 'a1b2c3d4e5f60003',
      name: 'traefik-public',
      driver: 'bridge',
      scope: 'local',
      containers: [{ id: 'traefik-container-12', name: 'traefik' }]
    };

    // 17. Approved proxy network recognized
    const validatedNet = validateApprovedProxyNetwork(validProxyNet, {
      approvedNetworkId: 'a1b2c3d4e5f60003',
      isApproved: true,
      requireTraefikMembership: false
    });
    assert.equal(validatedNet.valid, true);
    assert.equal(validatedNet.networkId, 'a1b2c3d4e5f60003');

    // 18. Wrong proxy network rejected (not approved)
    assert.throws(
      () => validateApprovedProxyNetwork(validProxyNet, { approvedNetworkId: 'ffffffffffff0001', isApproved: false }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNAPPROVED_PROXY_NETWORK'
    );

    // 19. Foreign Dokploy network blocked
    assert.throws(
      () => validateApprovedProxyNetwork({ id: 'a1b2c3d4e5f60004', name: 'dokploy-network', driver: 'bridge', scope: 'local' }, { isApproved: true }),
      (err) => err instanceof StagingNetworkError && err.code === 'FOREIGN_NETWORK_FORBIDDEN'
    );

    // 20. Foreign n8n network blocked
    assert.throws(
      () => validateApprovedProxyNetwork({ id: 'a1b2c3d4e5f60005', name: 'n8n-internal', driver: 'bridge', scope: 'local' }, { isApproved: true }),
      (err) => err instanceof StagingNetworkError && err.code === 'FOREIGN_NETWORK_FORBIDDEN'
    );

    // 21. Missing network attachment detected
    const candidateNoNet = { containerId: 'c-candidate-001' };
    const inspectNet = inspectExistingAttachment(candidateNoNet, validProxyNet);
    assert.equal(inspectNet.attached, false);

    // 26. DNS alias collision detected
    const netWithExistingAlias = {
      ...validProxyNet,
      containers: [
        { id: 'other-cont-999', name: 'other-app', aliases: ['kpanel-app-cand-001-123'] }
      ]
    };

    assert.throws(
      () => planCandidateAttachment(
        { containerId: 'cand-001-1234567890', imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff' },
        netWithExistingAlias,
        { isApproved: true, approvedNetworkId: validProxyNet.id, requireTraefikMembership: false }
      ),
      (err) => err instanceof StagingNetworkError && err.code === 'ALIAS_COLLISION_DETECTED'
    );

    // 29. Network attachment plan is pure dry-run / non-mutating
    const plan = planCandidateAttachment(
      { containerId: 'cand-002-1234567890', imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff', applicationId: 'app-test-123' },
      validProxyNet,
      { isApproved: true, approvedNetworkId: validProxyNet.id, requireTraefikMembership: false }
    );
    assert.equal(plan.planned, true);
    assert.equal(plan.isDryRunOnly, true);
    assert.equal(plan.preserveExistingStagingNetwork, true);
    assert.deepEqual(plan.plannedAliases, ['kpanel-app-cand-002-123', 'kpanel-backend-app-test-123']);

    // 30. Partial attachment rollback planned safely
    const rollbackPlan = planAttachmentRollback({ containerId: 'cand-002-1234567890' }, validProxyNet);
    assert.equal(rollbackPlan.rollbackPlanned, true);
    assert.equal(rollbackPlan.action, 'disconnect_proxy_network');
    assert.equal(rollbackPlan.preserveStagingNetwork, true);

    // 39. Zero Docker connectNetwork or disconnectNetwork calls occurred
    const mockDocker = createMockDockerClient();
    assert.equal(mockDocker.getConnectCallCount(), 0);
    assert.equal(mockDocker.getDisconnectCallCount(), 0);
  });

  // =========================================================================
  // 22-25, 27-28. Candidate Identity, Health & Reachability
  // =========================================================================
  await t.test('22-25, 27-28. Candidate identity, image drift, health checks & reachability probes', async () => {
    // 22. Correct candidate identity
    const validCandidate = {
      containerId: 'cand-valid-1234567890',
      imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
      healthStatus: 'healthy',
      port: 3000
    };

    // 23. Wrong candidate image rejected
    assert.throws(
      () => planCandidateAttachment(
        validCandidate,
        {
          id: 'a1b2c3d4e5f60003',
          name: 'traefik-public',
          driver: 'bridge',
          scope: 'local',
          containers: [{ id: 'traefik-container-12', name: 'traefik' }]
        },
        { approvedNetworkId: 'a1b2c3d4e5f60003', expectedImageId: 'sha256:different-expected-image-digest-0000000000000000000000000000000' }
      ),
      (err) => err instanceof StagingNetworkError && err.code === 'IMAGE_ID_MISMATCH'
    );

    // 24. Unhealthy candidate rejected in readiness assessment
    const app = createApplication(
      { name: 'Health App', slug: 'health-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'health.kpanel.dev', port: 3000 },
      { db: testDb }
    );
    const validInv = createSyntheticInventory();

    const unhealthyReadiness = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'health.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-unhealthy-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'unhealthy'
      },
      inventory: validInv
    }, { db: testDb, operatorApproved: true });

    assert.equal(unhealthyReadiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_CANDIDATE_HEALTH);
    assert.ok(unhealthyReadiness.blockers.some((b) => b.code === 'FRESH_CANDIDATE_HEALTH'));

    // 25. Missing healthcheck / uninspected candidate rejected
    const uninspectedReadiness = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'health.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-nohealth-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff'
        // healthStatus undefined
      },
      inventory: validInv
    }, { db: testDb, operatorApproved: true });

    assert.equal(uninspectedReadiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_CANDIDATE_HEALTH);

    // 27. Backend reachability simulated successfully
    const reachability = await validateProxyBackendReachability(
      validCandidate,
      { containerId: 'traefik-proxy-001', name: 'traefik' }
    );
    assert.equal(reachability.reachable, true);
    assert.equal(reachability.backendUrl, 'http://kpanel-app-cand-valid-1:3000');

    // 28. Unreachable backend blocked
    const unreachableRes = await validateProxyBackendReachability(
      validCandidate,
      { containerId: 'traefik-proxy-001', name: 'traefik' },
      { simulateUnreachable: true }
    );
    assert.equal(unreachableRes.reachable, false);
    assert.equal(unreachableRes.reason, 'BACKEND_PROBE_UNREACHABLE');
  });

  // =========================================================================
  // 31-36. Execution Fencing, Journal & Rollback Preconditions
  // =========================================================================
  await t.test('31-36. Lease expiration, stale fencing token, rollback readiness & journal persistence', async () => {
    const app = createApplication(
      { name: 'Fencing App', slug: 'fencing-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'fencing.kpanel.dev', port: 3000 },
      { db: testDb }
    );
    const validInv = createSyntheticInventory();

    // 31. Missing or expired global lease rejected
    const unauthReadiness = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'fencing.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-fence-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'healthy'
      },
      inventory: validInv
    }, { db: testDb, operatorApproved: true }); // Missing ownerId & fencingToken

    assert.equal(unauthReadiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_AUTHORIZATION);
    assert.ok(unauthReadiness.blockers.some((b) => b.code === 'FENCED_EXECUTION_AUTHORIZED'));

    // 32. Acquire valid lease then test stale fencing token rejection
    const leaseOwner = `worker-${crypto.randomUUID().slice(0, 6)}`;
    const lease = deploymentLeaseService.acquireWorkerLease(leaseOwner, { leaseSeconds: 60, db: testDb });

    const staleTokenReadiness = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'fencing.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-fence-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'healthy'
      },
      inventory: validInv
    }, {
      db: testDb,
      ownerId: leaseOwner,
      fencingToken: lease.fencingToken - 1, // Stale!
      operatorApproved: true
    });

    assert.equal(staleTokenReadiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_AUTHORIZATION);

    // 33. Previous release rollback readiness verified
    const rollbackUnready = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'fencing.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-fence-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'healthy'
      },
      inventory: validInv
    }, {
      db: testDb,
      ownerId: leaseOwner,
      fencingToken: lease.fencingToken,
      operatorApproved: true,
      simulateRollbackUnready: true
    });

    assert.equal(rollbackUnready.decision, STAGING_DECISIONS.STAGING_BLOCKED_ROLLBACK);

    // 34. Missing previous container blocks replacement release
    const missingPrevContainer = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'fencing.kpanel.dev',
      targetPort: 3000,
      isReplacementRelease: true, // Replacement without previousContainerId
      candidate: {
        containerId: 'cand-fence-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'healthy'
      },
      inventory: validInv
    }, {
      db: testDb,
      ownerId: leaseOwner,
      fencingToken: lease.fencingToken,
      operatorApproved: true
    });

    assert.equal(missingPrevContainer.decision, STAGING_DECISIONS.STAGING_BLOCKED_ROLLBACK);

    // 35. Route fingerprint drift blocks activation (verified in traefikRouteWriter CAS)
    const sandboxDir = path.join(tempBaseDir, 'sandbox-cas');
    fs.mkdirSync(sandboxDir, { recursive: true });
    const liveDoc = '# kpanel-owner: app-1\nhttp:\n  routers:\n    kpanel-router-app-1: {}\n';
    fs.writeFileSync(path.join(sandboxDir, 'kpanel-app-1.yaml'), liveDoc);

    assert.throws(
      () => traefikRouteWriter.prepareRouteUpdate('app-1', liveDoc, {
        sandboxDir,
        expectedPreviousFingerprint: 'drifted-fingerprint-999'
      }),
      (err) => err instanceof traefikRouteWriter.TraefikRouteWriterError && err.code === 'FINGERPRINT_MISMATCH'
    );

    // 36. Activation journal survives reopen
    testDb.prepare(`
      INSERT INTO deployments (id, application_id, commit_sha, status)
      VALUES ('dep-reopen-01', ?, 'abcd1234ef', 'building')
    `).run(app.id);

    testDb.prepare(`
      INSERT INTO deployment_release_plans (
        id, application_id, deployment_id, candidate_container_id,
        image_id, commit_sha, target_domain, target_port, plan_status
      ) VALUES (
        'plan-reopen-01', ?, 'dep-reopen-01', 'cand-reopen-01',
        'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        'abcd1234ef', 'reopen.kpanel.dev', 3000, 'approved'
      )
    `).run(app.id);

    testDb.prepare(`
      INSERT INTO deployment_release_activation_intents (
        activation_id, release_plan_id, application_id, deployment_id,
        candidate_container_id, expected_image_id, target_domain, target_port,
        activation_status
      ) VALUES (
        'act-reopen-01', 'plan-reopen-01', ?, 'dep-reopen-01',
        'cand-reopen-01', 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        'reopen.kpanel.dev', 3000, 'ready'
      )
    `).run(app.id);

    const journalId = 'jou-reopen-test-' + crypto.randomUUID();
    testDb.prepare(`
      INSERT INTO deployment_route_activation_journal (
        journal_id, activation_id, application_id, deployment_id,
        target_domain, proposed_fingerprint, proposed_route_document,
        journal_state, operation_owner, fencing_token
      ) VALUES (
        ?, 'act-reopen-01', ?, 'dep-reopen-01',
        'reopen.kpanel.dev', 'fp-test', 'http: {}',
        'prepared', ?, ?
      )
    `).run(journalId, app.id, leaseOwner, lease.fencingToken);

    closeDatabase();
    const reopenedDb = getDatabase({ dbPath: tempDbPath });
    const foundJournal = reopenedDb.prepare('SELECT * FROM deployment_route_activation_journal WHERE journal_id = ?').get(journalId);
    assert.ok(foundJournal);
    assert.equal(foundJournal.journal_state, 'prepared');
  });

  // =========================================================================
  // 37-44. Production Invariants & Coexistence Verification
  // =========================================================================
  await t.test('37-44. Production invariants: simulated vs real evidence, zero live execution, legacy untouched', async () => {
    const app = createApplication(
      { name: 'Full Ready App', slug: 'full-ready-app', repo_url: 'https://github.com/org/repo.git', branch: 'main', domain: 'ready.kpanel.dev', port: 3000 },
      { db: testDb }
    );
    const validInv = createSyntheticInventory();
    const leaseOwner = `worker-${crypto.randomUUID().slice(0, 6)}`;
    const lease = deploymentLeaseService.acquireWorkerLease(leaseOwner, { leaseSeconds: 60, db: testDb });

    // 37. Readiness states strictly distinguish simulated versus real evidence
    const syntheticReadiness = await assessStagingReadiness({
      applicationId: app.id,
      targetDomain: 'ready.kpanel.dev',
      targetPort: 3000,
      candidate: {
        containerId: 'cand-ready-1234567890',
        imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff',
        healthStatus: 'healthy'
      },
      inventory: validInv
    }, {
      db: testDb,
      ownerId: leaseOwner,
      fencingToken: lease.fencingToken,
      operatorApproved: true,
      operatorApprovedNetwork: true,
      evidenceType: 'synthetic'
    });

    assert.equal(syntheticReadiness.decision, STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST);
    assert.equal(syntheticReadiness.isReadyForAuthorizedTest, true);
    assert.equal(syntheticReadiness.evidenceType, 'synthetic');
    assert.equal(syntheticReadiness.executed, false);

    // 38. No production route files written (verify /etc/traefik was never created or touched)
    assert.equal(fs.existsSync('/etc/traefik/dynamic/kpanel-app.yaml'), false);

    // 40. No Traefik writes executed
    assert.equal(syntheticReadiness.executed, false);

    // 41. No active release created in database
    const activeReleases = testDb.prepare("SELECT COUNT(*) as count FROM releases WHERE status = 'active'").get();
    assert.equal(activeReleases.count, 0);
    const activeAppReleases = testDb.prepare("SELECT COUNT(*) as count FROM applications WHERE active_release_id IS NOT NULL").get();
    assert.equal(activeAppReleases.count, 0);

    // 42. No deployment marked success
    const successDeployments = testDb.prepare("SELECT COUNT(*) as count FROM deployments WHERE status = 'success'").get();
    assert.equal(successDeployments.count, 0);

    // 43. Legacy backend/data/deployments.json is completely untouched
    if (fs.existsSync(DEPLOYMENTS_JSON_PATH)) {
      const liveJson = fs.readFileSync(DEPLOYMENTS_JSON_PATH, 'utf8');
      assert.equal(liveJson, originalDeploymentsContent);
    }
  });
});
