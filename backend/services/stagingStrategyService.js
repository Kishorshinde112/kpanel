const crypto = require('crypto');

/**
 * Structured error class for Staging Strategy operations.
 */
class StagingStrategyError extends Error {
  constructor(message, code, details = null) {
    super(message);
    this.name = 'StagingStrategyError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Strategy identifiers
 */
const STRATEGIES = Object.freeze({
  ISOLATED_LOOPBACK_STAGING: 'isolated-loopback-staging',
  SHARED_TRAEFIK_PRODUCTION: 'shared-traefik-production'
});

/**
 * Reserved or sensitive host ports that staging ingress MUST NEVER bind to.
 */
const PROHIBITED_HOST_PORTS = Object.freeze([
  22,    // SSH
  53,    // DNS
  80,    // HTTP (Dokploy Traefik / Production)
  443,   // HTTPS (Dokploy Traefik / Production)
  2375,  // Docker unencrypted daemon
  2376,  // Docker TLS daemon
  2377,  // Docker Swarm cluster management
  3000,  // Existing candidate / Web frontend default
  3030,  // Existing kpanel-frontend-1 host port
  4222,  // NATS
  5000,  // Docker registry default
  5001,  // Existing kpanel-backend-1 host port
  5678,  // n8n workflow engine
  7946,  // Docker Swarm overlay network node communication
  4789,  // Docker Swarm overlay VXLAN
  8080,  // Dokploy Traefik dashboard / alternate HTTP
  9000,  // Portainer / Docker management
  9443   // Portainer TLS
]);

/**
 * Protected existing container names and compose projects observed on the real Oracle VPS.
 * Under no circumstances may K-Panel recreate, adopt, or collide with these.
 */
const PROTECTED_EXISTING_WORKLOADS = Object.freeze([
  'kpanel-frontend-1',
  'kpanel-backend-1',
  'dokploy-traefik',
  'traefik',
  'caddy',
  'nginx',
  'n8n'
]);

const PROTECTED_COMPOSE_PROJECTS = Object.freeze([
  'kpanel',
  'kpanel-clean',
  'dokploy'
]);

/**
 * Validates an operator-selected loopback port for staging ingress.
 * Enforces:
 * - Must be an integer between 1024 and 65535.
 * - Rejects privileged ports (< 1024).
 * - Rejects host binding addresses other than 127.0.0.1 (rejects 0.0.0.0, ::, public IPs).
 * - Rejects occupied or reserved system/host ports.
 *
 * @param {any} port - Port number or string
 * @param {Object} [options] - Options ({ hostIp, occupiedPorts })
 * @returns {Object} Validated loopback port binding specification
 */
function validateLoopbackPort(port, options = {}) {
  if (port === undefined || port === null || port === '') {
    throw new StagingStrategyError('Staging ingress loopback port is required.', 'PORT_REQUIRED');
  }

  let num;
  if (typeof port === 'number') {
    num = port;
  } else if (typeof port === 'string') {
    if (!/^\d+$/.test(port.trim())) {
      throw new StagingStrategyError(`Port "${port}" is not a valid integer.`, 'INVALID_PORT');
    }
    num = parseInt(port.trim(), 10);
  } else {
    throw new StagingStrategyError('Port must be an integer between 1024 and 65535.', 'INVALID_PORT');
  }

  if (!Number.isInteger(num)) {
    throw new StagingStrategyError(`Port "${port}" is not an integer.`, 'INVALID_PORT');
  }

  // Reject privileged ports (< 1024)
  if (num < 1024) {
    throw new StagingStrategyError(
      `Privileged port ${num} (< 1024) cannot be chosen for staging ingress. High port (>= 1024) required.`,
      'PRIVILEGED_PORT_PROHIBITED',
      { port: num }
    );
  }

  if (num > 65535) {
    throw new StagingStrategyError(
      `Port ${num} exceeds maximum TCP port 65535.`,
      'INVALID_PORT',
      { port: num }
    );
  }

  // Host IP binding validation: strictly 127.0.0.1
  const hostIp = options.hostIp || '127.0.0.1';
  if (hostIp !== '127.0.0.1') {
    throw new StagingStrategyError(
      `Staging ingress must bind strictly to loopback 127.0.0.1. Public or wildcard binding (${hostIp}) is prohibited.`,
      'NON_LOOPBACK_BINDING_PROHIBITED',
      { hostIp }
    );
  }

  // Check against prohibited system ports
  if (PROHIBITED_HOST_PORTS.includes(num)) {
    throw new StagingStrategyError(
      `Port ${num} is a reserved system or known service port. Staging ingress must use an unreserved high port.`,
      'PROHIBITED_HOST_PORT',
      { port: num }
    );
  }

  // Check against occupied host ports (from inventory or options)
  const occupied = Array.isArray(options.occupiedPorts) ? options.occupiedPorts : [];
  if (occupied.includes(num)) {
    throw new StagingStrategyError(
      `Port ${num} is already occupied by a running service on the host.`,
      'PORT_ALREADY_OCCUPIED',
      { port: num, occupiedPorts: occupied }
    );
  }

  return {
    valid: true,
    hostIp: '127.0.0.1',
    port: num,
    bindingString: `127.0.0.1:${num}`
  };
}

/**
 * Validates Compose project namespace and service naming to prevent collisions
 * with running production or legacy test workloads.
 *
 * @param {string} projectName - Candidate Compose project name
 * @param {Object} [options] - Options ({ candidateName, ingressName })
 * @returns {Object} Validated naming specification
 */
function validateStagingNamespace(projectName, options = {}) {
  const cleanProject = String(projectName || 'kpanel-staging').trim().toLowerCase();

  if (!cleanProject) {
    throw new StagingStrategyError('Compose project name cannot be empty.', 'INVALID_PROJECT_NAME');
  }

  // Prevent collision with existing Compose projects on the VPS
  for (const protectedProj of PROTECTED_COMPOSE_PROJECTS) {
    if (cleanProject === protectedProj) {
      throw new StagingStrategyError(
        `Compose project name "${cleanProject}" collides with existing protected project. Unique staging namespace required.`,
        'PROJECT_NAME_COLLISION',
        { project: cleanProject }
      );
    }
  }

  // Validate container names if provided
  const candidateName = options.candidateName ? String(options.candidateName).trim().toLowerCase() : null;
  const ingressName = options.ingressName ? String(options.ingressName).trim().toLowerCase() : null;

  for (const protectedName of PROTECTED_EXISTING_WORKLOADS) {
    if (candidateName && candidateName === protectedName) {
      throw new StagingStrategyError(
        `Candidate container name "${candidateName}" collides with existing protected container "${protectedName}".`,
        'CONTAINER_NAME_COLLISION',
        { name: candidateName }
      );
    }
    if (ingressName && ingressName === protectedName) {
      throw new StagingStrategyError(
        `Ingress container name "${ingressName}" collides with existing protected container "${protectedName}".`,
        'CONTAINER_NAME_COLLISION',
        { name: ingressName }
      );
    }
  }

  return {
    valid: true,
    projectName: cleanProject,
    candidateName,
    ingressName
  };
}

/**
 * Plans an isolated loopback staging ingress topology.
 * Invariants:
 * 1. Dedicated K-Panel staging bridge network.
 * 2. K-Panel candidate container has ZERO published host ports.
 * 3. Ingress component binds strictly to loopback 127.0.0.1 on operator-verified high port.
 * 4. Zero Dokploy network attachment.
 * 5. Zero production Traefik dynamic file modifications.
 * 6. Zero DNS or Cloudflare Tunnel changes.
 * 7. Zero arbitrary host bind mounts.
 *
 * @param {Object} input - Planning input
 * @param {Object} [options] - Planning options
 * @returns {Object} Structured isolated staging ingress plan
 */
function planIsolatedStagingIngress(input, options = {}) {
  if (!input || typeof input !== 'object') {
    throw new StagingStrategyError('Staging ingress planning input is required.', 'INVALID_INPUT');
  }

  const {
    applicationId,
    deploymentId,
    candidateContainerId,
    candidatePort = 3000,
    stagingNetworkId,
    loopbackPort,
    composeProjectName = 'kpanel-staging'
  } = input;

  if (!applicationId || typeof applicationId !== 'string') {
    throw new StagingStrategyError('Valid application ID is required.', 'INVALID_APPLICATION_ID');
  }

  if (!deploymentId || typeof deploymentId !== 'string') {
    throw new StagingStrategyError('Valid deployment ID is required.', 'INVALID_DEPLOYMENT_ID');
  }

  if (!candidateContainerId || typeof candidateContainerId !== 'string') {
    throw new StagingStrategyError('Candidate container identifier is required.', 'INVALID_CONTAINER_ID');
  }

  const portNum = parseInt(candidatePort, 10);
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) {
    throw new StagingStrategyError(`Candidate port must be between 1 and 65535 (received: ${candidatePort}).`, 'INVALID_PORT');
  }

  // 1. Validate Loopback Ingress Port
  const validatedPort = validateLoopbackPort(loopbackPort, options);

  // 2. Validate Namespace & Names
  const shortDepId = deploymentId.trim().slice(0, 8);
  const plannedCandidateName = `kpanel-staging-candidate-${shortDepId}`;
  const plannedIngressName = `kpanel-staging-ingress-${shortDepId}`;

  validateStagingNamespace(composeProjectName, {
    candidateName: plannedCandidateName,
    ingressName: plannedIngressName
  });

  // 3. Dedicated Staging Network Validation
  const networkName = String(stagingNetworkId || options.stagingNetworkName || 'kpanel-staging-net').trim();
  const lowerNet = networkName.toLowerCase();

  // Reject foreign or production networks
  if (lowerNet.includes('dokploy') || lowerNet.includes('n8n') || lowerNet === 'bridge' || lowerNet === 'host') {
    throw new StagingStrategyError(
      `Network "${networkName}" is a foreign or system network. Dedicated K-Panel staging bridge required.`,
      'FORBIDDEN_STAGING_NETWORK',
      { network: networkName }
    );
  }

  // 4. SSH Tunnel Command Template
  const sshTunnelCommand = `ssh -N -L ${validatedPort.port}:127.0.0.1:${validatedPort.port} <operator-user>@<oracle-vps-ip>`;

  // 5. Build Complete Plan
  return {
    strategy: STRATEGIES.ISOLATED_LOOPBACK_STAGING,
    status: 'planned',
    applicationId: applicationId.trim(),
    deploymentId: deploymentId.trim(),
    composeProjectName: composeProjectName.trim(),
    candidate: {
      containerId: candidateContainerId.trim(),
      containerName: plannedCandidateName,
      internalPort: portNum,
      publishedPorts: [], // STRICT: Zero published host ports
      networkAttachment: networkName,
      hasPublishedPorts: false
    },
    ingress: {
      containerName: plannedIngressName,
      ingressType: 'kpanel-isolated-ingress',
      hostBinding: validatedPort.bindingString,
      hostIp: validatedPort.hostIp,
      hostPort: validatedPort.port,
      internalIngressPort: 80,
      upstreamUrl: `http://${plannedCandidateName}:${portNum}`,
      networkAttachment: networkName
    },
    network: {
      name: networkName,
      driver: 'bridge',
      isDokployOverlay: false,
      isDefaultBridge: false
    },
    accessModel: {
      mode: 'ssh-tunnel-loopback',
      targetUrl: `http://127.0.0.1:${validatedPort.port}`,
      sshTunnelCommand,
      publicDnsRequired: false,
      publicTlsRequired: false,
      productionTraefikModified: false
    },
    productionIsolation: {
      dokployTraefikUntouched: true,
      cloudflareTunnelUntouched: true,
      productionPortsUntouched: true,
      existingKpanelContainersPreserved: true
    },
    createdAt: new Date().toISOString()
  };
}

/**
 * Assesses the feasibility of staging and production strategies against
 * a real or mock host inventory report.
 *
 * @param {Object} inventory - Ingested host inventory report
 * @param {Object} [options] - Options ({ operatorSelectedPort, approvedStagingNetwork })
 * @returns {Object} Strategy feasibility assessment report
 */
function assessHostTopologyForStaging(inventory, options = {}) {
  if (!inventory || typeof inventory !== 'object') {
    throw new StagingStrategyError('Valid host inventory report is required.', 'INVALID_INVENTORY');
  }

  const blockers = [];
  const warnings = [];
  const occupiedPorts = [];

  // 1. Gather Occupied Host Ports from Running Containers and Networks
  const containers = Array.isArray(inventory.containers) ? inventory.containers : [];
  for (const c of containers) {
    if (Array.isArray(c.ports)) {
      for (const p of c.ports) {
        if (p.hostPort) occupiedPorts.push(p.hostPort);
        if (p.publicPort) occupiedPorts.push(p.publicPort);
      }
    }
  }

  // Also include inventory hostPorts if present
  if (Array.isArray(inventory.hostPorts)) {
    for (const hp of inventory.hostPorts) {
      const p = typeof hp === 'number' ? hp : parseInt(hp.port || hp, 10);
      if (Number.isInteger(p)) occupiedPorts.push(p);
    }
  }

  // 2. Identify Docker Swarm Mode
  const isSwarmActive = Boolean(
    inventory.hostIdentity?.dockerSwarmActive ||
    inventory.dockerInfo?.Swarm?.LocalNodeState === 'active' ||
    inventory.swarm?.active
  );

  // 3. Identify Dokploy & Traefik Presence
  const traefik = inventory.traefik || {};
  const isDokployPresent = Boolean(
    containers.some((c) => String(c.name || '').includes('dokploy')) ||
    (Array.isArray(inventory.networks) && inventory.networks.some((n) => String(n.name || '').includes('dokploy')))
  );

  // 4. Identify Existing K-Panel Workloads
  const existingKpanelContainers = containers.filter((c) => {
    const name = String(c.name || '').toLowerCase();
    return name.includes('kpanel') && !name.includes('staging');
  }).map((c) => c.name);

  // 5. Inspect Staging Network Availability
  const networks = Array.isArray(inventory.networks) ? inventory.networks : [];
  const candidateStagingNet = networks.find((n) =>
    n.name === 'kpanel-staging-net' ||
    n.name === 'kpanel_staging_net' ||
    (options.approvedStagingNetwork && (n.id === options.approvedStagingNetwork || n.name === options.approvedStagingNetwork))
  );

  const stagingNetworkExists = Boolean(candidateStagingNet);
  if (!stagingNetworkExists) {
    blockers.push({
      code: 'MISSING_STAGING_NETWORK',
      message: 'No approved dedicated K-Panel staging bridge network exists on host. Separate approval required to create network.'
    });
  }

  // 6. Check Loopback Port Selection
  let loopbackPortAssessment = null;
  if (options.operatorSelectedPort) {
    try {
      const portValidation = validateLoopbackPort(options.operatorSelectedPort, {
        occupiedPorts
      });
      loopbackPortAssessment = {
        selectedPort: portValidation.port,
        valid: true,
        binding: portValidation.bindingString
      };
    } catch (portErr) {
      blockers.push({
        code: portErr.code || 'INVALID_LOOPBACK_PORT',
        message: portErr.message
      });
      loopbackPortAssessment = {
        selectedPort: options.operatorSelectedPort,
        valid: false,
        error: portErr.message
      };
    }
  } else {
    warnings.push({
      code: 'LOOPBACK_PORT_NOT_SELECTED',
      message: 'Operator must select and verify a free loopback high port (e.g., 18080) for staging ingress.'
    });
  }

  // 7. Evaluate Shared Traefik Production Strategy
  const sharedTraefikStatus = {
    strategy: STRATEGIES.SHARED_TRAEFIK_PRODUCTION,
    status: 'BLOCKED_UNVERIFIED',
    decision: 'INTEGRATION_DEFERRED',
    reasons: [
      'Dokploy-managed Traefik v3.6.7 owns host ingress ports 80/443.',
      'Traefik File provider dynamic configuration directory is owned by Dokploy.',
      'File provider watch/activation is unverified on the live VPS.',
      'Candidate containers cannot safely join dokploy-network Swarm overlay or dokploy bridge.',
      'Direct Traefik integration risks production routing collision with 45 existing workloads.'
    ],
    prerequisitesForFutureConsideration: [
      'Operator verification of Traefik File provider watch capability.',
      'Dedicated bridge network attachment for Traefik without joining Dokploy internal networks.',
      'Formal domain ownership authorization for public routing.'
    ]
  };

  // 8. Evaluate Isolated Loopback Staging Strategy
  const isolatedLoopbackStatus = {
    strategy: STRATEGIES.ISOLATED_LOOPBACK_STAGING,
    status: blockers.length === 0 ? 'READY_FOR_OFFLINE_SPEC' : 'FEASIBLE_PENDING_PREREQUISITES',
    isPreferredStrategy: true,
    blockers,
    warnings,
    loopbackPortAssessment,
    protectedWorkloads: existingKpanelContainers,
    hostSummary: {
      isSwarmActive,
      isDokployPresent,
      totalRunningContainers: containers.length,
      stagingNetworkExists,
      stagingNetworkId: candidateStagingNet?.id || null
    }
  };

  return {
    assessedAt: new Date().toISOString(),
    strategies: {
      [STRATEGIES.ISOLATED_LOOPBACK_STAGING]: isolatedLoopbackStatus,
      [STRATEGIES.SHARED_TRAEFIK_PRODUCTION]: sharedTraefikStatus
    },
    recommendedAction: 'Proceed with isolated loopback staging plan only; keep production Traefik integration strictly blocked.'
  };
}

/**
 * Generates an operator-reviewable, non-production Compose specification (YAML and Object).
 * Strictly guarantees:
 * - Unique Compose project namespace ('kpanel-staging')
 * - No container name collisions with existing kpanel-frontend-1 / kpanel-backend-1
 * - Candidate has NO published ports (exposes internal port only)
 * - Ingress binds ONLY to 127.0.0.1:<loopbackPort>
 * - Dedicated bridge network (no Dokploy overlay, no default bridge)
 * - Resource limits and security limits (no-new-privileges, cap-drop ALL, read-only rootfs)
 * - Bounded log rotation
 * - Zero docker socket mounts
 * - Zero /home/ubuntu mounts
 * - restart: "no"
 * - Zero live execution (pure specification)
 *
 * @param {Object} planInput - Input for Compose spec generation
 * @param {Object} [options] - Options ({ cpuLimit, memoryLimitMb, ingressImage })
 * @returns {Object} { composeObject, composeYaml, summary }
 */
function generateOfflineStagingComposeSpec(planInput, options = {}) {
  const plan = planIsolatedStagingIngress(planInput, options);

  const candidatePort = plan.candidate.internalPort;
  const loopbackPort = plan.ingress.hostPort;
  const projectName = plan.composeProjectName;
  const candidateName = plan.candidate.containerName;
  const ingressName = plan.ingress.containerName;
  const networkName = plan.network.name;

  const cpuLimit = options.cpuLimit || '1.0';
  const memoryLimitMb = options.memoryLimitMb || 1024;
  const ingressCpuLimit = options.ingressCpuLimit || '0.5';
  const ingressMemoryMb = options.ingressMemoryMb || 256;
  const candidateImage = options.candidateImage || `kpanel/app-${plan.applicationId}:d-${plan.deploymentId.slice(0, 8)}`;
  const ingressImage = options.ingressImage || 'caddy:2-alpine';

  // Construct structured Compose Object
  const composeObject = {
    name: projectName,
    services: {
      candidate: {
        image: candidateImage,
        container_name: candidateName,
        restart: 'no',
        networks: [networkName],
        expose: [String(candidatePort)],
        // STRICT: Zero published host ports!
        ports: [],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        read_only: true,
        tmpfs: ['/tmp:rw,noexec,nosuid,size=64m'],
        deploy: {
          resources: {
            limits: {
              cpus: String(cpuLimit),
              memory: `${memoryLimitMb}M`
            }
          }
        },
        pids_limit: 256,
        logging: {
          driver: 'json-file',
          options: {
            'max-size': '10m',
            'max-file': '3'
          }
        },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'staging-candidate',
          'io.kpanel.application-id': plan.applicationId,
          'io.kpanel.deployment-id': plan.deploymentId
        },
        volumes: [] // STRICT: Zero host bind mounts, zero docker.sock
      },
      'staging-ingress': {
        image: ingressImage,
        container_name: ingressName,
        restart: 'no',
        networks: [networkName],
        // STRICT: Loopback only binding!
        ports: [`127.0.0.1:${loopbackPort}:80`],
        security_opt: ['no-new-privileges:true'],
        cap_drop: ['ALL'],
        deploy: {
          resources: {
            limits: {
              cpus: String(ingressCpuLimit),
              memory: `${ingressMemoryMb}M`
            }
          }
        },
        pids_limit: 128,
        logging: {
          driver: 'json-file',
          options: {
            'max-size': '5m',
            'max-file': '2'
          }
        },
        labels: {
          'traefik.enable': 'false',
          'io.kpanel.managed': 'true',
          'io.kpanel.role': 'staging-ingress',
          'io.kpanel.application-id': plan.applicationId
        },
        volumes: [] // STRICT: Zero docker.sock, zero arbitrary host mounts
      }
    },
    networks: {
      [networkName]: {
        name: networkName,
        driver: 'bridge',
        external: true // Operator must provision network explicitly with separate approval
      }
    }
  };

  // Generate deterministic YAML representation without external dependencies
  const yamlLines = [
    `# ==============================================================================`,
    `# K-PANEL ISOLATED STAGING COMPOSE SPECIFICATION (OFFLINE DRY-RUN ONLY)`,
    `# Mode: isolated-loopback-staging`,
    `# Generated: ${new Date().toISOString()}`,
    `# Invariants: Zero host ports on candidate; loopback-only staging ingress;`,
    `#            zero Dokploy network membership; zero production Traefik writes.`,
    `# ==============================================================================`,
    `name: ${projectName}`,
    ``,
    `services:`,
    `  candidate:`,
    `    image: ${candidateImage}`,
    `    container_name: ${candidateName}`,
    `    restart: "no"`,
    `    networks:`,
    `      - ${networkName}`,
    `    expose:`,
    `      - "${candidatePort}"`,
    `    # Strict invariant: candidate container has NO published host ports`,
    `    ports: []`,
    `    security_opt:`,
    `      - "no-new-privileges:true"`,
    `    cap_drop:`,
    `      - ALL`,
    `    read_only: true`,
    `    tmpfs:`,
    `      - "/tmp:rw,noexec,nosuid,size=64m"`,
    `    deploy:`,
    `      resources:`,
    `        limits:`,
    `          cpus: "${cpuLimit}"`,
    `          memory: "${memoryLimitMb}M"`,
    `    pids_limit: 256`,
    `    logging:`,
    `      driver: "json-file"`,
    `      options:`,
    `        max-size: "10m"`,
    `        max-file: "3"`,
    `    labels:`,
    `      traefik.enable: "false"`,
    `      io.kpanel.managed: "true"`,
    `      io.kpanel.role: "staging-candidate"`,
    `      io.kpanel.application-id: "${plan.applicationId}"`,
    `      io.kpanel.deployment-id: "${plan.deploymentId}"`,
    `    volumes: []`,
    ``,
    `  staging-ingress:`,
    `    image: ${ingressImage}`,
    `    container_name: ${ingressName}`,
    `    restart: "no"`,
    `    networks:`,
    `      - ${networkName}`,
    `    ports:`,
    `      - "127.0.0.1:${loopbackPort}:80"`,
    `    security_opt:`,
    `      - "no-new-privileges:true"`,
    `    cap_drop:`,
    `      - ALL`,
    `    deploy:`,
    `      resources:`,
    `        limits:`,
    `          cpus: "${ingressCpuLimit}"`,
    `          memory: "${ingressMemoryMb}M"`,
    `    pids_limit: 128`,
    `    logging:`,
    `      driver: "json-file"`,
    `      options:`,
    `        max-size: "5m"`,
    `        max-file: "2"`,
    `    labels:`,
    `      traefik.enable: "false"`,
    `      io.kpanel.managed: "true"`,
    `      io.kpanel.role: "staging-ingress"`,
    `    volumes: []`,
    ``,
    `networks:`,
    `  ${networkName}:`,
    `    name: ${networkName}`,
    `    driver: bridge`,
    `    external: true`,
    ``
  ];

  const composeYaml = yamlLines.join('\n');

  return {
    plan,
    composeObject,
    composeYaml,
    summary: {
      strategy: STRATEGIES.ISOLATED_LOOPBACK_STAGING,
      projectName,
      candidateName,
      ingressName,
      loopbackBinding: `127.0.0.1:${loopbackPort}`,
      networkName,
      candidatePort,
      sshTunnelCommand: plan.accessModel.sshTunnelCommand,
      isOfflineDryRun: true,
      executed: false
    }
  };
}

module.exports = {
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
};
