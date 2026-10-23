const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const {
  validateIsolatedStagingBundle,
  validateBundleDirectory,
  loadAndRenderCompose,
  StagingBundleValidationError,
  PROHIBITED_HOST_PORTS,
  PROTECTED_PROJECT_NAMES,
  PROTECTED_CONTAINER_NAMES
} = require('../scripts/validateIsolatedStagingBundle');

const resourceBudgetService = require('../services/resourceBudgetService');
const {
  OBSERVED_HOST_CAPACITY,
  DEFAULT_RESOURCE_BUDGET,
  validateCandidateResourceBudget,
  evaluateDiskHeadroom,
  enforceBuildConcurrency,
  validatePruneCommandSafety,
  validateSmokeCleanupPlan,
  validateRunMetadataContract,
  createPreMutationRunJournal,
  updateRunJournalStatus,
  validateServiceContainerDiscovery,
  comparePreExistingContainerState,
  evaluateStagingResourcePreflight,
  ResourceBudgetError
} = resourceBudgetService;

const stagingStrategyService = require('../services/stagingStrategyService');
const {
  STRATEGIES,
  validateLoopbackPort,
  validateStagingNamespace,
  planIsolatedStagingIngress,
  StagingStrategyError
} = stagingStrategyService;

const dockerSecurityService = require('../services/dockerSecurityService');
const {
  PRIVILEGE_TIERS,
  ENDPOINT_PERMISSIONS,
  auditSocketMountSecurity
} = dockerSecurityService;

const runtimeService = require('../services/runtimeService');

const {
  APPROVED_BUNDLE_FILES,
  auditSourceDirectory,
  createStagingSmokeBundle,
  verifyTransferBundle,
  verifyManifestWorkingDirectory,
  inspectArchiveContents,
  computeFileSha256,
  BundlePackagingError
} = require('../scripts/packageStagingSmokeBundle');

const BUNDLE_DIR = path.resolve(__dirname, '..', '..', 'deploy', 'staging-smoke');

/**
 * Creates a valid base Compose object for negative testing mutations.
 */
function createValidTestCompose(overrides = {}) {
  const base = {
    name: 'kpanel-smoke-test-run-001',
    services: {
      candidate: {
        container_name: 'kpanel-smoke-test-run-001-candidate',
        image: 'kpanel-smoke-candidate:local',
        user: 'node',
        restart: 'no',
        networks: ['staging_net'],
        expose: ['8080'],
        ports: [],
        environment: [
          'PORT=8080',
          'NODE_ENV=production',
          'APP_NAME=kpanel-smoke-candidate'
        ],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
        deploy: {
          resources: {
            limits: {
              cpus: '1.0',
              memory: '1024M',
              pids: 256
            }
          }
        },
        logging: {
          driver: 'json-file',
          options: {
            'max-size': '10m',
            'max-file': '3'
          }
        },
        healthcheck: {
          test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/healthz'],
          interval: '5s',
          timeout: '3s',
          retries: 3,
          start_period: '2s'
        },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'candidate',
          'io.kpanel.environment': 'staging-smoke',
          'io.kpanel.smoke-run-id': 'smoke-run-001'
        }
      },
      ingress: {
        container_name: 'kpanel-smoke-test-run-001-ingress',
        image: 'kpanel-smoke-ingress:local',
        user: '101:101',
        restart: 'no',
        depends_on: {
          candidate: {
            condition: 'service_healthy',
            required: true
          }
        },
        networks: ['staging_net'],
        ports: [
          {
            host_ip: '127.0.0.1',
            published: 18080,
            target: 8080,
            mode: 'ingress'
          }
        ],
        volumes: [
          {
            source: './ingress/nginx.conf',
            target: '/etc/nginx/nginx.conf',
            read_only: true
          }
        ],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        read_only: true,
        tmpfs: [
          '/tmp:rw,noexec,nosuid,size=32m',
          '/var/cache/nginx:rw,noexec,nosuid,size=32m',
          '/var/run:rw,noexec,nosuid,size=16m'
        ],
        deploy: {
          resources: {
            limits: {
              cpus: '0.5',
              memory: '256M',
              pids: 64
            }
          }
        },
        logging: {
          driver: 'json-file',
          options: {
            'max-size': '5m',
            'max-file': '2'
          }
        },
        healthcheck: {
          test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:8080/healthz'],
          interval: '5s',
          timeout: '3s',
          retries: 3,
          start_period: '2s'
        },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'staging-ingress',
          'io.kpanel.environment': 'staging-smoke',
          'io.kpanel.smoke-run-id': 'smoke-run-001'
        }
      }
    },
    networks: {
      staging_net: {
        driver: 'bridge'
      }
    }
  };

  // Deep clone and merge overrides
  const result = JSON.parse(JSON.stringify(base));
  if (overrides.name) result.name = overrides.name;
  if (overrides.services) {
    for (const [k, v] of Object.entries(overrides.services)) {
      if (v === null) {
        delete result.services[k];
      } else {
        result.services[k] = { ...(result.services[k] || {}), ...v };
      }
    }
  }
  if (overrides.networks) {
    result.networks = { ...result.networks, ...overrides.networks };
  }
  return result;
}

test('Phase 4C3D4: Disposable Staging Bundle & Offline Preflight Suite', async (t) => {
  // =========================================================================
  // 1. Valid isolated project verification
  // =========================================================================
  await t.test('1. Valid isolated project configuration passes all 20 rules', () => {
    const compose = createValidTestCompose();
    const report = validateIsolatedStagingBundle(compose, { operatorSelectedPort: 18080 });

    assert.equal(report.valid, true);
    assert.equal(report.totalRulesEvaluated, 20);
    assert.equal(report.passedRulesCount, 20);
    assert.equal(report.blockersCount, 0);
    assert.equal(report.projectName, 'kpanel-smoke-test-run-001');
    assert.equal(report.ingressPort, 18080);
  });

  // =========================================================================
  // 2. Protected project name rejection
  // =========================================================================
  await t.test('2. Protected project names (kpanel, kpanel-clean, dokploy, n8n) are strictly rejected', () => {
    for (const badName of ['kpanel', 'kpanel-clean', 'dokploy', 'n8n']) {
      const compose = createValidTestCompose({ name: badName });
      const report = validateIsolatedStagingBundle(compose, { operatorSelectedPort: 18080 });

      assert.equal(report.valid, false);
      const blocker = report.blockers.find((b) => b.code === 'NO_PROTECTED_PROJECT_NAMES');
      assert.ok(blocker, `Must block protected project name: ${badName}`);
      assert.match(blocker.message, /collides with a protected host project/i);
    }
  });

  // =========================================================================
  // 3. Correct staging network identity (bridge, isolated, no overlay)
  // =========================================================================
  await t.test('3. Missing or non-bridge staging network is rejected', () => {
    // Missing network definition
    const noNetCompose = createValidTestCompose();
    noNetCompose.networks = {};
    const report1 = validateIsolatedStagingBundle(noNetCompose, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'EXPLICIT_STAGING_NETWORK'));

    // Swarm overlay network rejection
    const overlayCompose = createValidTestCompose({
      networks: {
        staging_net: { driver: 'overlay' }
      }
    });
    const report2 = validateIsolatedStagingBundle(overlayCompose, { operatorSelectedPort: 18080 });
    assert.equal(report2.valid, false);
    assert.ok(report2.blockers.some((b) => b.code === 'NO_SWARM_OVERLAY_ADOPTION'));
  });

  // =========================================================================
  // 4. Ingress-only loopback port binding (127.0.0.1:<port>)
  // =========================================================================
  await t.test('4. Staging ingress must bind strictly to 127.0.0.1; 0.0.0.0 and public IPs rejected', () => {
    // 0.0.0.0 binding rejection
    const publicCompose = createValidTestCompose({
      services: {
        ingress: {
          ports: ['0.0.0.0:18080:8080']
        }
      }
    });
    const report1 = validateIsolatedStagingBundle(publicCompose, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'LOOPBACK_ONLY_INGRESS_PUBLICATION'));

    // Omitted host IP (Docker default 0.0.0.0) rejection
    const defaultIpCompose = createValidTestCompose({
      services: {
        ingress: {
          ports: ['18080:8080']
        }
      }
    });
    const report2 = validateIsolatedStagingBundle(defaultIpCompose, { operatorSelectedPort: 18080 });
    assert.equal(report2.valid, false);
    assert.ok(report2.blockers.some((b) => b.code === 'LOOPBACK_ONLY_INGRESS_PUBLICATION'));
  });

  // =========================================================================
  // 5. Candidate no-host-port invariant
  // =========================================================================
  await t.test('5. Candidate container with published host ports is strictly rejected', () => {
    const badCandidateCompose = createValidTestCompose({
      services: {
        candidate: {
          ports: ['127.0.0.1:8080:8080']
        }
      }
    });
    const report = validateIsolatedStagingBundle(badCandidateCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    const blocker = report.blockers.find((b) => b.code === 'CANDIDATE_NO_PUBLISHED_PORTS');
    assert.ok(blocker);
    assert.match(blocker.message, /zero published host ports/i);
  });

  // =========================================================================
  // 6. Missing health-check rejection
  // =========================================================================
  await t.test('6. Candidate missing health-check is strictly rejected', () => {
    const noHealthCompose = createValidTestCompose();
    delete noHealthCompose.services.candidate.healthcheck;

    const report = validateIsolatedStagingBundle(noHealthCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'HEALTH_CHECK_EXISTS_AND_VALID'));
  });

  // =========================================================================
  // 7. Wrong internal port and privileged port rejection
  // =========================================================================
  await t.test('7. Privileged (<1024) or invalid ingress ports are rejected', () => {
    // Port 80 (privileged HTTP)
    const priv80Compose = createValidTestCompose({
      services: {
        ingress: {
          ports: ['127.0.0.1:80:8080']
        }
      }
    });
    const report1 = validateIsolatedStagingBundle(priv80Compose, { operatorSelectedPort: 80 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'OPERATOR_SELECTED_HOST_PORT_REQUIRED' || b.code === 'LOOPBACK_ONLY_INGRESS_PUBLICATION'));

    // Prohibited system port (22 SSH)
    assert.throws(
      () => validateLoopbackPort(22),
      (err) => err instanceof StagingStrategyError && (err.code === 'PRIVILEGED_PORT_PROHIBITED' || err.code === 'PROHIBITED_HOST_PORT')
    );

    // Prohibited system port (5001 legacy K-Panel backend)
    assert.throws(
      () => validateLoopbackPort(5001),
      (err) => err instanceof StagingStrategyError && err.code === 'PROHIBITED_HOST_PORT'
    );
  });

  // =========================================================================
  // 8. Docker socket mount rejection
  // =========================================================================
  await t.test('8. Mounting /var/run/docker.sock into any service is strictly rejected', () => {
    // Mount on candidate
    const socketCandidate = createValidTestCompose({
      services: {
        candidate: {
          volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro']
        }
      }
    });
    const report1 = validateIsolatedStagingBundle(socketCandidate, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'NO_DOCKER_SOCKET_MOUNT'));

    // Mount on ingress
    const socketIngress = createValidTestCompose({
      services: {
        ingress: {
          volumes: ['/var/run/docker.sock:/var/run/docker.sock:ro']
        }
      }
    });
    const report2 = validateIsolatedStagingBundle(socketIngress, { operatorSelectedPort: 18080 });
    assert.equal(report2.valid, false);
    assert.ok(report2.blockers.some((b) => b.code === 'NO_DOCKER_SOCKET_MOUNT'));
  });

  // =========================================================================
  // 9. Privileged service and capability rejection
  // =========================================================================
  await t.test('9. Privileged container flags or missing capability drop are strictly rejected', () => {
    // privileged: true
    const privCompose = createValidTestCompose({
      services: {
        candidate: {
          privileged: true
        }
      }
    });
    const report1 = validateIsolatedStagingBundle(privCompose, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'NO_PRIVILEGE_ESCALATION'));

    // missing cap_drop ALL
    const noCapDropCompose = createValidTestCompose();
    noCapDropCompose.services.candidate.cap_drop = [];
    const report2 = validateIsolatedStagingBundle(noCapDropCompose, { operatorSelectedPort: 18080 });
    assert.equal(report2.valid, false);
    assert.ok(report2.blockers.some((b) => b.code === 'NO_PRIVILEGE_ESCALATION'));
  });

  // =========================================================================
  // 10. Dokploy network rejection
  // =========================================================================
  await t.test('10. Attachment to dokploy-network or foreign networks is strictly rejected', () => {
    const dokployNetCompose = createValidTestCompose({
      networks: {
        'dokploy-network': { external: true }
      },
      services: {
        candidate: {
          networks: ['dokploy-network']
        }
      }
    });
    const report = validateIsolatedStagingBundle(dokployNetCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'NO_DOKPLOY_NETWORK_MEMBERSHIP'));
  });

  // =========================================================================
  // 11. Existing K-Panel network adoption rejection
  // =========================================================================
  await t.test('11. Reusing legacy K-Panel networks (kpanel_net, kpanel-clean_kpanel_net) is rejected', () => {
    const legacyNetCompose = createValidTestCompose({
      networks: {
        kpanel_net: { external: true }
      }
    });
    const report = validateIsolatedStagingBundle(legacyNetCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'NO_EXISTING_KPANEL_NETWORK_ADOPTION'));
  });

  // =========================================================================
  // 12. Untrusted host volume rejection
  // =========================================================================
  await t.test('12. Arbitrary host filesystem mounts (/home, /etc, /) are strictly rejected', () => {
    const hostMountCompose = createValidTestCompose({
      services: {
        candidate: {
          volumes: ['/home/ubuntu:/home/ubuntu:rw']
        }
      }
    });
    const report = validateIsolatedStagingBundle(hostMountCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'NO_UNAUTHORIZED_HOST_MOUNTS'));
  });

  // =========================================================================
  // 13. Resource limit enforcement and rejection of excessive limits
  // =========================================================================
  await t.test('13. Excessive resource requests are rejected with clear diagnostics, not silently clamped', () => {
    // Excessive candidate CPU (> 2.0 on 4-OCPU host)
    const excessCpuCompose = createValidTestCompose({
      services: {
        candidate: {
          deploy: { resources: { limits: { cpus: '3.5', memory: '1024M' } } }
        }
      }
    });
    const report1 = validateIsolatedStagingBundle(excessCpuCompose, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'CORRECT_RESOURCE_LIMITS'));

    // Resource budget service throws clear RESOURCE_LIMIT_EXCEEDED
    assert.throws(
      () => validateCandidateResourceBudget({ cpuLimit: 3.5, memoryLimitMb: 1024 }),
      (err) => err instanceof ResourceBudgetError && err.code === 'RESOURCE_LIMIT_EXCEEDED'
    );

    assert.throws(
      () => validateCandidateResourceBudget({ cpuLimit: 1.0, memoryLimitMb: 8192 }),
      (err) => err instanceof ResourceBudgetError && err.code === 'RESOURCE_LIMIT_EXCEEDED'
    );
  });

  // =========================================================================
  // 14. Occupied port simulated
  // =========================================================================
  await t.test('14. Occupied host port is detected and rejected during preflight', () => {
    const compose = createValidTestCompose();
    // Simulate port 18080 already occupied
    const report = validateIsolatedStagingBundle(compose, {
      operatorSelectedPort: 18080,
      occupiedPorts: [18080, 80, 443, 3030, 5001]
    });

    assert.equal(report.valid, false);
    const blocker = report.blockers.find((b) => b.code === 'OPERATOR_SELECTED_HOST_PORT_REQUIRED');
    assert.ok(blocker);
    assert.match(blocker.message, /occupied by an active service/i);
  });

  // =========================================================================
  // 15. ARM64 architecture compatibility and mismatch handling
  // =========================================================================
  await t.test('15. ARM64 architecture compatibility verified; architecture mismatches rejected', () => {
    // ARM64 host with ARM64 image passes
    const preflightPass = evaluateStagingResourcePreflight(
      {
        availableMemoryBytes: 14 * 1024 * 1024 * 1024,
        availableDiskBytes: 54 * 1024 * 1024 * 1024,
        ocpuCount: 4,
        hostArch: 'aarch64'
      },
      {
        candidateCpu: 1.0,
        candidateMemoryMb: 1024,
        ingressCpu: 0.5,
        ingressMemoryMb: 256,
        loopbackPort: 18080,
        imageArch: 'arm64'
      }
    );
    assert.equal(preflightPass.passed, true);

    // ARM64 host with x86_64 image rejected
    const preflightFail = evaluateStagingResourcePreflight(
      {
        availableMemoryBytes: 14 * 1024 * 1024 * 1024,
        availableDiskBytes: 54 * 1024 * 1024 * 1024,
        ocpuCount: 4,
        hostArch: 'aarch64'
      },
      {
        loopbackPort: 18080,
        imageArch: 'x86_64'
      }
    );
    assert.equal(preflightFail.passed, false);
    assert.ok(preflightFail.blockers.some((b) => b.code === 'ARM64_COMPATIBILITY'));
  });

  // =========================================================================
  // 16. Candidate-to-ingress routing verification
  // =========================================================================
  await t.test('16. Ingress upstream correctly routes to candidate service', () => {
    const nginxConfPath = path.join(BUNDLE_DIR, 'ingress', 'nginx.conf');
    assert.ok(fs.existsSync(nginxConfPath), 'ingress/nginx.conf must exist');

    const nginxContent = fs.readFileSync(nginxConfPath, 'utf8');
    assert.ok(nginxContent.includes('server candidate:8080;'), 'Nginx must upstream to candidate:8080');
    assert.ok(nginxContent.includes('listen 8080'), 'Nginx must listen on unprivileged port 8080');
    assert.ok(!nginxContent.includes('traefik'), 'Nginx must have zero Traefik dependencies');
  });

  // =========================================================================
  // 17. Safe logging settings (bounded json-file)
  // =========================================================================
  await t.test('17. Logging settings must be bounded with max-size and max-file', () => {
    const compose = createValidTestCompose();
    const candidateLogging = compose.services.candidate.logging;
    const ingressLogging = compose.services.ingress.logging;

    assert.equal(candidateLogging.driver, 'json-file');
    assert.equal(candidateLogging.options['max-size'], '10m');
    assert.equal(candidateLogging.options['max-file'], '3');

    assert.equal(ingressLogging.driver, 'json-file');
    assert.equal(ingressLogging.options['max-size'], '5m');
    assert.equal(ingressLogging.options['max-file'], '2');
  });

  // =========================================================================
  // 18. No secrets injection
  // =========================================================================
  await t.test('18. Container environment must not contain database secrets or backend credentials', () => {
    const leakedCompose = createValidTestCompose({
      services: {
        candidate: {
          environment: ['DATABASE_URL=sqlite:///app/data/kpanel.db', 'SESSION_SECRET=supersecret123']
        }
      }
    });
    const report = validateIsolatedStagingBundle(leakedCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'NO_PRODUCTION_SECRETS'));
  });

  // =========================================================================
  // 19. No Traefik production labels or Cloudflare Tunnel
  // =========================================================================
  await t.test('19. Traefik routing labels and Cloudflare services are strictly blocked', () => {
    const traefikExposedCompose = createValidTestCompose({
      services: {
        candidate: {
          labels: {
            'traefik.enable': 'true',
            'traefik.http.routers.staging.rule': 'Host(`staging.kpanel.dev`)'
          }
        }
      }
    });
    const report = validateIsolatedStagingBundle(traefikExposedCompose, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, false);
    assert.ok(report.blockers.some((b) => b.code === 'NO_TRAEFIK_PRODUCTION_LABELS'));
  });

  // =========================================================================
  // 20. Container name collisions by design
  // =========================================================================
  await t.test('20. Container names colliding with existing workloads (kpanel-frontend-1, dokploy-traefik) are blocked', () => {
    for (const badContainer of ['kpanel-frontend-1', 'kpanel-backend-1', 'dokploy-traefik', 'n8n']) {
      const collidingCompose = createValidTestCompose({
        services: {
          candidate: {
            container_name: badContainer
          }
        }
      });
      const report = validateIsolatedStagingBundle(collidingCompose, { operatorSelectedPort: 18080 });
      assert.equal(report.valid, false);
      assert.ok(report.blockers.some((b) => b.code === 'NO_CONTAINER_NAME_COLLISIONS'));
    }
  });

  // =========================================================================
  // 21. No global Docker prune enforcement
  // =========================================================================
  await t.test('21. Global Docker prune commands are strictly prohibited in code and design', () => {
    const prohibited = [
      'docker system prune',
      'docker system prune -a',
      'docker volume prune',
      'docker builder prune -a',
      '/system/prune'
    ];

    for (const cmd of prohibited) {
      assert.throws(
        () => validatePruneCommandSafety(cmd),
        (err) => err instanceof ResourceBudgetError && err.code === 'GLOBAL_PRUNING_PROHIBITED'
      );
    }
  });

  // =========================================================================
  // 22. Real generated bundle files verification
  // =========================================================================
  await t.test('22. Real generated staging bundle files in deploy/staging-smoke pass validation', () => {
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'docker-compose.yml')), 'docker-compose.yml must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, '.env.example')), '.env.example must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'RUNBOOK.md')), 'RUNBOOK.md must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'README.md')), 'README.md must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'candidate', 'Dockerfile')), 'candidate/Dockerfile must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'candidate', 'server.js')), 'candidate/server.js must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'ingress', 'Dockerfile')), 'ingress/Dockerfile must exist');
    assert.ok(fs.existsSync(path.join(BUNDLE_DIR, 'ingress', 'nginx.conf')), 'ingress/nginx.conf must exist');

    // Run directory validation
    const bundleReport = validateBundleDirectory(BUNDLE_DIR, { operatorSelectedPort: 18080 });
    assert.equal(bundleReport.valid, true, `Bundle validation failed: ${JSON.stringify(bundleReport.blockers)}`);
    assert.equal(bundleReport.totalRulesEvaluated, 20);
    assert.equal(bundleReport.passedRulesCount, 20);
    assert.equal(bundleReport.blockersCount, 0);

    // Verify candidate Dockerfile has non-root USER and HEALTHCHECK
    const candidateDockerfile = fs.readFileSync(path.join(BUNDLE_DIR, 'candidate', 'Dockerfile'), 'utf8');
    assert.ok(candidateDockerfile.includes('USER node'), 'Candidate Dockerfile must enforce non-root user');
    assert.ok(candidateDockerfile.includes('HEALTHCHECK'), 'Candidate Dockerfile must declare HEALTHCHECK');

    // Verify .env.example does not contain production secrets
    const envExample = fs.readFileSync(path.join(BUNDLE_DIR, '.env.example'), 'utf8');
    assert.ok(!envExample.includes('DATABASE_URL='), '.env.example must not contain database url');
    assert.ok(!envExample.includes('SECRET='), '.env.example must not contain secrets');
    assert.ok(envExample.includes('STAGING_INGRESS_PORT=18080'), '.env.example must set default loopback port 18080');

    // Verify RUNBOOK.md documents evaluation of internal: true
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');
    assert.ok(runbook.includes('internal: true'), 'RUNBOOK must document evaluation of internal: true');
    assert.ok(runbook.includes('SSH Tunnel'), 'RUNBOOK must document SSH tunnel access');
    assert.ok(runbook.includes('GLOBAL_PRUNING_PROHIBITED') || runbook.includes('docker system prune'), 'RUNBOOK must prohibit global prune');
  });

  // =========================================================================
  // 23. Zero production Docker mutations and zero release writes
  // =========================================================================
  await t.test('23. Staging operations perform zero production Docker mutations or active release writes', () => {
    // Assert that runtime execution is disabled without both gates
    assert.equal(process.env.KPANEL_RUNTIME_EXECUTION_ENABLED, undefined);

    // Verify candidate planning returns a plan without executing docker commands
    const plan = planIsolatedStagingIngress({
      applicationId: 'app-smoke-demo',
      deploymentId: 'dep-smoke-demo-001',
      candidateContainerId: 'cand-smoke-001',
      loopbackPort: 18080
    });

    assert.equal(plan.strategy, STRATEGIES.ISOLATED_LOOPBACK_STAGING);
    assert.equal(plan.status, 'planned');
    assert.equal(plan.candidate.hasPublishedPorts, false);
    assert.equal(plan.accessModel.mode, 'ssh-tunnel-loopback');
    assert.equal(plan.productionIsolation.dokployTraefikUntouched, true);
    assert.equal(plan.productionIsolation.existingKpanelContainersPreserved, true);
  });

  // =========================================================================
  // 24. Phase 4C3D4R Regression 1: No --remove-orphans in cleanup
  // =========================================================================
  await t.test('24. Regression 1: --remove-orphans is strictly rejected during cleanup', () => {
    // Prohibited via command string validator
    assert.throws(
      () => validatePruneCommandSafety('docker compose -p kpanel-smoke-run-001 down --remove-orphans'),
      (err) => err instanceof ResourceBudgetError && err.code === 'REMOVE_ORPHANS_PROHIBITED'
    );

    // Prohibited via cleanup plan validator
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-run-001',
        flags: ['--remove-orphans'],
        operatorConfirmed: true
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'REMOVE_ORPHANS_PROHIBITED'
    );

    // RUNBOOK.md must strictly forbid --remove-orphans
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');
    assert.ok(runbook.includes('--remove-orphans'), 'RUNBOOK must document --remove-orphans prohibition');
    assert.ok(runbook.includes('DO NOT USE `docker compose down --remove-orphans`'), 'RUNBOOK must explicitly prohibit --remove-orphans');
  });

  // =========================================================================
  // 25. Phase 4C3D4R Regression 2: No image/system/builder/volume prune in cleanup
  // =========================================================================
  await t.test('25. Regression 2: Image, system, builder, and volume prune operations are strictly prohibited', () => {
    const dangerousPrunes = [
      'docker image prune',
      'docker image prune -f',
      'docker image prune -f --filter "label=io.kpanel.smoke-run-id=smoke-123"',
      'docker system prune',
      'docker system prune -a',
      'docker builder prune',
      'docker builder prune -a',
      'docker volume prune',
      'docker container prune',
      'docker network prune',
      '/images/prune',
      '/system/prune'
    ];

    for (const cmd of dangerousPrunes) {
      assert.throws(
        () => validatePruneCommandSafety(cmd),
        (err) => err instanceof ResourceBudgetError && (err.code === 'GLOBAL_PRUNING_PROHIBITED' || err.code === 'IMAGE_PRUNE_PROHIBITED'),
        `Must reject dangerous prune: ${cmd}`
      );
    }

    // Prohibit --volumes in compose down
    assert.throws(
      () => validatePruneCommandSafety('docker compose -p kpanel-smoke-run-001 down --volumes'),
      (err) => err instanceof ResourceBudgetError && err.code === 'VOLUMES_CLEANUP_PROHIBITED'
    );

    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-run-001',
        flags: ['--volumes'],
        operatorConfirmed: true
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'VOLUMES_CLEANUP_PROHIBITED'
    );
  });

  // =========================================================================
  // 26. Phase 4C3D4R Regression 3: Exact smoke-project identity required
  // =========================================================================
  await t.test('26. Regression 3: Exact, unique smoke-project identity required; unattended cleanup rejected', () => {
    // Missing project name
    assert.throws(
      () => validateSmokeCleanupPlan({ projectName: '', smokeRunId: 'smoke-001', operatorConfirmed: true }),
      (err) => err instanceof ResourceBudgetError && err.code === 'EXACT_PROJECT_NAME_REQUIRED'
    );

    // Protected project names blocked from cleanup
    for (const badProject of ['kpanel', 'kpanel-clean', 'dokploy', 'n8n']) {
      assert.throws(
        () => validateSmokeCleanupPlan({ projectName: badProject, smokeRunId: 'smoke-001', operatorConfirmed: true }),
        (err) => err instanceof ResourceBudgetError && err.code === 'PROTECTED_PROJECT_CLEANUP_BLOCKED'
      );
    }

    // Missing smokeRunId
    assert.throws(
      () => validateSmokeCleanupPlan({ projectName: 'kpanel-smoke-run-001', smokeRunId: '', operatorConfirmed: true }),
      (err) => err instanceof ResourceBudgetError && err.code === 'SMOKE_RUN_ID_REQUIRED'
    );

    // Unattended cleanup strictly rejected
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-001',
        unattended: true,
        operatorConfirmed: true
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'UNATTENDED_CLEANUP_PROHIBITED'
    );

    // Operator confirmation required
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-001',
        operatorConfirmed: false
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'OPERATOR_CONFIRMATION_REQUIRED'
    );
  });

  // =========================================================================
  // 27. Phase 4C3D4R Regression 4: Foreign containers cannot be selected for cleanup
  // =========================================================================
  await t.test('27. Regression 4: Foreign containers from neighbor projects cannot be selected for cleanup', () => {
    // Foreign project container
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-001',
        operatorConfirmed: true,
        containers: [
          {
            id: 'cont-foreign-01',
            name: 'dokploy-server',
            project: 'dokploy',
            labels: { 'com.docker.compose.project': 'dokploy' }
          }
        ]
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'FOREIGN_CONTAINER_PROTECTED'
    );

    // Protected container names shielded
    for (const protName of ['kpanel-frontend-1', 'kpanel-backend-1', 'dokploy-traefik', 'n8n']) {
      assert.throws(
        () => validateSmokeCleanupPlan({
          projectName: 'kpanel-smoke-run-001',
          smokeRunId: 'smoke-001',
          operatorConfirmed: true,
          containers: [
            {
              id: 'cont-prot-01',
              name: protName,
              project: 'kpanel-smoke-run-001',
              labels: { 'com.docker.compose.project': 'kpanel-smoke-run-001', 'io.kpanel.smoke-run-id': 'smoke-001' }
            }
          ]
        }),
        (err) => err instanceof ResourceBudgetError && err.code === 'FOREIGN_CONTAINER_PROTECTED'
      );
    }
  });

  // =========================================================================
  // 28. Phase 4C3D4R Regression 5: Ambiguous ownership blocks cleanup
  // =========================================================================
  await t.test('28. Regression 5: Ambiguous ownership blocks cleanup; unproven images preserved', () => {
    // Missing smoke-run-id label
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-001',
        operatorConfirmed: true,
        recordedContainerIds: ['cont-smoke-01'],
        containers: [
          {
            id: 'cont-smoke-01',
            name: 'kpanel-smoke-run-001-candidate',
            project: 'kpanel-smoke-run-001',
            labels: { 'com.docker.compose.project': 'kpanel-smoke-run-001' } // Missing io.kpanel.smoke-run-id
          }
        ]
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'AMBIGUOUS_OWNERSHIP_BLOCKS_CLEANUP'
    );

    // Mismatched smoke-run-id label
    assert.throws(
      () => validateSmokeCleanupPlan({
        projectName: 'kpanel-smoke-run-001',
        smokeRunId: 'smoke-001',
        operatorConfirmed: true,
        recordedContainerIds: ['cont-smoke-01'],
        containers: [
          {
            id: 'cont-smoke-01',
            name: 'kpanel-smoke-run-001-candidate',
            project: 'kpanel-smoke-run-001',
            labels: {
              'com.docker.compose.project': 'kpanel-smoke-run-001',
              'io.kpanel.smoke-run-id': 'smoke-DIFFERENT-RUN'
            }
          }
        ]
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'AMBIGUOUS_OWNERSHIP_BLOCKS_CLEANUP'
    );

    // Valid plan preserves unproven images and enumerates exact resources
    const validPlan = validateSmokeCleanupPlan({
      projectName: 'kpanel-smoke-run-001',
      smokeRunId: 'smoke-001',
      operatorConfirmed: true,
      recordedContainerIds: ['cont-smoke-01'],
      containers: [
        {
          id: 'cont-smoke-01',
          name: 'kpanel-smoke-run-001-candidate',
          project: 'kpanel-smoke-run-001',
          labels: {
            'com.docker.compose.project': 'kpanel-smoke-run-001',
            'io.kpanel.smoke-run-id': 'smoke-001'
          }
        }
      ],
      images: ['kpanel-smoke-candidate:local', 'node:20-alpine'],
      recordedImageIds: ['kpanel-smoke-candidate:local'],
      removeRecordedImages: false // Default safe: preserve images
    });

    assert.equal(validPlan.authorized, true);
    assert.equal(validPlan.removalPlan.containersToRemove.length, 1);
    assert.equal(validPlan.removalPlan.imagesToRemove.length, 0); // Preserved
    assert.equal(validPlan.removalPlan.imagesPreserved.length, 2);
  });

  // =========================================================================
  // 29. Phase 4C3D4R Regression 6: Candidate and ingress internal ports are consistent
  // =========================================================================
  await t.test('29. Regression 6: Candidate and ingress internal ports must be consistent (fixed 8080)', () => {
    // Valid: both candidate and ingress upstream match 8080
    const validCompose = createValidTestCompose();
    const reportValid = validateIsolatedStagingBundle(validCompose, { operatorSelectedPort: 18080 });
    assert.equal(reportValid.valid, true);

    // Inconsistent port: changing APP_PORT to 9090 while upstream is candidate:8080 is caught
    const mismatchedCompose = createValidTestCompose({
      services: {
        candidate: {
          environment: ['PORT=9090', 'NODE_ENV=production', 'APP_NAME=kpanel-smoke-candidate'],
          expose: ['9090']
        }
      }
    });
    const reportMismatched = validateIsolatedStagingBundle(mismatchedCompose, { operatorSelectedPort: 18080 });
    assert.equal(reportMismatched.valid, false);
    const blockerPort = reportMismatched.blockers.find((b) => b.code === 'INGRESS_UPSTREAM_MATCHES_CANDIDATE');
    assert.ok(blockerPort, 'Must fail when candidate port does not match upstream');
    assert.match(blockerPort.message, /port inconsistency detected/i);

    // Arbitrary upstream host rejection: upstream pointing to external IP is strictly rejected
    const arbitraryUpstreamReport = validateIsolatedStagingBundle(validCompose, {
      operatorSelectedPort: 18080,
      upstreamServer: '192.168.1.100:8080'
    });
    assert.equal(arbitraryUpstreamReport.valid, false);
    const blockerArbitrary = arbitraryUpstreamReport.blockers.find((b) => b.code === 'INGRESS_UPSTREAM_MATCHES_CANDIDATE');
    assert.ok(blockerArbitrary);
    assert.match(blockerArbitrary.message, /arbitrary or external upstream host/i);
  });

  // =========================================================================
  // 30. Phase 4C3D4R Regression 7: Healthcheck uses the correct port
  // =========================================================================
  await t.test('30. Regression 7: Healthcheck command must use matching internal port (8080)', () => {
    // Valid healthcheck on 8080
    const validCompose = createValidTestCompose();
    const reportValid = validateIsolatedStagingBundle(validCompose, { operatorSelectedPort: 18080 });
    assert.ok(reportValid.checks.find((c) => c.code === 'HEALTH_CHECK_EXISTS_AND_VALID').passed);

    // Inconsistent healthcheck port (candidate listens on 8080, healthcheck tests 3000)
    const badHealthcheckCompose = createValidTestCompose({
      services: {
        candidate: {
          healthcheck: {
            test: ['CMD', 'wget', '-qO-', 'http://127.0.0.1:3000/healthz'],
            interval: '5s',
            timeout: '3s',
            retries: 3
          }
        }
      }
    });
    const reportBad = validateIsolatedStagingBundle(badHealthcheckCompose, { operatorSelectedPort: 18080 });
    assert.equal(reportBad.valid, false);
    const blockerHealth = reportBad.blockers.find((b) => b.code === 'HEALTH_CHECK_EXISTS_AND_VALID');
    assert.ok(blockerHealth);
    assert.match(blockerHealth.message, /targets port 3000, which does not match candidate internal port 8080/i);
  });

  // =========================================================================
  // 31. Phase 4C3D4R Regression 8: Non-root startup requirements
  // =========================================================================
  await t.test('31. Regression 8: Non-root user execution required; root execution strictly rejected', () => {
    // Root user on candidate rejected
    for (const badUser of ['root', '0']) {
      const rootCandidateCompose = createValidTestCompose({
        services: {
          candidate: {
            user: badUser
          }
        }
      });
      const reportRoot = validateIsolatedStagingBundle(rootCandidateCompose, {
        operatorSelectedPort: 18080,
        isCandidateNonRoot: false
      });
      assert.equal(reportRoot.valid, false);
      assert.ok(reportRoot.blockers.some((b) => b.code === 'CANDIDATE_NON_ROOT_CONFIG'));
    }

    // Verify candidate Dockerfile enforces USER node
    const candidateDockerfile = fs.readFileSync(path.join(BUNDLE_DIR, 'candidate', 'Dockerfile'), 'utf8');
    assert.ok(candidateDockerfile.includes('USER node'), 'Candidate Dockerfile must enforce USER node');

    // Verify ingress Dockerfile uses unprivileged user
    const ingressDockerfile = fs.readFileSync(path.join(BUNDLE_DIR, 'ingress', 'Dockerfile'), 'utf8');
    assert.ok(ingressDockerfile.includes('nginx-unprivileged'), 'Ingress must use nginx-unprivileged base image');
  });

  // =========================================================================
  // 32. Phase 4C3D4R Regression 9: Nginx writable path requirements
  // =========================================================================
  await t.test('32. Regression 9: Nginx temp paths and PID placed on tmpfs for read-only rootfs', () => {
    const nginxConf = fs.readFileSync(path.join(BUNDLE_DIR, 'ingress', 'nginx.conf'), 'utf8');
    assert.ok(nginxConf.includes('pid /tmp/nginx.pid;'), 'Nginx PID must be in /tmp');
    assert.ok(nginxConf.includes('client_body_temp_path /tmp/client_temp;'), 'Nginx client_body_temp_path must be in /tmp');
    assert.ok(nginxConf.includes('proxy_temp_path       /tmp/proxy_temp_path;'), 'Nginx proxy_temp_path must be in /tmp');

    // Ingress compose must declare tmpfs mounts
    const compose = createValidTestCompose();
    const ingressTmpfs = compose.services.ingress.tmpfs;
    assert.ok(ingressTmpfs.some((t) => t.includes('/tmp')), 'Ingress must have /tmp tmpfs');
    assert.ok(ingressTmpfs.some((t) => t.includes('/var/cache/nginx')), 'Ingress must have /var/cache/nginx tmpfs');
    assert.ok(ingressTmpfs.some((t) => t.includes('/var/run')), 'Ingress must have /var/run tmpfs');
    assert.equal(compose.services.ingress.read_only, true, 'Ingress must have read_only rootfs');
  });

  // =========================================================================
  // 33. Phase 4C3D4R Regression 10: No prohibited privileges
  // =========================================================================
  await t.test('33. Regression 10: No privileged containers, cap_drop ALL, and no-new-privileges enforced', () => {
    // Missing no-new-privileges
    const noNewPrivsMissing = createValidTestCompose();
    noNewPrivsMissing.services.candidate.security_opt = [];
    const report1 = validateIsolatedStagingBundle(noNewPrivsMissing, { operatorSelectedPort: 18080 });
    assert.equal(report1.valid, false);
    assert.ok(report1.blockers.some((b) => b.code === 'NO_PRIVILEGE_ESCALATION'));

    // Privileged true
    const privTrue = createValidTestCompose({ services: { candidate: { privileged: true } } });
    const report2 = validateIsolatedStagingBundle(privTrue, { operatorSelectedPort: 18080 });
    assert.equal(report2.valid, false);
    assert.ok(report2.blockers.some((b) => b.code === 'NO_PRIVILEGE_ESCALATION'));
  });

  // =========================================================================
  // 34. Phase 4C3D4R Regression 11: No production network attachments
  // =========================================================================
  await t.test('34. Regression 11: Production network attachments (dokploy, kpanel_net, swarm) blocked', () => {
    // dokploy-network
    const dokployNet = createValidTestCompose({ networks: { 'dokploy-network': { external: true } } });
    const reportDok = validateIsolatedStagingBundle(dokployNet, { operatorSelectedPort: 18080 });
    assert.equal(reportDok.valid, false);
    assert.ok(reportDok.blockers.some((b) => b.code === 'NO_DOKPLOY_NETWORK_MEMBERSHIP'));

    // legacy kpanel_net
    const legacyNet = createValidTestCompose({ networks: { 'kpanel_net': { external: true } } });
    const reportLeg = validateIsolatedStagingBundle(legacyNet, { operatorSelectedPort: 18080 });
    assert.equal(reportLeg.valid, false);
    assert.ok(reportLeg.blockers.some((b) => b.code === 'NO_EXISTING_KPANEL_NETWORK_ADOPTION'));
  });

  // =========================================================================
  // 35. Phase 4C3D4R Regression 12: Loopback-only ingress
  // =========================================================================
  await t.test('35. Regression 12: Ingress binds strictly to 127.0.0.1; candidate has zero published ports', () => {
    // Candidate cannot publish ports
    const candPorts = createValidTestCompose({ services: { candidate: { ports: ['127.0.0.1:8080:8080'] } } });
    const reportCand = validateIsolatedStagingBundle(candPorts, { operatorSelectedPort: 18080 });
    assert.equal(reportCand.valid, false);
    assert.ok(reportCand.blockers.some((b) => b.code === 'CANDIDATE_NO_PUBLISHED_PORTS'));

    // Ingress 0.0.0.0 binding rejected
    const publicIngress = createValidTestCompose({ services: { ingress: { ports: ['0.0.0.0:18080:8080'] } } });
    const reportIng = validateIsolatedStagingBundle(publicIngress, { operatorSelectedPort: 18080 });
    assert.equal(reportIng.valid, false);
    assert.ok(reportIng.blockers.some((b) => b.code === 'LOOPBACK_ONLY_INGRESS_PUBLICATION'));
  });

  // =========================================================================
  // 36. Phase 4C3D4R Regression 13: Container resource limits
  // =========================================================================
  await t.test('36. Regression 13: Bounded container limits enforced; system reserve protected', () => {
    // Candidate limits: max 2.0 CPU, 4096M RAM
    const validBudget = validateCandidateResourceBudget({ cpuLimit: 1.0, memoryLimitMb: 1024 });
    assert.equal(validBudget.cpuLimit, 1.0);
    assert.equal(validBudget.memoryLimitMb, 1024);

    // Host reserve: evaluateStagingResourcePreflight protects 8 GB system reserve
    const preflight = evaluateStagingResourcePreflight(
      { availableMemoryBytes: 14 * 1024 * 1024 * 1024, availableDiskBytes: 50 * 1024 * 1024 * 1024 },
      { candidateCpu: 1.0, candidateMemoryMb: 1024, ingressCpu: 0.5, ingressMemoryMb: 256, loopbackPort: 18080 }
    );
    assert.equal(preflight.passed, true);
  });

  // =========================================================================
  // 37. Phase 4C3D4R Regression 14: Image build is an explicit future action
  // =========================================================================
  await t.test('37. Regression 14: Image build side effects documented; separate operator approval required', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');
    assert.ok(runbook.includes('PART B: OPERATIONS REQUIRING SEPARATE OPERATOR APPROVAL'), 'RUNBOOK must separate Part B');
    assert.ok(runbook.includes('Daemon-Level Resource Consumption'), 'RUNBOOK must document daemon build resource consumption');
    assert.ok(runbook.includes('do not automatically constrain image builds'), 'RUNBOOK must state container limits do not constrain builds');

    // Build concurrency clamped to 1
    const concurrency = enforceBuildConcurrency(0);
    assert.equal(concurrency.allowed, true);
    assert.throws(
      () => enforceBuildConcurrency(1),
      (err) => err instanceof ResourceBudgetError && err.code === 'BUILD_CONCURRENCY_EXCEEDED'
    );
  });

  // =========================================================================
  // 38. Phase 4C3D4R Regression 15: No automatic production Docker execution
  // =========================================================================
  await t.test('38. Regression 15: Runtime execution remains disabled without explicit authorization', () => {
    assert.equal(process.env.KPANEL_RUNTIME_EXECUTION_ENABLED, undefined);

    const plan = planIsolatedStagingIngress({
      applicationId: 'app-smoke-001',
      deploymentId: 'dep-smoke-001',
      candidateContainerId: 'cand-001',
      loopbackPort: 18080
    });
    assert.equal(plan.status, 'planned');
    assert.equal(plan.productionIsolation.dokployTraefikUntouched, true);
  });

  // =========================================================================
  // 39. Phase 4C3D4R Regression 16: Existing baseline passing test suite integrity
  // =========================================================================
  await t.test('39. Regression 16: Complete bundle directory passes all 20 isolation rules cleanly', () => {
    const report = validateBundleDirectory(BUNDLE_DIR, { operatorSelectedPort: 18080 });
    assert.equal(report.valid, true);
    assert.equal(report.totalRulesEvaluated, 20);
    assert.equal(report.passedRulesCount, 20);
    assert.equal(report.blockersCount, 0);
  });

  // =========================================================================
  // 40. Phase 4C3D6: Transfer package archive and checksum verification
  // =========================================================================
  await t.test('40. Phase 4C3D6: Transfer package archive, checksum, and extraction safety', () => {
    // 1. Audit source directory against approved files
    const audit = auditSourceDirectory(BUNDLE_DIR);
    assert.equal(audit.valid, true);
    assert.equal(audit.fileCount, 8, 'Staging bundle must contain exactly 8 approved files');
    assert.deepEqual(audit.files, [
      '.env.example',
      'README.md',
      'RUNBOOK.md',
      'candidate/Dockerfile',
      'candidate/server.js',
      'docker-compose.yml',
      'ingress/Dockerfile',
      'ingress/nginx.conf'
    ]);

    // 2. Verify archive and checksum files exist in deploy/
    const tarPath = path.resolve(BUNDLE_DIR, '..', 'kpanel-staging-smoke-bundle.tar.gz');
    const shaPath = path.resolve(BUNDLE_DIR, '..', 'kpanel-staging-smoke-bundle.tar.gz.sha256');

    assert.ok(fs.existsSync(tarPath), 'kpanel-staging-smoke-bundle.tar.gz must exist');
    assert.ok(fs.existsSync(shaPath), 'kpanel-staging-smoke-bundle.tar.gz.sha256 must exist');

    // 3. Inspect archive paths: relative only, no absolute paths, no traversal
    const entries = inspectArchiveContents(tarPath);
    assert.ok(entries.length >= 8);
    for (const entry of entries) {
      assert.ok(!entry.startsWith('/'), `Entry must not be absolute: ${entry}`);
      assert.ok(!entry.includes('..'), `Entry must not contain traversal: ${entry}`);
      assert.ok(entry.startsWith('staging-smoke/'), `Entry must be under staging-smoke/: ${entry}`);
    }

    // 4. Verify cryptographic SHA-256 and test extraction in isolated temporary directory
    const verifyReport = verifyTransferBundle(tarPath, shaPath);
    assert.equal(verifyReport.verified, true);
    assert.equal(verifyReport.extractionVerified, true);
    assert.ok(verifyReport.sha256 && verifyReport.sha256.length === 64);
  });

  // =========================================================================
  // 41. Phase 4C3D6H Regression 1-3: Workstation vs VPS separation, remote env scope, Docker context
  // =========================================================================
  await t.test('41. Phase 4C3D6H Regression 1-3: Workstation/VPS separation, remote env scope, and Docker context validation', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 1: Explicit section headers for execution location
    assert.ok(runbook.includes('SECTION A: LOCAL WORKSTATION'), 'RUNBOOK must contain Section A for workstation');
    assert.ok(runbook.includes('SECTION B: ORACLE VPS'), 'RUNBOOK must contain Section B for VPS verification');
    assert.ok(runbook.includes('SECTION C: ORACLE VPS'), 'RUNBOOK must contain Section C for VPS build/start');
    assert.ok(runbook.includes('SECTION D: ORACLE VPS'), 'RUNBOOK must contain Section D for VPS verification');
    assert.ok(runbook.includes('SECTION E: ORACLE VPS'), 'RUNBOOK must contain Section E for VPS cleanup');

    // Item 2: Explicit server-side environment variable exports
    assert.ok(runbook.includes('export COMPOSE_PROJECT_NAME='), 'RUNBOOK must set COMPOSE_PROJECT_NAME server-side');
    assert.ok(runbook.includes('export SMOKE_RUN_ID='), 'RUNBOOK must set SMOKE_RUN_ID server-side');

    // Item 3: Docker context and DOCKER_HOST validation
    assert.ok(runbook.includes('docker context show'), 'RUNBOOK must validate docker context');
    assert.ok(runbook.includes('DOCKER_HOST'), 'RUNBOOK must validate DOCKER_HOST is unset');
  });

  // =========================================================================
  // 42. Phase 4C3D6H Regression 4-7: Remote path config, manifest working directory, corrupted archive rejection, extraction safety
  // =========================================================================
  await t.test('42. Phase 4C3D6H Regression 4-7: Remote paths, manifest working-dir, corrupted archive rejection, and extraction safety', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 4: Remote path configuration without hardcoding /home/operator
    assert.ok(!runbook.includes('operator@<oracle-vps-ip>:/home/operator/'), 'RUNBOOK must not hardcode /home/operator');
    assert.ok(runbook.includes('TARGET_USER'), 'RUNBOOK must parameterize TARGET_USER');
    assert.ok(runbook.includes('REMOTE_STAGING_DIR'), 'RUNBOOK must parameterize REMOTE_STAGING_DIR');

    // Test that validateRunMetadataContract rejects forbidden system paths
    for (const badPath of ['/', '/etc', '/var', '/root', '/home', '/opt/dokploy', '/home/ubuntu/n8n']) {
      assert.throws(
        () => validateRunMetadataContract({
          projectName: 'kpanel-smoke-test-run',
          smokeRunId: 'smoke-run-001',
          stagingDirectory: badPath,
          loopbackPort: 18080
        }),
        (err) => err instanceof ResourceBudgetError && err.code === 'FORBIDDEN_STAGING_DIRECTORY'
      );
    }

    // Item 5: Checksum working-directory correctness
    const tarPath = path.resolve(BUNDLE_DIR, '..', 'kpanel-staging-smoke-bundle.tar.gz');
    const shaPath = path.resolve(BUNDLE_DIR, '..', 'kpanel-staging-smoke-bundle.tar.gz.sha256');
    const deployDir = path.dirname(tarPath);

    const manifestCheck = verifyManifestWorkingDirectory(shaPath, deployDir);
    assert.equal(manifestCheck.isBareFilename, true, 'Manifest must specify a bare filename');
    assert.equal(manifestCheck.existsInWorkingDir, true, 'Archive must exist in manifest working dir');

    const foreignCheck = verifyManifestWorkingDirectory(shaPath, os.tmpdir());
    assert.equal(foreignCheck.existsInWorkingDir, false, 'Archive must not exist in arbitrary foreign directory');

    // Item 6: Negative test: corrupted archive rejection
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kpanel-corrupt-test-'));
    try {
      const corruptTarPath = path.join(tempDir, 'kpanel-staging-smoke-bundle.tar.gz');
      const corruptShaPath = path.join(tempDir, 'kpanel-staging-smoke-bundle.tar.gz.sha256');

      // Copy genuine files
      fs.copyFileSync(tarPath, corruptTarPath);
      fs.copyFileSync(shaPath, corruptShaPath);

      // Corrupt a byte in the tarball
      const buf = fs.readFileSync(corruptTarPath);
      buf[Math.floor(buf.length / 2)] ^= 0xff;
      fs.writeFileSync(corruptTarPath, buf);

      assert.throws(
        () => verifyTransferBundle(corruptTarPath, corruptShaPath),
        (err) => err instanceof BundlePackagingError && err.code === 'CHECKSUM_MISMATCH'
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    // Item 7: Extraction safety: directory permissions and dedicated empty directory
    assert.ok(runbook.includes('chmod 700'), 'RUNBOOK must enforce restricted directory permissions');
    assert.ok(runbook.includes('Halting to prevent overwrite') || runbook.includes('is not empty'), 'RUNBOOK must verify empty extraction directory');
  });

  // =========================================================================
  // 43. Phase 4C3D6H Regression 8-10: No guessed container names, service ID discovery, zero/multiple ID rejection
  // =========================================================================
  await t.test('43. Phase 4C3D6H Regression 8-10: Service-based ID discovery and zero/multiple ID rejection', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 8 & 9: Use exact compose service query rather than guessed names
    assert.ok(runbook.includes('ps -q candidate'), 'RUNBOOK must query candidate service ID via compose ps -q candidate');
    assert.ok(runbook.includes('ps -q ingress'), 'RUNBOOK must query ingress service ID via compose ps -q ingress');
    assert.ok(!runbook.includes('docker inspect "${COMPOSE_PROJECT_NAME}-candidate"'), 'RUNBOOK must not inspect guessed container name');

    // Item 10: validateServiceContainerDiscovery verifies single ID and rejects zero/multiple
    // Valid single ID
    const validCandidate = validateServiceContainerDiscovery({ service: 'candidate', ids: 'c1a2b3c4d5e6' });
    assert.equal(validCandidate.containerId, 'c1a2b3c4d5e6');
    assert.equal(validCandidate.verifiedSingleId, true);

    // Zero IDs rejection
    assert.throws(
      () => validateServiceContainerDiscovery({ service: 'candidate', ids: '' }),
      (err) => err instanceof ResourceBudgetError && err.code === 'ZERO_CONTAINERS_DISCOVERED'
    );
    assert.throws(
      () => validateServiceContainerDiscovery({ service: 'candidate', ids: [] }),
      (err) => err instanceof ResourceBudgetError && err.code === 'ZERO_CONTAINERS_DISCOVERED'
    );

    // Multiple IDs rejection
    assert.throws(
      () => validateServiceContainerDiscovery({ service: 'candidate', ids: ['c1a2b3c4d5e6', 'f9e8d7c6b5a4'] }),
      (err) => err instanceof ResourceBudgetError && err.code === 'MULTIPLE_CONTAINERS_DISCOVERED'
    );

    // Label verification in inspect data
    assert.throws(
      () => validateServiceContainerDiscovery({
        service: 'candidate',
        ids: 'c1a2b3c4d5e6',
        containers: [
          {
            id: 'c1a2b3c4d5e6',
            labels: {
              'com.docker.compose.project': 'kpanel-smoke-run-001',
              'com.docker.compose.service': 'ingress', // Mismatched service label
              'io.kpanel.smoke-run-id': 'smoke-001'
            }
          }
        ]
      }),
      (err) => err instanceof ResourceBudgetError && err.code === 'SERVICE_LABEL_MISMATCH'
    );
  });

  // =========================================================================
  // 44. Phase 4C3D6HF: Corrected Compose build syntax, base image inspection & startup readiness
  // =========================================================================
  await t.test('44. Phase 4C3D6HF: Corrected Compose build syntax, base image inspection & startup readiness', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // 1. Corrected build syntax: boolean --pull flag does NOT take "never"
    assert.ok(!runbook.includes('--pull=never'), 'RUNBOOK must not contain invalid Boolean flag syntax --pull=never');
    assert.ok(runbook.includes('COMPOSE_PARALLEL_LIMIT=1'), 'RUNBOOK must retain COMPOSE_PARALLEL_LIMIT=1');
    assert.ok(runbook.includes('build candidate'), 'RUNBOOK must build candidate sequentially');
    assert.ok(runbook.includes('build ingress'), 'RUNBOOK must build ingress sequentially');

    // 2. Base image cache inspection and authorized retrieval
    assert.ok(runbook.includes('node:20-alpine'), 'RUNBOOK must document node:20-alpine');
    assert.ok(runbook.includes('nginxinc/nginx-unprivileged:alpine'), 'RUNBOOK must document nginx unprivileged image');
    assert.ok(runbook.includes('single authorized pull'), 'RUNBOOK must document single authorized pull for ingress base');
    assert.ok(runbook.includes('docker image inspect node:20-alpine'), 'RUNBOOK must inspect candidate base image in local cache');
    assert.ok(runbook.includes('Failing closed'), 'RUNBOOK must fail closed if unapproved pull is necessary');

    // 3. No false offline BuildKit build guarantee claim
    assert.ok(
      runbook.includes('A cached Docker image does NOT guarantee an offline BuildKit build'),
      'RUNBOOK must explicitly document that a cached Docker image does not guarantee an offline BuildKit build'
    );

    // 4. Corrected startup readiness command and options
    assert.ok(
      runbook.includes('up -d --no-build --pull never --wait --wait-timeout 60'),
      'RUNBOOK must start containers with --no-build, --pull never, --wait, and bounded --wait-timeout'
    );
    assert.ok(
      runbook.includes('PRESERVING RESOURCES FOR OPERATOR INSPECTION'),
      'RUNBOOK must preserve containers for operator inspection on startup failure without automatic cleanup'
    );

    // 5. Dockerfiles match approved base images
    const candidateDockerfile = fs.readFileSync(path.join(BUNDLE_DIR, 'candidate', 'Dockerfile'), 'utf8');
    const ingressDockerfile = fs.readFileSync(path.join(BUNDLE_DIR, 'ingress', 'Dockerfile'), 'utf8');
    assert.ok(candidateDockerfile.includes('FROM node:20-alpine'), 'Candidate must use node:20-alpine');
    assert.ok(ingressDockerfile.includes('FROM nginxinc/nginx-unprivileged:alpine'), 'Ingress must use nginxinc/nginx-unprivileged:alpine');
  });

  // =========================================================================
  // 45. Phase 4C3D6HF: Durable pre-mutation run journal, crash recovery & status transitions
  // =========================================================================
  await t.test('45. Phase 4C3D6HF: Durable pre-mutation run journal, crash recovery & status transitions', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 1: Persistent run metadata file written BEFORE first pull/build
    assert.ok(runbook.includes('staging-smoke-run.json'), 'RUNBOOK must write persistent metadata contract file');
    assert.ok(runbook.includes('chmod 600'), 'RUNBOOK must set restrictive chmod 600 on metadata contract file');
    assert.ok(runbook.includes('"executionStatus": "intent_recorded"'), 'RUNBOOK must record intent_recorded status before build');
    assert.ok(runbook.includes('"executionStatus": "images_built"'), 'RUNBOOK must update journal to images_built after build');
    assert.ok(runbook.includes('"executionStatus": "containers_running"'), 'RUNBOOK must update journal to containers_running after startup');

    // Item 2: Test createPreMutationRunJournal and validateRunMetadataContract
    const initialJournal = createPreMutationRunJournal({
      projectName: 'kpanel-smoke-20261023120000',
      smokeRunId: 'smoke-20261023120000',
      stagingDirectory: '/home/ubuntu/kpanel-disposable-staging/staging-smoke',
      loopbackPort: 18080,
      beforeStartContainersFile: '/home/ubuntu/kpanel-disposable-staging/before-start-containers.txt',
      beforeStartContainerIds: ['c1', 'c2'],
      baseImageReferences: ['node:20-alpine', 'nginxinc/nginx-unprivileged:alpine']
    });

    assert.equal(initialJournal.executionStatus, 'intent_recorded');
    assert.equal(initialJournal.candidateContainerId, null);
    assert.equal(initialJournal.ingressContainerId, null);
    assert.equal(initialJournal.stagingNetworkId, null);
    assert.deepEqual(initialJournal.baseImageReferences, ['node:20-alpine', 'nginxinc/nginx-unprivileged:alpine']);

    // Item 3: Status transition pipeline
    const builtJournal = updateRunJournalStatus(initialJournal, 'images_built');
    assert.equal(builtJournal.executionStatus, 'images_built');

    const runningJournal = updateRunJournalStatus(builtJournal, 'containers_running', {
      candidateContainerId: 'cand-001-id',
      ingressContainerId: 'ing-001-id',
      stagingNetworkId: 'net-001-id'
    });
    assert.equal(runningJournal.executionStatus, 'containers_running');
    assert.equal(runningJournal.candidateContainerId, 'cand-001-id');

    // Rejection of invalid status transition (e.g. from intent_recorded directly to verified)
    assert.throws(
      () => updateRunJournalStatus(initialJournal, 'verified'),
      (err) => err instanceof ResourceBudgetError && err.code === 'ILLEGAL_STATUS_TRANSITION'
    );

    // Item 4: Crash recovery support - cleanup recovers from interrupted state
    assert.ok(
      runbook.includes('label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}'),
      'RUNBOOK must rediscover resources via project label during crash recovery'
    );
    assert.ok(runbook.includes('OWNERSHIP CONFLICT'), 'RUNBOOK must stop on ownership conflict during cleanup');

    // Item 5: Project-scoped deletion only, no dangerous flags
    assert.ok(runbook.includes('docker compose -p "${COMPOSE_PROJECT_NAME}" down'), 'RUNBOOK must use project-scoped compose down');
    assert.ok(!runbook.includes('docker compose -p "${COMPOSE_PROJECT_NAME}" down --remove-orphans'), 'RUNBOOK must never use --remove-orphans');
    assert.ok(!runbook.includes('docker compose -p "${COMPOSE_PROJECT_NAME}" down --volumes'), 'RUNBOOK must never use --volumes');
    assert.ok(!runbook.includes('docker compose -p "${COMPOSE_PROJECT_NAME}" down -v'), 'RUNBOOK must never use -v');
  });

  // =========================================================================
  // 46. Phase 4C3D6H Regression 16-18: HTTP status checks, loopback port mapping, no false external unreachability claim
  // =========================================================================
  await t.test('46. Phase 4C3D6H Regression 16-18: HTTP status checking, loopback port mapping, no false external unreachability claim', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 16: HTTP checks inspecting status codes
    assert.ok(runbook.includes('-w "%{http_code}"'), 'RUNBOOK must check HTTP status code with -w "%{http_code}"');
    assert.ok(runbook.includes('[ "${ROOT_CODE}" = "200" ]'), 'RUNBOOK must verify HTTP 200 on /');
    assert.ok(runbook.includes('[ "${HEALTH_CODE}" = "200" ]'), 'RUNBOOK must verify HTTP 200 on /healthz');

    // Item 17: Loopback-only binding
    assert.ok(runbook.includes('127.0.0.1:${STAGING_INGRESS_PORT}'), 'RUNBOOK must enforce 127.0.0.1 binding');

    // Item 18: No false external unreachability claim from VPS public IP self-probing
    assert.ok(!runbook.includes('curl -m 2 "http://<oracle-vps-public-ip>'), 'RUNBOOK must not claim self-probing public IP proves external unreachability');
    assert.ok(runbook.includes('Hairpin routing on the host invalidates self-probing'), 'RUNBOOK must document hairpin NAT limitation');
  });

  // =========================================================================
  // 47. Phase 4C3D6H Regression 19-20: Pre-existing container ID comparison, zero production execution
  // =========================================================================
  await t.test('47. Phase 4C3D6H Regression 19-20: Pre-existing container ID comparison and zero production execution', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Item 19: Pre-existing container ID comparison (proves count matching alone is insufficient)
    assert.ok(runbook.includes('before-start-containers.txt'), 'RUNBOOK must track before-start container IDs');
    assert.ok(runbook.includes('while read -r CID'), 'RUNBOOK must iterate over individual pre-existing container IDs');

    // Test comparePreExistingContainerState
    const beforeIds = ['cont-prod-01', 'cont-prod-02', 'cont-prod-03'];

    // 1. All original IDs present and running: passes
    const passResult = comparePreExistingContainerState(beforeIds, [
      { id: 'cont-prod-01', state: 'running' },
      { id: 'cont-prod-02', state: 'running' },
      { id: 'cont-prod-03', state: 'running' }
    ]);
    assert.equal(passResult.preservationConfirmed, true);

    // 2. Count matches (3), but one ID is replaced (rogue container instead of original): throws
    assert.throws(
      () => comparePreExistingContainerState(beforeIds, [
        { id: 'cont-prod-01', state: 'running' },
        { id: 'cont-prod-02', state: 'running' },
        { id: 'cont-rogue-99', state: 'running' } // Mismatched ID!
      ]),
      (err) => err instanceof ResourceBudgetError && err.code === 'PRE_EXISTING_WORKLOAD_MUTATED'
    );

    // 3. One original container was stopped during test: throws
    assert.throws(
      () => comparePreExistingContainerState(beforeIds, [
        { id: 'cont-prod-01', state: 'running' },
        { id: 'cont-prod-02', state: 'exited' }, // Stopped container!
        { id: 'cont-prod-03', state: 'running' }
      ]),
      (err) => err instanceof ResourceBudgetError && err.code === 'PRE_EXISTING_WORKLOAD_MUTATED'
    );

    // Item 20: No real production execution
    assert.equal(process.env.KPANEL_RUNTIME_EXECUTION_ENABLED, undefined);
  });

  // =========================================================================
  // 48. Phase 4C3D6HF: Operator stage naming, authorization boundaries & file creation disclosures
  // =========================================================================
  await t.test('48. Phase 4C3D6HF: Operator stage naming, authorization boundaries & file creation disclosures', () => {
    const runbook = fs.readFileSync(path.join(BUNDLE_DIR, 'RUNBOOK.md'), 'utf8');

    // Stage A naming and accurate file creation disclosure (not strictly read-only, but zero Docker mutations)
    assert.ok(
      runbook.includes('STAGE A — AUTHORIZED ARTIFACT TRANSFER AND STATIC VERIFICATION; NO DOCKER MUTATIONS'),
      'RUNBOOK must define Stage A with accurate non-Docker-mutating label'
    );
    assert.ok(
      runbook.includes('Stage A creates files on the VPS through SCP and archive extraction'),
      'RUNBOOK must disclose that Stage A creates transfer files and extracts staging files'
    );
    assert.ok(
      runbook.includes('ZERO Docker daemon mutations, creates ZERO containers or images, and launches ZERO networks'),
      'RUNBOOK must certify zero Docker daemon mutations in Stage A'
    );

    // Stage B naming and explicit 5-point approval boundary
    assert.ok(
      runbook.includes('STAGE B — SEPARATELY APPROVED STAGING EXECUTION'),
      'RUNBOOK must define Stage B as requiring separate operator approval'
    );
    assert.ok(runbook.includes('Exact base-image pulls'), 'Stage B must explicitly cover exact base-image pulls');
    assert.ok(runbook.includes('Two sequential image builds'), 'Stage B must explicitly cover two sequential image builds');
    assert.ok(runbook.includes('Creation of two containers'), 'Stage B must explicitly cover creation of two containers');
    assert.ok(runbook.includes('Creation of one Compose-owned bridge network'), 'Stage B must explicitly cover creation of one Compose bridge');
    assert.ok(runbook.includes('Loopback port publication'), 'Stage B must explicitly cover loopback port publication');

    // Cleanup requires another explicit confirmation
    assert.ok(
      runbook.includes('Destructive cleanup operations require **separate, explicit operator confirmation**'),
      'RUNBOOK must require explicit operator confirmation for cleanup'
    );
    assert.ok(
      runbook.includes('Confirm project-scoped teardown'),
      'RUNBOOK must prompt operator interactively before any resource deletion'
    );
  });
});
