const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const stagingStrategyService = require('../services/stagingStrategyService');
const {
  STRATEGIES,
  PROHIBITED_HOST_PORTS,
  PROTECTED_EXISTING_WORKLOADS,
  PROTECTED_COMPOSE_PROJECTS,
  validateLoopbackPort,
  validateStagingNamespace,
  planIsolatedStagingIngress,
  assessHostTopologyForStaging,
  generateOfflineStagingComposeSpec,
  StagingStrategyError
} = stagingStrategyService;

const dockerSecurityService = require('../services/dockerSecurityService');
const {
  PRIVILEGE_TIERS,
  ENDPOINT_PERMISSIONS,
  auditSocketMountSecurity,
  evaluateSocketProxyEffectiveness,
  evaluateMultiTenantBlastRadius
} = dockerSecurityService;

const resourceBudgetService = require('../services/resourceBudgetService');
const {
  OBSERVED_HOST_CAPACITY,
  DEFAULT_RESOURCE_BUDGET,
  validateCandidateResourceBudget,
  evaluateDiskHeadroom,
  enforceBuildConcurrency,
  validatePruneCommandSafety,
  ResourceBudgetError
} = resourceBudgetService;

const stagingNetworkService = require('../services/stagingNetworkService');
const { validateApprovedProxyNetwork, StagingNetworkError } = stagingNetworkService;

const stagingReadinessService = require('../services/stagingReadinessService');
const { assessStagingReadiness, STAGING_DECISIONS } = stagingReadinessService;

const hostInventoryService = require('../services/hostInventoryService');
const { ingestHostInventory } = hostInventoryService;

const runtimeService = require('../services/runtimeService');
const { RuntimeServiceError } = runtimeService;

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'oracle-vps-topology.json');

test('Phase 4C3D3: Oracle VPS Architecture Adaptation & Isolated Staging Verification', async (t) => {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'Oracle VPS topology fixture must exist');
  const rawFixture = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const ingestedInventory = ingestHostInventory(rawFixture, { synthetic: true });

  // =========================================================================
  // 1. Shared Dokploy Routing Strategy Blocked
  // =========================================================================
  await t.test('1. Shared Dokploy routing strategy is strictly blocked/deferred', () => {
    const assessment = assessHostTopologyForStaging(rawFixture);
    const prodStrategy = assessment.strategies[STRATEGIES.SHARED_TRAEFIK_PRODUCTION];

    assert.equal(prodStrategy.status, 'BLOCKED_UNVERIFIED');
    assert.equal(prodStrategy.decision, 'INTEGRATION_DEFERRED');
    assert.ok(prodStrategy.reasons.length >= 3, 'Must provide detailed block reasons');
    assert.ok(
      prodStrategy.reasons.some((r) => r.includes('Dokploy-managed Traefik') || r.includes('ports 80/443')),
      'Must cite Dokploy Traefik port 80/443 ownership'
    );
    assert.ok(
      prodStrategy.reasons.some((r) => r.includes('File provider dynamic configuration')),
      'Must cite Dokploy ownership of Traefik dynamic configuration'
    );

    // Staging readiness service also fails closed on unverified multi-proxy / Dokploy setup
    const readiness = assessStagingReadiness(rawFixture, {
      applicationId: 'app-oracle-test',
      targetDomain: 'app.example.com',
      purpose: 'planning'
    });
    return readiness.then((report) => {
      assert.notEqual(report.decision, STAGING_DECISIONS.STAGING_READY_FOR_AUTHORIZED_TEST);
      assert.equal(report.isReadyForAuthorizedTest, false);
    });
  });

  // =========================================================================
  // 2. Dokploy Overlay Network is Not Adopted
  // =========================================================================
  await t.test('2. Dokploy overlay network (dokploy-network) is strictly rejected', () => {
    const dokployNet = rawFixture.networks.find((n) => n.name === 'dokploy-network');
    assert.ok(dokployNet, 'Dokploy network must be present in fixture');
    assert.equal(dokployNet.driver, 'overlay', 'Dokploy network uses Swarm overlay');

    // Planning attachment to dokploy-network throws error
    assert.throws(
      () => {
        planIsolatedStagingIngress({
          applicationId: '00000000-0000-4000-8000-000000000001',
          deploymentId: '00000000-0000-4000-8000-000000000002',
          candidateContainerId: 'cand-001',
          stagingNetworkId: 'dokploy-network',
          loopbackPort: 18080
        });
      },
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'FORBIDDEN_STAGING_NETWORK');
        return true;
      }
    );

    // Staging network service validation also rejects dokploy-network
    assert.throws(
      () => {
        validateApprovedProxyNetwork(dokployNet, {
          approvedNetworkId: dokployNet.id,
          trustedServerConfig: { approvedNetworkId: dokployNet.id }
        });
      },
      (err) => {
        assert.ok(err instanceof StagingNetworkError);
        assert.ok(
          err.code === 'FOREIGN_NETWORK_FORBIDDEN' || err.code === 'FORBIDDEN_NETWORK_SCOPE',
          `Expected foreign network or forbidden scope error, got: ${err.code}`
        );
        return true;
      }
    );
  });

  // =========================================================================
  // 3. Existing Proxy Containers Preserved
  // =========================================================================
  await t.test('3. Existing proxy containers (Dokploy Traefik, Caddy, Nginx) are preserved and protected', () => {
    const assessment = assessHostTopologyForStaging(rawFixture);
    const blastRadius = evaluateMultiTenantBlastRadius();

    assert.equal(rawFixture.totalContainersCount, 45, 'Fixture represents 45 running containers');
    assert.ok(blastRadius.criticalNeighbors.some((n) => n.includes('Dokploy')), 'Dokploy identified as critical neighbor');
    assert.ok(blastRadius.criticalNeighbors.some((n) => n.includes('Traefik')), 'Traefik identified as critical neighbor');
    assert.ok(blastRadius.criticalNeighbors.some((n) => n.includes('Caddy')), 'Caddy identified as critical neighbor');
    assert.ok(blastRadius.criticalNeighbors.some((n) => n.includes('n8n')), 'n8n identified as critical neighbor');

    // Label fencing invariant: K-Panel must only touch io.kpanel.managed=true containers
    assert.ok(
      blastRadius.requiredProtections.some((p) => p.includes('io.kpanel.managed=true')),
      'Must enforce strict label fencing to preserve neighbor containers'
    );
  });

  // =========================================================================
  // 4. Old K-Panel Containers Not Reused
  // =========================================================================
  await t.test('4. Old K-Panel containers (kpanel-frontend-1, kpanel-backend-1) are preserved and never reused', () => {
    // Check collision prevention in namespace validator
    assert.throws(
      () => {
        validateStagingNamespace('kpanel-staging', {
          candidateName: 'kpanel-frontend-1'
        });
      },
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'CONTAINER_NAME_COLLISION');
        return true;
      }
    );

    assert.throws(
      () => {
        validateStagingNamespace('kpanel-staging', {
          candidateName: 'kpanel-backend-1'
        });
      },
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'CONTAINER_NAME_COLLISION');
        return true;
      }
    );

    // Compose project collisions
    assert.throws(
      () => validateStagingNamespace('kpanel-clean'),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PROJECT_NAME_COLLISION');
        return true;
      }
    );

    assert.throws(
      () => validateStagingNamespace('kpanel'),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PROJECT_NAME_COLLISION');
        return true;
      }
    );
  });

  // =========================================================================
  // 5. Missing Staging Network Blocks Actual Execution
  // =========================================================================
  await t.test('5. Missing approved staging network blocks execution', () => {
    const assessment = assessHostTopologyForStaging(rawFixture);
    const isolatedStatus = assessment.strategies[STRATEGIES.ISOLATED_LOOPBACK_STAGING];

    assert.equal(isolatedStatus.status, 'FEASIBLE_PENDING_PREREQUISITES');
    const netBlocker = isolatedStatus.blockers.find((b) => b.code === 'MISSING_STAGING_NETWORK');
    assert.ok(netBlocker, 'Must identify MISSING_STAGING_NETWORK blocker');
    assert.ok(netBlocker.message.includes('No approved dedicated K-Panel staging bridge network'));
  });

  // =========================================================================
  // 6. Proposed Isolated Staging Architecture is Generated Safely
  // =========================================================================
  await t.test('6. Proposed isolated staging architecture specification is generated safely', () => {
    const spec = generateOfflineStagingComposeSpec({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    assert.ok(spec.composeObject, 'Compose object must be generated');
    assert.ok(spec.composeYaml, 'Compose YAML must be generated');
    assert.equal(spec.summary.projectName, 'kpanel-staging');
    assert.equal(spec.summary.isOfflineDryRun, true);
    assert.equal(spec.summary.executed, false);

    // Confirm YAML structure
    assert.ok(spec.composeYaml.includes('name: kpanel-staging'));
    assert.ok(spec.composeYaml.includes('kpanel-staging-candidate-66666666'));
    assert.ok(spec.composeYaml.includes('kpanel-staging-ingress-66666666'));
    assert.ok(spec.composeYaml.includes('external: true'));
  });

  // =========================================================================
  // 7. App Candidates Have No Published Ports
  // =========================================================================
  await t.test('7. App candidates have zero published host ports', () => {
    const spec = generateOfflineStagingComposeSpec({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    const candidateService = spec.composeObject.services.candidate;
    assert.deepEqual(candidateService.ports, [], 'Candidate ports array must be empty');
    assert.deepEqual(candidateService.expose, ['3000'], 'Candidate must only expose internal port');

    // Confirm in YAML
    assert.ok(spec.composeYaml.includes('ports: []'), 'YAML must specify empty ports list for candidate');
  });

  // =========================================================================
  // 8. Only Staging Ingress May Publish Loopback Ports
  // =========================================================================
  await t.test('8. Only staging ingress publishes loopback port, bound exclusively to 127.0.0.1', () => {
    const spec = generateOfflineStagingComposeSpec({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    const ingressService = spec.composeObject.services['staging-ingress'];
    assert.ok(ingressService.ports.length === 1);
    assert.equal(ingressService.ports[0], '127.0.0.1:18080:80');

    // Wildcard binding rejection test
    assert.throws(
      () => validateLoopbackPort(18080, { hostIp: '0.0.0.0' }),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'NON_LOOPBACK_BINDING_PROHIBITED');
        return true;
      }
    );

    assert.throws(
      () => validateLoopbackPort(18080, { hostIp: '::' }),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'NON_LOOPBACK_BINDING_PROHIBITED');
        return true;
      }
    );
  });

  // =========================================================================
  // 9. Caller Cannot Choose Privileged or Occupied Port
  // =========================================================================
  await t.test('9. Privileged (<1024) and occupied ports are strictly rejected', () => {
    // Privileged port 80
    assert.throws(
      () => validateLoopbackPort(80),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PRIVILEGED_PORT_PROHIBITED');
        return true;
      }
    );

    // Privileged port 443
    assert.throws(
      () => validateLoopbackPort(443),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PRIVILEGED_PORT_PROHIBITED');
        return true;
      }
    );

    // Reserved service port 5001 (old kpanel backend)
    assert.throws(
      () => validateLoopbackPort(5001),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PROHIBITED_HOST_PORT');
        return true;
      }
    );

    // Reserved service port 5678 (n8n)
    assert.throws(
      () => validateLoopbackPort(5678),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PROHIBITED_HOST_PORT');
        return true;
      }
    );

    // Dynamically occupied port
    assert.throws(
      () => validateLoopbackPort(18080, { occupiedPorts: [18080] }),
      (err) => {
        assert.ok(err instanceof StagingStrategyError);
        assert.equal(err.code, 'PORT_ALREADY_OCCUPIED');
        return true;
      }
    );
  });

  // =========================================================================
  // 10. No Production Route Modifications
  // =========================================================================
  await t.test('10. Production route configurations and Traefik files remain untouched', () => {
    const plan = planIsolatedStagingIngress({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    assert.equal(plan.accessModel.productionTraefikModified, false);
    assert.equal(plan.productionIsolation.dokployTraefikUntouched, true);
    assert.equal(plan.productionIsolation.cloudflareTunnelUntouched, true);
    assert.equal(plan.productionIsolation.productionPortsUntouched, true);
  });

  // =========================================================================
  // 11. No Public TLS or DNS Operations
  // =========================================================================
  await t.test('11. No public domain, DNS, or TLS operations required; SSH tunnel access provided', () => {
    const plan = planIsolatedStagingIngress({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    assert.equal(plan.accessModel.publicDnsRequired, false);
    assert.equal(plan.accessModel.publicTlsRequired, false);
    assert.ok(plan.accessModel.sshTunnelCommand.includes('ssh -N -L 18080:127.0.0.1:18080'));
    assert.equal(plan.accessModel.targetUrl, 'http://127.0.0.1:18080');
  });

  // =========================================================================
  // 12. No Automatic Image Builds
  // =========================================================================
  await t.test('12. Staging planning does not trigger automatic image builds', () => {
    const spec = generateOfflineStagingComposeSpec({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    assert.equal(spec.summary.isOfflineDryRun, true);
    assert.equal(spec.summary.executed, false);
    // Relies on pre-built image tag; build: section is strictly omitted in staging compose spec
    assert.equal(spec.composeObject.services.candidate.build, undefined);
  });

  // =========================================================================
  // 13. Build Concurrency Limited & Host Headroom Guarded
  // =========================================================================
  await t.test('13. Build concurrency is strictly clamped to 1 and disk headroom is enforced', () => {
    // Concurrency limit = 1
    assert.equal(DEFAULT_RESOURCE_BUDGET.maxBuildConcurrency, 1);
    const allowFirst = enforceBuildConcurrency(0);
    assert.equal(allowFirst.allowed, true);

    assert.throws(
      () => enforceBuildConcurrency(1),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'BUILD_CONCURRENCY_EXCEEDED');
        return true;
      }
    );

    // Disk headroom guard: 54 GB free (safe) vs 5 GB free (aborted)
    const safeHeadroom = evaluateDiskHeadroom(54 * 1024 * 1024 * 1024, 'build');
    assert.equal(safeHeadroom.safe, true);

    assert.throws(
      () => evaluateDiskHeadroom(5 * 1024 * 1024 * 1024, 'build'),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'DISK_PRESSURE_ABORT');
        return true;
      }
    );

    // Global prune prohibition
    assert.throws(
      () => validatePruneCommandSafety('docker system prune -a'),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'GLOBAL_PRUNING_PROHIBITED');
        return true;
      }
    );

    assert.throws(
      () => validatePruneCommandSafety('docker builder prune -a'),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'GLOBAL_PRUNING_PROHIBITED');
        return true;
      }
    );
  });

  // =========================================================================
  // 14. Docker Socket Privileges Segregated in Design
  // =========================================================================
  await t.test('14. Docker socket privileges remain segregated into 4 architectural tiers', () => {
    const audit = auditSocketMountSecurity();
    assert.equal(audit.isApiReadOnly, false, ':ro bind mount does NOT make Docker API read-only');
    assert.equal(audit.securityFinding, 'CRITICAL_ARCHITECTURAL_MISCONCEPTION');

    const tiers = Object.values(PRIVILEGE_TIERS);
    assert.ok(tiers.includes('dashboard-api'));
    assert.ok(tiers.includes('read-only-inventory'));
    assert.ok(tiers.includes('deployment-executor'));
    assert.ok(tiers.includes('build-executor'));

    // Dashboard has zero socket mount
    assert.equal(ENDPOINT_PERMISSIONS[PRIVILEGE_TIERS.DASHBOARD_API].dockerSocketMounted, false);
    assert.deepEqual(ENDPOINT_PERMISSIONS[PRIVILEGE_TIERS.DASHBOARD_API].allowedMethods, []);

    // Inventory adapter is strictly GET
    assert.deepEqual(ENDPOINT_PERMISSIONS[PRIVILEGE_TIERS.READ_ONLY_INVENTORY].allowedMethods, ['GET']);
  });

  // =========================================================================
  // 15. Production Release Status Remains Unchanged
  // =========================================================================
  await t.test('15. Production release status remains unchanged by staging operations', () => {
    const plan = planIsolatedStagingIngress({
      applicationId: '11111111-2222-4333-8444-555555555555',
      deploymentId: '66666666-7777-4888-8999-000000000000',
      candidateContainerId: 'cand-safe-01',
      candidatePort: 3000,
      stagingNetworkId: 'kpanel-staging-net',
      loopbackPort: 18080
    });

    // Strategy is isolated loopback staging
    assert.equal(plan.strategy, STRATEGIES.ISOLATED_LOOPBACK_STAGING);
    assert.equal(plan.status, 'planned');
    // Staging plan does NOT confer production readiness or activation
    assert.equal(plan.productionReleaseStatus, undefined);
  });

  // =========================================================================
  // 16. Candidate Resource Limits Clamped on 4-OCPU Host
  // =========================================================================
  await t.test('16. Candidate resource limits are bounded and clamped on 4-OCPU host', () => {
    const budget = validateCandidateResourceBudget({ cpuLimit: 1.5, memoryLimitMb: 2048 });
    assert.equal(budget.cpuLimit, 1.5);
    assert.equal(budget.memoryLimitMb, 2048);

    // Rejecting > 2.0 OCPU default budget
    assert.throws(
      () => validateCandidateResourceBudget({ cpuLimit: 3.5 }),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'RESOURCE_LIMIT_EXCEEDED');
        return true;
      }
    );

    // Rejecting > 4096 MB memory budget
    assert.throws(
      () => validateCandidateResourceBudget({ memoryLimitMb: 8192 }),
      (err) => {
        assert.ok(err instanceof ResourceBudgetError);
        assert.equal(err.code, 'RESOURCE_LIMIT_EXCEEDED');
        return true;
      }
    );
  });
});
