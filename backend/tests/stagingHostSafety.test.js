const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

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

    // Strict prohibition of docker exec (Phase 4C3D2 safety correction)
    assert.ok(!executableLines.includes('docker exec'), 'Script must NEVER execute docker exec');

    // Strict prohibition of raw command arrays exported to JSON
    assert.ok(!executableLines.includes('"rawCmd"'), 'Script must NEVER export raw command arrays');
    assert.ok(!executableLines.includes('"cmd":'), 'Script must NEVER export raw command arrays');

    // Traefik API probe must be opt-in and disabled by default
    assert.ok(executableLines.includes('ENABLE_API_PROBE=false'), 'API probing must be disabled by default');

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

  // =========================================================================
  // Mock Environment Helper for Phase 4C3D2 Disposable Offline Tests
  // =========================================================================
  function setupMockEnvironment(scenarioConfig = {}) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-mock-env-'));
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true, mode: 0o700 });

    const scenarioFile = path.join(tmpDir, 'scenario.json');
    fs.writeFileSync(scenarioFile, JSON.stringify(scenarioConfig), { mode: 0o600 });

    const dockerLogFile = path.join(tmpDir, 'docker.log');
    fs.writeFileSync(dockerLogFile, '', { mode: 0o600 });

    const dockerScript = `#!/usr/bin/env node
const fs = require('fs');
const scenario = JSON.parse(fs.readFileSync(process.env.MOCK_SCENARIO_FILE, 'utf8'));
const args = process.argv.slice(2);

fs.appendFileSync(process.env.MOCK_DOCKER_LOG, args.join(' ') + '\\n');

if (args[0] === 'exec') {
  console.error('FATAL: docker exec is strictly forbidden!');
  process.exit(127);
}

if (scenario.dockerStatus === 'permission_denied') {
  if (args[0] === 'info' || args[0] === 'version') {
    console.error('ERROR: Got permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock');
    process.exit(1);
  }
}

if (scenario.dockerStatus === 'not-installed') {
  console.error('docker: command not found');
  process.exit(127);
}

if (args[0] === 'info') {
  console.log('Client: Docker Engine\\nServer: Docker Engine - Community\\nOperating System: Ubuntu 22.04 LTS\\nArchitecture: aarch64');
  process.exit(0);
}

if (args[0] === 'version') {
  if (args.includes('{{.Client.Version}}')) {
    console.log('24.0.7');
    process.exit(0);
  }
  if (args.includes('{{.Server.Version}}')) {
    console.log('24.0.7');
    process.exit(0);
  }
  console.log('Docker version 24.0.7, build afdd53b');
  process.exit(0);
}

if (args[0] === 'network' && args[1] === 'ls') {
  if (scenario.networks && scenario.networks.length > 0) {
    console.log(scenario.networks.map(n => n.id || n.Id).join('\\n'));
  }
  process.exit(0);
}

if (args[0] === 'network' && args[1] === 'inspect') {
  if (!scenario.networks || scenario.networks.length === 0) {
    process.exit(0);
  }
  for (const net of scenario.networks) {
    const containersFormatted = (net.containers || []).map(c =>
      JSON.stringify({
        id: (c.id || '').slice(0, 12),
        name: c.name || '',
        ipv4Address: c.ipv4Address || ''
      }, null, 2)
    ).join(',\\n');

    console.log(\`{
  "id": "\${net.id}",
  "name": "\${net.name}",
  "driver": "\${net.driver || 'bridge'}",
  "scope": "\${net.scope || 'local'}",
  "internal": \${Boolean(net.internal)},
  "attachable": \${Boolean(net.attachable)},
  "containers": [
\${containersFormatted}
  ]
},\`);
  }
  process.exit(0);
}

if (args[0] === 'ps') {
  const candidates = scenario.traefikCandidates || [];
  for (const c of candidates) {
    console.log(\`\${c.id}|\${c.name}|\${c.image}|\${c.status}\`);
  }
  process.exit(0);
}

if (args[0] === 'inspect') {
  const formatIdx = args.indexOf('--format');
  const format = formatIdx !== -1 ? args[formatIdx + 1] : '';

  if (format.includes('Config.Cmd')) {
    console.log(JSON.stringify(scenario.traefikCmd || []));
    process.exit(0);
  }

  if (format.includes('Mounts')) {
    const mounts = scenario.traefikMounts || [];
    console.log(JSON.stringify(mounts.map(m => ({
      Type: m.type || m.Type || 'bind',
      Source: m.source || m.Source || '',
      Destination: m.destination || m.Destination || '',
      Mode: m.mode || m.Mode || '',
      RW: m.rw !== false
    }))));
    process.exit(0);
  }

  if (format.includes('org.opencontainers.image.version')) {
    console.log(scenario.ociVersion || '<no value>');
    process.exit(0);
  }

  console.log('{}');
  process.exit(0);
}

process.exit(0);
`;

    const dockerPath = path.join(binDir, 'docker');
    fs.writeFileSync(dockerPath, dockerScript, { mode: 0o755 });

    const curlScript = `#!/usr/bin/env node
const fs = require('fs');
const scenario = JSON.parse(fs.readFileSync(process.env.MOCK_SCENARIO_FILE, 'utf8'));
const args = process.argv.slice(2);

if (scenario.apiAccessible) {
  if (args.includes('-w') && args.includes('%{http_code}')) {
    process.stdout.write('200');
    process.exit(0);
  }
  if (args.some(a => a.includes('/api/http/routers'))) {
    console.log(JSON.stringify(scenario.apiRouters || [{ rule: 'Host(\`app.test\`)', service: 'app-svc' }]));
    process.exit(0);
  }
  if (args.some(a => a.includes('/api/http/services'))) {
    console.log(JSON.stringify(scenario.apiServices || []));
    process.exit(0);
  }
  if (args.some(a => a.includes('/api/entrypoints'))) {
    console.log(JSON.stringify(scenario.apiEntrypoints || []));
    process.exit(0);
  }
} else {
  if (args.includes('-w') && args.includes('%{http_code}')) {
    process.stdout.write('000');
    process.exit(0);
  }
  process.exit(7);
}
`;
    const curlPath = path.join(binDir, 'curl');
    fs.writeFileSync(curlPath, curlScript, { mode: 0o755 });

    return {
      tmpDir,
      binDir,
      dockerLogFile,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        MOCK_SCENARIO_FILE: scenarioFile,
        MOCK_DOCKER_LOG: dockerLogFile
      },
      cleanup: () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {}
      }
    };
  }

  // =========================================================================
  // 17. Mock Collector: One Traefik Instance (Scenario A)
  // =========================================================================
  await t.test('17. Mock collector end-to-end: one Traefik instance', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 4 days' }
      ],
      traefikCmd: [
        '--providers.file.directory=/etc/traefik/dynamic',
        '--providers.file.watch=true'
      ],
      traefikMounts: [
        { type: 'bind', source: '/var/lib/kpanel/proxy/dynamic', destination: '/etc/traefik/dynamic', mode: 'rw', rw: true }
      ],
      networks: [
        {
          id: 'a1b2c3d4e5f60001',
          name: 'kpanel-proxy-net',
          driver: 'bridge',
          scope: 'local',
          containers: [{ id: 't00112233445', name: 'traefik', ipv4Address: '172.28.0.2/16' }]
        }
      ]
    });

    try {
      const outFile = path.join(mock.tmpDir, 'inventory.json');
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH, '-o', outFile], { env: mock.env, encoding: 'utf8' });

      assert.ok(fs.existsSync(outFile), 'Output file must be written');
      const stat = fs.statSync(outFile);
      assert.equal(stat.mode & 0o777, 0o600, 'Output file must have 0600 permissions');

      const rawJson = fs.readFileSync(outFile, 'utf8');
      const ingested = ingestHostInventory(rawJson);
      assert.equal(ingested.valid, true);
      assert.equal(ingested.traefik.instanceId, 't00112233445');
      assert.equal(ingested.traefik.version, 'v3.1.2');
      assert.equal(ingested.traefik.instancesDetected, 1);
      assert.equal(ingested.providers.file.enabled, true);
      assert.equal(ingested.providers.file.directory, '/etc/traefik/dynamic');
      assert.equal(ingested.providers.file.hostPath, '/var/lib/kpanel/proxy/dynamic');

      // Verify NO docker exec was called
      const dockerLog = fs.readFileSync(mock.dockerLogFile, 'utf8');
      assert.ok(!dockerLog.includes('exec'), 'docker exec must NEVER be called');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 18. Mock Collector: Multiple Traefik Instances
  // =========================================================================
  await t.test('18. Mock collector end-to-end: multiple Traefik instances', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik-primary', image: 'traefik:v3.1.2', status: 'Up 4 days' },
        { id: 't99887766554', name: 'traefik-secondary', image: 'traefik:v2.10', status: 'Up 1 day' }
      ],
      networks: []
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      assert.equal(ingested.valid, true);
      assert.equal(ingested.traefik.instancesDetected, 2);
      assert.equal(ingested.traefik.status, 'multiple-instances-detected');
      assert.ok(ingested.missingOrUnverifiable.includes('MULTIPLE_PROXIES_DETECTED'));

      const scenario = classifyHostIntegrationScenario(ingested);
      assert.equal(scenario.scenario, 'SCENARIO_C');
      assert.equal(scenario.decision, 'MULTIPLE_PROXIES_DETECTED');
      assert.equal(scenario.status, 'STAGING_UNVERIFIED');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 19. Mock Collector: No Traefik
  // =========================================================================
  await t.test('19. Mock collector end-to-end: no Traefik found', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [],
      networks: []
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      assert.equal(ingested.valid, true);
      assert.equal(ingested.traefik.instanceId, null);
      assert.equal(ingested.traefik.status, 'not-found');

      const scenario = classifyHostIntegrationScenario(ingested);
      assert.equal(scenario.scenario, 'SCENARIO_C');
      assert.equal(scenario.decision, 'TRAEFIK_NOT_FOUND');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 20. Mock Collector: Docker Permission Denied
  // =========================================================================
  await t.test('20. Mock collector end-to-end: docker permission denied', () => {
    const mock = setupMockEnvironment({
      dockerStatus: 'permission_denied'
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      assert.equal(ingested.valid, true);
      assert.equal(ingested.hostIdentity.dockerStatus, 'permission_denied');

      const scenario = classifyHostIntegrationScenario(ingested);
      assert.equal(scenario.scenario, 'SCENARIO_C');
      assert.equal(scenario.status, 'STAGING_UNVERIFIED');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 21. Mock Collector: Missing File Provider (Scenario B)
  // =========================================================================
  await t.test('21. Mock collector end-to-end: missing File provider (Scenario B)', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }
      ],
      traefikCmd: ['--providers.docker=true'],
      traefikMounts: [],
      networks: [{ id: 'a1b2c3d4e5f60001', name: 'net1', driver: 'bridge', scope: 'local' }]
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      assert.equal(ingested.providers.file.enabled, false);

      const scenario = classifyHostIntegrationScenario(ingested);
      assert.equal(scenario.scenario, 'SCENARIO_B');
      assert.equal(scenario.decision, 'FILE_PROVIDER_NOT_CONFIGURED');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 22. Mock Collector: Dedicated File Provider (Scenario A)
  // =========================================================================
  await t.test('22. Mock collector end-to-end: dedicated File provider (Scenario A)', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }
      ],
      traefikCmd: [
        '--providers.file.directory=/etc/traefik/dynamic',
        '--providers.file.watch=true'
      ],
      traefikMounts: [
        { type: 'bind', source: '/var/lib/kpanel/proxy/dynamic', destination: '/etc/traefik/dynamic', mode: 'rw', rw: true }
      ],
      networks: [
        {
          id: 'a1b2c3d4e5f60001',
          name: 'kpanel-proxy-net',
          driver: 'bridge',
          scope: 'local',
          containers: [{ id: 't00112233445', name: 'traefik' }]
        }
      ]
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      const scenario = classifyHostIntegrationScenario(ingested, { approvedNetworkId: 'a1b2c3d4e5f60001' });

      assert.equal(scenario.scenario, 'SCENARIO_A');
      assert.equal(scenario.decision, 'DEDICATED_FILE_PROVIDER_AVAILABLE');
      assert.equal(scenario.status, 'COMPATIBLE_TOPOLOGY');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 23. Mock Collector: Foreign Dokploy Network & ID Mismatch (Scenario D)
  // =========================================================================
  await t.test('23. Mock collector end-to-end: foreign Dokploy network & ID mismatch (Scenario D)', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }
      ],
      traefikCmd: ['--providers.file.directory=/etc/traefik/dynamic', '--providers.file.watch=true'],
      traefikMounts: [{ source: '/host/dyn', destination: '/etc/traefik/dynamic', rw: true }],
      networks: [
        { id: 'a1b2c3d4e5f60002', name: 'dokploy-network', driver: 'bridge', scope: 'local' }
      ]
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      const scenario = classifyHostIntegrationScenario(ingested, { approvedNetworkId: 'a1b2c3d4e5f60099' });

      assert.equal(scenario.scenario, 'SCENARIO_D');
      assert.equal(scenario.decision, 'NO_APPROVED_PROXY_NETWORK');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 24. Mock Collector: Missing Host Mount Correspondence
  // =========================================================================
  await t.test('24. Mock collector end-to-end: missing host mount correspondence', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [
        { id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }
      ],
      traefikCmd: ['--providers.file.directory=/etc/traefik/dynamic', '--providers.file.watch=true'],
      traefikMounts: [
        { source: '/some/other/path', destination: '/different/dir', rw: true } // Mismatched mount destination!
      ],
      networks: [{ id: 'a1b2c3d4e5f60001', name: 'net1', driver: 'bridge', scope: 'local' }]
    });

    try {
      const stdout = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const ingested = ingestHostInventory(stdout);
      assert.equal(ingested.providers.file.hostPath, null);

      const scenario = classifyHostIntegrationScenario(ingested);
      assert.equal(scenario.scenario, 'SCENARIO_B');
      assert.equal(scenario.decision, 'FILE_PROVIDER_MOUNT_UNKNOWN');
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 25. Mock Collector: Unavailable Internal API and Opt-In Probing
  // =========================================================================
  await t.test('25. Mock collector end-to-end: unavailable internal API and opt-in probing', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [{ id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }],
      apiAccessible: false,
      networks: []
    });

    try {
      // 1. Default run: API probe is disabled/skipped without any HTTP requests
      const stdoutDefault = execFileSync('bash', [INVENTORY_SCRIPT_PATH], { env: mock.env, encoding: 'utf8' });
      const parsedDefault = JSON.parse(stdoutDefault);
      assert.equal(parsedDefault.traefik.apiStatus, 'disabled_or_skipped');
      assert.deepEqual(parsedDefault.routers, []);

      // 2. Opt-in run with --probe-api: queries API, records unavailable safely
      const stdoutOptIn = execFileSync('bash', [INVENTORY_SCRIPT_PATH, '--probe-api', '--api-port', '8080'], { env: mock.env, encoding: 'utf8' });
      const parsedOptIn = JSON.parse(stdoutOptIn);
      assert.equal(parsedOptIn.traefik.apiStatus, 'disabled_or_unreachable');

      // 3. Invalid port rejection
      assert.throws(
        () => execFileSync('bash', [INVENTORY_SCRIPT_PATH, '--probe-api', '--api-port', '99999'], { env: mock.env, encoding: 'utf8' }),
        (err) => err.status !== 0
      );
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 26. Mock Collector: Redacted Review Summary Mode
  // =========================================================================
  await t.test('26. Mock collector end-to-end: redacted review summary mode', () => {
    const mock = setupMockEnvironment({
      traefikCandidates: [{ id: 't00112233445', name: 'traefik', image: 'traefik:v3.1.2', status: 'Up 1 day' }],
      networks: [
        {
          id: 'a1b2c3d4e5f60001',
          name: 'kpanel-net',
          driver: 'bridge',
          scope: 'local',
          containers: [
            { id: 'c1', name: 'dokploy-app', ipv4Address: '172.28.10.5/16' },
            { id: 'c2', name: 'internal-service', ipv4Address: '10.50.0.12/24' }
          ]
        }
      ]
    });

    try {
      const outFile = path.join(mock.tmpDir, 'redacted.json');
      execFileSync('bash', [INVENTORY_SCRIPT_PATH, '--redact', '-o', outFile], { env: mock.env, encoding: 'utf8' });

      assert.ok(fs.existsSync(outFile));
      const rawContent = fs.readFileSync(outFile, 'utf8');
      const parsed = JSON.parse(rawContent);

      assert.equal(parsed.isRedacted, true);
      assert.equal(parsed.hostIdentity.hostname, '[REDACTED-HOST]');
      assert.ok(parsed.sharingSummary);
      assert.equal(parsed.sharingSummary.networkAuthorizationStatus, 'UNVERIFIED_NETWORK_ID_REDACTED');

      // Check IPv4 addresses were sanitized
      const contIps = parsed.networks[0].containers.map(c => c.ipv4Address);
      assert.ok(contIps.some(ip => ip.startsWith('172.28.x.x')));
      assert.ok(contIps.some(ip => ip.startsWith('10.x.x.x')));

      // Ingestion accepts redacted output cleanly
      const ingested = ingestHostInventory(rawContent);
      assert.equal(ingested.valid, true);
      assert.equal(ingested.isRedacted, true);
    } finally {
      mock.cleanup();
    }
  });

  // =========================================================================
  // 27. Network Authorization Hardening: Caller Approval Injection Rejection
  // =========================================================================
  await t.test('27. Network authorization hardening: caller approval injection rejection', () => {
    const net = { id: 'a1b2c3d4e5f60001', name: 'test-bridge', driver: 'bridge', scope: 'local' };

    // 1. Untrusted caller supplying isApproved: true and approvedNetworkId in request body is rejected
    assert.throws(
      () => validateApprovedProxyNetwork(net, {
        untrustedCaller: true,
        isApproved: true,
        approvedNetworkId: 'a1b2c3d4e5f60001'
      }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNTRUSTED_CALLER_AUTHORIZATION'
    );

    // 2. Untrusted caller supplying trustedOperator: true is rejected
    assert.throws(
      () => validateApprovedProxyNetwork(net, {
        untrustedCaller: true,
        trustedOperator: true,
        approvedNetworkId: 'a1b2c3d4e5f60001'
      }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNTRUSTED_CALLER_AUTHORIZATION'
    );

    // 3. Caller supplying trustedOperator without server-side verified session
    assert.throws(
      () => validateApprovedProxyNetwork(net, {
        trustedOperator: true,
        approvedNetworkId: 'a1b2c3d4e5f60001'
      }),
      (err) => err instanceof StagingNetworkError && err.code === 'UNTRUSTED_OPERATOR_BYPASS'
    );

    // 4. Trusted server-side configuration authorizes network
    const serverConfigNet = validateApprovedProxyNetwork(net, {
      trustedServerConfig: { approvedNetworkId: 'a1b2c3d4e5f60001' },
      requireTraefikMembership: false
    });
    assert.equal(serverConfigNet.valid, true);
    assert.equal(serverConfigNet.authorizationSource, 'trusted-server-config');
  });

  // =========================================================================
  // 28. Advanced Address & Path Redaction: IPv4, IPv6, Hostnames, Paths, Credentials
  // =========================================================================
  await t.test('28. Advanced address & path redaction: IPv4, IPv6, hostnames, paths, credentials', () => {
    const rawPayload = {
      version: '1.2',
      captureTimestamp: new Date().toISOString(),
      captureSource: 'operator-script',
      hostIdentity: {
        hostname: 'oracle-prod-vps',
        os: 'Linux',
        arch: 'aarch64'
      },
      traefik: {
        instanceId: 't00112233445',
        mounts: [
          { source: '/home/ubuntu/traefik/dynamic', destination: '/etc/traefik/dynamic', rw: true },
          { source: '/Users/developer/traefik', destination: '/traefik', rw: true }
        ]
      },
      providers: {
        file: {
          enabled: true,
          directory: '/home/ubuntu/traefik/dynamic',
          hostPath: '/home/ubuntu/traefik/dynamic',
          watch: true
        }
      },
      networks: [
        {
          id: 'a1b2c3d4e5f60001',
          name: 'kpanel-net',
          driver: 'bridge',
          scope: 'local',
          containers: [
            { id: 'c1', name: 'app-1', ipv4Address: '10.0.1.25/24' },
            { id: 'c2', name: 'app-2', ipv4Address: '192.168.1.100/24' },
            { id: 'c3', name: 'app-3', ipv4Address: '100.70.0.5/16' },
            { id: 'c4', name: 'app-4', ipv4Address: 'fc00:1234::1' }
          ]
        }
      ],
      routers: [
        { name: 'r1', rule: 'Host(`internal.example.com`) && Query(`token=supersecret123`)' }
      ]
    };

    const ingested = ingestHostInventory(rawPayload);
    const redacted = redactInventoryForReview(ingested, {
      redactDomains: true,
      redactContainerNames: true,
      redactNetworkIds: true
    });

    assert.equal(redacted.hostIdentity.hostname, '[REDACTED-HOST]');
    assert.equal(redacted.traefik.mounts[0].source, '/home/[REDACTED-USER]/traefik/dynamic');
    assert.equal(redacted.traefik.mounts[1].source, '/Users/[REDACTED-USER]/traefik');
    assert.equal(redacted.providers.file.hostPath, '/home/[REDACTED-USER]/traefik/dynamic');

    const containers = redacted.networks[0].containers;
    assert.ok(containers[0].ipv4Address.startsWith('10.x.x.x'));
    assert.ok(containers[1].ipv4Address.startsWith('192.168.x.x'));
    assert.ok(containers[2].ipv4Address.startsWith('100.70.x.x'));
    assert.ok(containers[3].ipv4Address.includes('[REDACTED-IPV6-ULA]'));
    assert.ok(containers[0].name.startsWith('[REDACTED-CONTAINER-'));

    assert.ok(redacted.routers[0].rule.includes('[REDACTED-DOMAIN-'));
    assert.ok(redacted.routers[0].rule.includes('token=[REDACTED]'));

    assert.equal(redacted.networkAuthorizationStatus, 'UNVERIFIED_NETWORK_ID_REDACTED');
    assert.ok(redacted.sharingGuidance.sharingDisclaimer.includes('Automated redaction'));
  });

  // =========================================================================
  // 29. Comprehensive Inventory Interpretation: All 10 States Distinguished
  // =========================================================================
  await t.test('29. Comprehensive inventory interpretation: all 10 states distinguished', () => {
    // 1. File provider verified present (Scenario A)
    const baseReady = {
      valid: true,
      traefik: { instanceId: 't1', instancesDetected: 1, status: 'running' },
      providers: { file: { enabled: true, directory: '/dyn', hostPath: '/host/dyn', watch: true } },
      networks: [{ id: 'a1b2c3d4e5f60001', name: 'proxy-net', driver: 'bridge', scope: 'local' }]
    };
    const s1 = classifyHostIntegrationScenario(baseReady, { approvedNetworkId: 'a1b2c3d4e5f60001' });
    assert.equal(s1.decision, 'DEDICATED_FILE_PROVIDER_AVAILABLE');

    // 2. File provider verified absent (Scenario B)
    const s2 = classifyHostIntegrationScenario({ ...baseReady, providers: { file: { enabled: false } } });
    assert.equal(s2.decision, 'FILE_PROVIDER_NOT_CONFIGURED');

    // 3. File provider configuration unknown (Scenario B)
    const s3 = classifyHostIntegrationScenario({ ...baseReady, providers: { file: { enabled: true, directory: null, filename: null } } });
    assert.equal(s3.decision, 'FILE_PROVIDER_CONFIG_UNKNOWN');

    // 4. Traefik instance not found (Scenario C)
    const s4 = classifyHostIntegrationScenario({ ...baseReady, traefik: { instanceId: null, status: 'not-found' } });
    assert.equal(s4.decision, 'TRAEFIK_NOT_FOUND');

    // 5. Multiple unresolved proxy instances (Scenario C)
    const s5 = classifyHostIntegrationScenario({ ...baseReady, traefik: { instanceId: 't1', instancesDetected: 2 } });
    assert.equal(s5.decision, 'MULTIPLE_PROXIES_DETECTED');

    // 6. Provider present but directory mount unknown (Scenario B)
    const s6 = classifyHostIntegrationScenario({ ...baseReady, providers: { file: { enabled: true, directory: '/dyn', hostPath: null, watch: true } } });
    assert.equal(s6.decision, 'FILE_PROVIDER_MOUNT_UNKNOWN');

    // 7. Network approved by trusted configuration
    const s7 = classifyHostIntegrationScenario(baseReady, { approvedNetworkId: 'a1b2c3d4e5f60001' });
    assert.equal(s7.scenario, 'SCENARIO_A');

    // 8. Network ID present but not authorized (Scenario D)
    const s8 = classifyHostIntegrationScenario(baseReady, { approvedNetworkId: 'ffffffffffff0001' });
    assert.equal(s8.decision, 'NO_APPROVED_PROXY_NETWORK');
  });

  // =========================================================================
  // 30. Incomplete Inventory Blocks Readiness & Strict 60s Activation Limit
  // =========================================================================
  await t.test('30. Incomplete inventory blocks readiness & strict 60s activation limit', async () => {
    // 1. Incomplete inventory (missing routers) blocks readiness
    const incompletePayload = {
      version: '1.2',
      captureTimestamp: new Date().toISOString(),
      captureSource: 'operator-script',
      hostIdentity: { hostname: 'h1', os: 'Linux', arch: 'aarch64' },
      traefik: { instanceId: 't1', instancesDetected: 1 },
      providers: { file: { enabled: true, directory: '/dyn', hostPath: '/h/dyn', watch: true } },
      networks: [{ id: 'a1b2c3d4e5f60001', name: 'net1', driver: 'bridge', scope: 'local' }],
      routers: [] // EMPTY ROUTERS!
    };

    const ingestedIncomplete = ingestHostInventory(incompletePayload);
    assert.equal(ingestedIncomplete.isComplete, false);
    assert.ok(ingestedIncomplete.missingOrUnverifiable.includes('ROUTER_INVENTORY_EMPTY'));

    const readinessIncomplete = await assessStagingReadiness({
      applicationId: 'app-1',
      targetDomain: 'app.kpanel.dev',
      candidate: { containerId: 'c001122334455', imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff', healthStatus: 'healthy', isAuthorized: true },
      inventory: ingestedIncomplete
    }, {
      approvedProxyNetworkId: 'a1b2c3d4e5f60001',
      operatorApproved: true,
      operatorApprovedNetwork: true,
      offlineDryRun: true
    });

    assert.equal(readinessIncomplete.isReadyForAuthorizedTest, false);
    assert.notEqual(readinessIncomplete.decision, STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST);

    // 2. Snapshot age > 60s strictly blocks live activation
    const seventySecOld = new Date(Date.now() - 70 * 1000).toISOString();
    const activationPayload = {
      ...incompletePayload,
      captureTimestamp: seventySecOld,
      routers: [{ name: 'r1', rule: 'Host(`other.com`)' }]
    };

    const ingestedActivation = ingestHostInventory(activationPayload, { purpose: 'activation' });
    assert.equal(ingestedActivation.isFreshForActivation, false);
    assert.equal(ingestedActivation.isActivationAuthorized, false);

    const readinessActivation = await assessStagingReadiness({
      applicationId: 'app-1',
      targetDomain: 'app.kpanel.dev',
      candidate: { containerId: 'c001122334455', imageId: 'sha256:1111222233334444555566667777888899990000aaaabbbbccccddddeeeeffff', healthStatus: 'healthy', isAuthorized: true },
      inventory: ingestedActivation
    }, {
      purpose: 'activation',
      approvedProxyNetworkId: 'a1b2c3d4e5f60001',
      operatorApproved: true,
      operatorApprovedNetwork: true,
      offlineDryRun: true
    });

    assert.equal(readinessActivation.decision, STAGING_DECISIONS.STAGING_BLOCKED_STALE_INVENTORY);
    assert.equal(readinessActivation.isReadyForAuthorizedTest, false);
  });

});
