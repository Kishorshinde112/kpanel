const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const hostInventoryService = require('../services/hostInventoryService');
const {
  ingestHostInventory,
  classifyHostIntegrationScenario,
  redactInventoryForReview,
  HostInventoryError,
  MAX_PLANNING_INVENTORY_AGE_MS,
  MAX_ACTIVATION_INVENTORY_AGE_MS
} = hostInventoryService;

const traefikReadOnlyAdapter = require('../services/traefikReadOnlyAdapter');
const {
  validateTrustedInternalApiUrl,
  queryInternalTraefikApi,
  assessFileProviderCompatibility,
  TraefikReadOnlyAdapterError
} = traefikReadOnlyAdapter;

const stagingNetworkService = require('../services/stagingNetworkService');
const {
  validateApprovedProxyNetwork,
  planCandidateAttachment,
  StagingNetworkError
} = stagingNetworkService;

const stagingReadinessService = require('../services/stagingReadinessService');
const { assessStagingReadiness, STAGING_DECISIONS } = stagingReadinessService;

const { runStagingPreflightHarness } = require('../scripts/stagingPreflightHarness');

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
const INVENTORY_SCRIPT_PATH = path.join(__dirname, '..', '..', 'scripts', 'collect-kpanel-host-inventory.sh');

test('Phase 4C3D1: Real Host Inventory Safety, Hardening & Staging Preflight Suite', async (t) => {

  // =========================================================================
  // 1. Inventory Script Read-Only Command Audit
  // =========================================================================
  await t.test('1. Inventory script read-only command audit: no mutating commands, umask 077, safe fields', () => {
    assert.ok(fs.existsSync(INVENTORY_SCRIPT_PATH), 'Collection script must exist');
    const scriptContent = fs.readFileSync(INVENTORY_SCRIPT_PATH, 'utf8');

    // Strict prohibition of mutating commands
    const prohibitedCommands = [
      'docker run',
      'docker start',
      'docker stop',
      'docker rm',
      'docker network connect',
      'docker network disconnect',
      'docker network create',
      'docker network rm',
      'docker system prune',
      'docker compose up',
      'docker compose down',
      'systemctl restart',
      'service restart',
      'iptables -',
      'ufw ',
      'firewall-cmd'
    ];

    // Strip comments to verify executable code does not execute mutating commands
    const executableLines = scriptContent
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');

    for (const cmd of prohibitedCommands) {
      assert.ok(
        !executableLines.includes(cmd),
        `Collection script must NEVER execute mutating command: "${cmd}"`
      );
    }

    // Prohibit dumping container environment variables
    assert.ok(!executableLines.includes('.Config.Env'), 'Script must NEVER inspect container .Config.Env');

    // Enforce umask 077 for restricted permissions
    assert.ok(scriptContent.includes('umask 077'), 'Script must enforce umask 077 for 0600 file permissions');

    // Enforce bounded command execution
    assert.ok(scriptContent.includes('run_bounded'), 'Script must wrap external commands with bounded timeouts');
  });

  // =========================================================================
  // 2. Inventory Parser Compatibility
  // =========================================================================
  await t.test('2. Inventory parser compatibility: loads schema 1.1 fixture cleanly', () => {
    const readyFixturePath = path.join(FIXTURES_DIR, 'inventory-ready.json');
    const rawContent = fs.readFileSync(readyFixturePath, 'utf8');

    const ingested = ingestHostInventory(rawContent);
    assert.equal(ingested.valid, true);
    assert.equal(ingested.version, '1.1');
    assert.equal(ingested.hostIdentity.operatingSystem, 'Linux');
    assert.equal(ingested.hostIdentity.architecture, 'aarch64');
    assert.equal(ingested.traefik.instanceId, 'traefik00112233');
    assert.equal(ingested.providers.file.enabled, true);
    assert.equal(ingested.providers.file.directory, '/etc/traefik/dynamic');
    assert.equal(ingested.providers.file.watch, true);
    assert.equal(ingested.providers.file.hostPath, '/var/lib/kpanel/proxy/dynamic'); // Auto-discovered from mounts!
    assert.equal(ingested.networks.length, 1);
    assert.equal(ingested.routers.length, 1);
    assert.ok(ingested.fingerprint && ingested.fingerprint.length === 64);
  });

  // =========================================================================
  // 3. Missing Docker Detection
  // =========================================================================
  await t.test('3. Missing Docker detection: handles missing Docker daemon gracefully', () => {
    const missingDockerPayload = {
      version: '1.1',
      captureTimestamp: new Date().toISOString(),
      captureSource: 'operator-script',
      hostIdentity: {
        hostname: 'test-vps',
        os: 'Linux',
        arch: 'aarch64',
        dockerStatus: 'not-installed',
        dockerVersion: 'unavailable'
      },
      traefik: { instanceId: null, status: 'not-found' },
      providers: { file: { enabled: false }, docker: { enabled: false } },
      networks: [],
      routers: []
    };

    const ingested = ingestHostInventory(missingDockerPayload);
    assert.equal(ingested.valid, true);
    assert.equal(ingested.hostIdentity.dockerStatus, 'not-installed');
    assert.ok(ingested.missingOrUnverifiable.includes('TRAEFIK_INSTANCE_ID_MISSING'));
    assert.ok(ingested.missingOrUnverifiable.includes('DOCKER_NETWORKS_EMPTY'));
  });

  // =========================================================================
  // 4. Docker Permission Denied Handling
  // =========================================================================
  await t.test('4. Docker permission denied handling: records error without crashing', () => {
    const permDeniedPayload = {
      version: '1.1',
      captureTimestamp: new Date().toISOString(),
      captureSource: 'operator-script',
      hostIdentity: {
        hostname: 'test-vps',
        os: 'Linux',
        arch: 'aarch64',
        dockerStatus: 'permission_denied',
        dockerVersion: 'unavailable'
      },
      traefik: { instanceId: null, status: 'not-found' },
      providers: { file: { enabled: false }, docker: { enabled: false } },
      networks: [],
      routers: []
    };

    const ingested = ingestHostInventory(permDeniedPayload);
    assert.equal(ingested.valid, true);
    assert.equal(ingested.hostIdentity.dockerStatus, 'permission_denied');

    const scenario = classifyHostIntegrationScenario(ingested);
    assert.equal(scenario.scenario, 'SCENARIO_C');
    assert.equal(scenario.status, 'STAGING_UNVERIFIED');
  });

  // =========================================================================
  // 5. Traefik API Unavailable Handling
  // =========================================================================
  await t.test('5. Traefik API unavailable handling: graceful fallback without fabrication', async () => {
    // When no API URL configured
    const disabledRes = await queryInternalTraefikApi('/api/http/routers', { endpointUrl: null });
    assert.equal(disabledRes.status, 'API_DISABLED');
    assert.equal(disabledRes.available, false);
    assert.equal(disabledRes.data, null);

    // When unreachable port queried
    const unreachableRes = await queryInternalTraefikApi('/api/http/routers', {
      endpointUrl: 'http://127.0.0.1:65534',
      timeoutMs: 500
    });
    assert.equal(unreachableRes.status, 'API_INACCESSIBLE');
    assert.equal(unreachableRes.available, false);
  });

  // =========================================================================
  // 6. Provider Not Configured (Scenario B)
  // =========================================================================
  await t.test('6. Provider not configured (Scenario B): identifies missing File provider and risks', () => {
    const blockedProviderPath = path.join(FIXTURES_DIR, 'inventory-blocked-provider.json');
    const ingested = ingestHostInventory(fs.readFileSync(blockedProviderPath, 'utf8'));

    const scenario = classifyHostIntegrationScenario(ingested);
    assert.equal(scenario.scenario, 'SCENARIO_B');
    assert.equal(scenario.decision, 'FILE_PROVIDER_NOT_CONFIGURED');
    assert.ok(scenario.risks.some((r) => r.includes('Dokploy and n8n')));
    assert.ok(scenario.alternatives.length > 0);

    const compat = assessFileProviderCompatibility(ingested.providers.file);
    assert.equal(compat.compatible, false);
    assert.equal(compat.status, 'BLOCKED');
  });

  // =========================================================================
  // 7. Missing File Provider Mount Warning
  // =========================================================================
  await t.test('7. Missing File provider mount: assesses mount correspondence and read-only mounts', () => {
    // Read-only mount test
    const compatReadOnly = assessFileProviderCompatibility(
      { enabled: true, directory: '/etc/traefik/dynamic', watch: true },
      {
        mounts: [
          { destination: '/etc/traefik/dynamic', source: '/var/lib/kpanel/dynamic', rw: false }
        ]
      }
    );
    assert.equal(compatReadOnly.compatible, false);
    assert.ok(compatReadOnly.blockedReasons.some((r) => r.includes('read-only')));

    // Path mismatch test
    const compatMismatch = assessFileProviderCompatibility(
      { enabled: true, directory: '/etc/traefik/dynamic', watch: true, hostPath: '/wrong/path' },
      { expectedHostPath: '/expected/path' }
    );
    assert.equal(compatMismatch.compatible, false);
    assert.equal(compatMismatch.decision, 'BLOCKED_PATH_MISMATCH');
  });

  // =========================================================================
  // 8. Unrecognized Proxy Ownership (Scenario C)
  // =========================================================================
  await t.test('8. Unrecognized proxy ownership (Scenario C): returns STAGING_UNVERIFIED', () => {
    const unverifiedPath = path.join(FIXTURES_DIR, 'inventory-unverified.json');
    const ingested = ingestHostInventory(fs.readFileSync(unverifiedPath, 'utf8'));

    const scenario = classifyHostIntegrationScenario(ingested);
    assert.equal(scenario.scenario, 'SCENARIO_C');
    assert.equal(scenario.status, 'STAGING_UNVERIFIED');
    assert.equal(scenario.requiresOperatorAction, true);
  });

  // =========================================================================
  // 9. Stale Inventory & Freshness Policy
  // =========================================================================
  await t.test('9. Stale inventory & freshness policy: distinguishes planning vs activation limits', () => {
    // 25 hours old inventory
    const oldTimestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const stalePayload = {
      version: '1.1',
      captureTimestamp: oldTimestamp,
      captureSource: 'operator-script',
      hostIdentity: { hostname: 'h1', os: 'Linux', arch: 'aarch64' },
      traefik: { instanceId: 't1' },
      providers: { file: { enabled: true, directory: '/dynamic', watch: true } },
      networks: [{ id: 'a1b2c3d4e5f60001', name: 'net1', driver: 'bridge', scope: 'local' }],
      routers: [{ name: 'r1', rule: 'Host(`test.com`)' }]
    };

    const staleIngested = ingestHostInventory(stalePayload);
    assert.equal(staleIngested.isStale, true);
    assert.equal(staleIngested.isFreshForPlanning, false);
    assert.equal(staleIngested.isFreshForActivation, false);
    assert.equal(staleIngested.isActivationAuthorized, false);

    // 10 minutes old inventory: Fresh for planning, but STALE for live activation (<= 60s)
    const tenMinTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const tenMinPayload = { ...stalePayload, captureTimestamp: tenMinTimestamp };
    const tenMinIngested = ingestHostInventory(tenMinPayload);

    assert.equal(tenMinIngested.isFreshForPlanning, true);
    assert.equal(tenMinIngested.isFreshForActivation, false);
    assert.equal(tenMinIngested.isActivationAuthorized, false);
    assert.equal(tenMinIngested.activationBlockReason, 'EXCEEDS_60S_ACTIVATION_FRESHNESS_LIMIT');
  });

  // =========================================================================
  // 10. Incorrect Network Approval
  // =========================================================================
  await t.test('10. Incorrect network approval: mismatched network ID rejected', () => {
    const net = { id: 'a1b2c3d4e5f60001', name: 'test-bridge', driver: 'bridge', scope: 'local' };

    assert.throws(
      () => validateApprovedProxyNetwork(net, { approvedNetworkId: 'ffffffffffff9999' }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNAPPROVED_PROXY_NETWORK'
    );
  });

  // =========================================================================
  // 11. Arbitrary isApproved Flag Bypass Rejection
  // =========================================================================
  await t.test('11. Arbitrary isApproved flag bypass rejection: caller boolean alone cannot authorize', () => {
    const net = { id: 'a1b2c3d4e5f60001', name: 'test-bridge', driver: 'bridge', scope: 'local' };

    // Passing isApproved: true WITHOUT server-configured approved network ID must throw
    assert.throws(
      () => validateApprovedProxyNetwork(net, { isApproved: true }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNAPPROVED_PROXY_NETWORK'
    );

    // Passing isApproved: true with mismatched approvedNetworkId must throw
    assert.throws(
      () => validateApprovedProxyNetwork(net, { isApproved: true, approvedNetworkId: 'mismatched000000000' }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNAPPROVED_PROXY_NETWORK'
    );

    // Only matches when approvedNetworkId matches the exact network ID
    const valid = validateApprovedProxyNetwork(net, {
      approvedNetworkId: 'a1b2c3d4e5f60001',
      requireTraefikMembership: false
    });
    assert.equal(valid.valid, true);
    assert.equal(valid.networkId, 'a1b2c3d4e5f60001');
  });

  // =========================================================================
  // 12. API URL Restrictions & SSRF Hardening
  // =========================================================================
  await t.test('12. API URL restrictions & SSRF protection: rejects broad suffixes, remote IPs, credentials', () => {
    // Rejects broad .internal and .local suffixes
    assert.throws(
      () => validateTrustedInternalApiUrl('http://traefik.internal:8080'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'UNAUTHORIZED_API_TARGET'
    );
    assert.throws(
      () => validateTrustedInternalApiUrl('http://service.local:8080'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'UNAUTHORIZED_API_TARGET'
    );

    // Rejects AWS / Cloud metadata addresses
    assert.throws(
      () => validateTrustedInternalApiUrl('http://169.254.169.254/latest/meta-data'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'UNAUTHORIZED_API_TARGET'
    );

    // Rejects embedded credentials
    assert.throws(
      () => validateTrustedInternalApiUrl('http://admin:secretpass@127.0.0.1:8080'),
      (err) => err instanceof TraefikReadOnlyAdapterError && err.code === 'CREDENTIALS_PROHIBITED'
    );

    // Rejects invalid ports
    assert.throws(
      () => validateTrustedInternalApiUrl('http://127.0.0.1:99999'),
      (err) => err instanceof TraefikReadOnlyAdapterError && (err.code === 'INVALID_PORT' || err.code === 'MALFORMED_API_URL')
    );

    // Valid loopback passes
    const valid = validateTrustedInternalApiUrl('http://127.0.0.1:8080/api');
    assert.equal(valid.hostname, '127.0.0.1');
  });

  // =========================================================================
  // 13. Output Redaction
  // =========================================================================
  await t.test('13. Output redaction: sanitizes hostnames and container IPs while preserving rules', () => {
    const readyFixturePath = path.join(FIXTURES_DIR, 'inventory-ready.json');
    const ingested = ingestHostInventory(fs.readFileSync(readyFixturePath, 'utf8'));

    const redacted = redactInventoryForReview(ingested);
    assert.equal(redacted.isRedacted, true);
    assert.equal(redacted.hostIdentity.hostname, '[REDACTED-HOST]');
    assert.ok(redacted.networks[0].containers[0].ipv4Address.startsWith('172.28.x.x'));
    assert.ok(redacted.redactedFields.includes('hostIdentity.hostname'));
    assert.ok(redacted.redactedFields.includes('networks[].containers[].ipv4Address'));

    // Router domain rules are preserved by default for conflict checks
    assert.equal(redacted.routers[0].rule, 'Host(`dokploy.example.com`)');
    assert.ok(redacted.sharingGuidance.safetySummary.includes('masked'));
  });

  // =========================================================================
  // 14. Valid Offline Readiness Report (Ready Scenario)
  // =========================================================================
  await t.test('14. Valid offline readiness report: ready fixture produces STAGING_READY_FOR_AUTHORIZED_TEST', async () => {
    const report = await runStagingPreflightHarness({
      inventoryPath: path.join(FIXTURES_DIR, 'inventory-ready.json'),
      targetDomain: 'myapp.kpanel.dev',
      applicationId: 'demo-app-001',
      allowStale: true
    });

    assert.equal(report.readiness.decision, STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST);
    assert.equal(report.readiness.isReadyForAuthorizedTest, true);
    assert.equal(report.scenario.scenario, 'SCENARIO_A');
    assert.equal(report.executed, false);
    assert.equal(report.dryRun, true);
    assert.equal(report.isSynthetic, true);
    assert.equal(report.readiness.summary.failedChecks, 0);
  });

  // =========================================================================
  // 15. Blocked Offline Readiness Reports (Network & Foreign Conflict)
  // =========================================================================
  await t.test('15. Blocked offline readiness reports: verifies blocked network and route collision', async () => {
    // Blocked network (Scenario D)
    const netReport = await runStagingPreflightHarness({
      inventoryPath: path.join(FIXTURES_DIR, 'inventory-blocked-network.json'),
      targetDomain: 'myapp.kpanel.dev',
      allowStale: true
    });
    assert.equal(netReport.readiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_NETWORK);
    assert.equal(netReport.readiness.isReadyForAuthorizedTest, false);
    assert.equal(netReport.scenario.scenario, 'SCENARIO_D');

    // Route conflict on target domain
    const conflictReport = await runStagingPreflightHarness({
      inventoryPath: path.join(FIXTURES_DIR, 'inventory-blocked-conflict.json'),
      targetDomain: 'api.target-app.com', // Collides with existing dokploy-production-app
      allowStale: true
    });
    assert.equal(conflictReport.readiness.decision, STAGING_DECISIONS.STAGING_BLOCKED_FOREIGN_ROUTE);
    assert.equal(conflictReport.readiness.isReadyForAuthorizedTest, false);
    assert.ok(conflictReport.readiness.blockers.some((b) => b.code === 'NO_FOREIGN_ROUTE_CONFLICT'));
  });

  // =========================================================================
  // 16. Production Safety Invariants & Zero Live Mutations
  // =========================================================================
  await t.test('16. Production safety invariants: zero mutations, zero network attachments, zero route writes', async () => {
    const report = await runStagingPreflightHarness({
      inventoryPath: path.join(FIXTURES_DIR, 'inventory-ready.json'),
      allowStale: true
    });

    assert.equal(report.safetyInvariantsVerified.zeroContainerCreation, true);
    assert.equal(report.safetyInvariantsVerified.zeroNetworkMutations, true);
    assert.equal(report.safetyInvariantsVerified.zeroRouteWrites, true);
    assert.equal(report.safetyInvariantsVerified.zeroBuildKitExecution, true);
    assert.equal(report.safetyInvariantsVerified.zeroProductionSideEffects, true);
    assert.equal(report.executed, false);
  });

});
