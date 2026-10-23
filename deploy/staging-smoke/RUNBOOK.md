# K-PANEL OPERATOR RUNBOOK: DISPOSABLE STAGING SMOKE TEST (PHASE 4C3D6H)

**Target Host:** Oracle Cloud Infrastructure Ampere A1 (Ubuntu 24.04 LTS ARM64, 4 OCPU, ~23 GiB RAM, ~50 GB available disk, 45 existing workloads)  
**Host Daemon Versions:** Docker Engine 29.1.3, Docker Compose v5.1.0, Buildx v0.31.1  
**Execution Status:** LOCAL OFFLINE REFACTORING & STATIC VALIDATION ONLY.  
**AUTHORIZATION NOTICE:** Live Oracle VPS testing is NOT authorized in this turn. Do not execute operations that create Docker resources, build images, or mutate the VPS without explicit, separate operator approval. Commands in Sections A through E are provided as technical examples for future operator review only.

---

## 1. Architectural Scope and Mission Boundaries

This runbook establishes the operator-controlled procedure for transferring, verifying, and running a disposable, isolated staging smoke-test stack (`deploy/staging-smoke/`) on an Oracle ARM64 host without impacting:
- Dokploy core and Dokploy-managed Traefik v3.6.7 (ports 80/443).
- Existing legacy K-Panel containers (`kpanel-frontend-1`, `kpanel-backend-1` on `kpanel-clean_kpanel_net`).
- n8n automation workflow engine (port 5678).
- Production domain DNS, ACME TLS certificates, or Cloudflare Tunnels.

**Scope Limits:**
- No production deployment.
- No GitHub auto-deployment.
- No Traefik router or middleware modifications.
- No unattended cleanup scripts.
- No remote Docker execution from local workstation.

---

## 2. Invariants and Architectural Guarantees

1. **Exact, Unique Compose Project Identity:** Every smoke run must use an exact, unique Compose project namespace (e.g. `kpanel-smoke-<timestamp>`). Naming collisions with `kpanel`, `kpanel-clean`, `dokploy`, or `n8n` are strictly prohibited.
2. **Dedicated Bridge Network:** Compose owns an isolated bridge network (`<project>_staging_net`). Zero attachment to `dokploy-network` Swarm overlay or the default Docker bridge.
3. **Loopback-Only Ingress:** The staging ingress binds exclusively to `127.0.0.1:<port>:8080`. Binding to `0.0.0.0`, `::`, or public IPs is prohibited.
4. **Zero Candidate Host Ports:** The candidate container exposes its internal port strictly within the staging bridge; it has zero published host ports (`ports: []`).
5. **No Docker Socket Access:** Neither container mounts `/var/run/docker.sock` in any mode (`:rw` or `:ro`).
6. **No Production Traefik Exposure:** Both services declare `traefik.enable=false`.
7. **Strict Privilege Boundaries:** Both containers enforce `cap_drop: [ALL]`, `security_opt: ["no-new-privileges:true"]`, `read_only: true`, and unprivileged non-root UIDs.
8. **Stateless Candidate:** Pure in-memory HTTP server, zero database dependencies, zero credentials or secrets.
9. **No Dangerous Pruning Operations:** Commands including `docker system prune`, `docker image prune`, `docker builder prune`, `docker volume prune`, `--remove-orphans`, and `--volumes` are strictly prohibited.

---

## 3. Network Isolation Review: `internal: true` vs. Loopback Port Forwarding

In Docker bridge networking, setting `internal: true` configures Linux netfilter (`iptables`/`nftables`) rules to drop packets traversing the bridge interface from external or host interfaces.

### Operational Review & Live Docker Verification Status:
- **UNVERIFIED AT RUNTIME:** The behavior where `internal: true` blocks loopback port publishing (`-p 127.0.0.1:<port>:<container_port>`) is a documented Docker forwarding characteristic, but it **requires live Docker verification on the target Oracle VPS** and must NOT be treated as a universal assumption across all Linux kernel/iptables configurations.
- **Bridge Network Selection:** To reliably permit host loopback ingress via `-p 127.0.0.1:18080:8080`, the dedicated staging bridge currently omits `internal: true`.
- **Potential Outbound Network Access:** Because the bridge is non-internal, containers attached to it could potentially initiate outbound connections (e.g. DNS or HTTP to the public internet) unless constrained by host firewall rules. However:
  1. The candidate container has **zero published host ports** and makes zero external API/DNS calls.
  2. The ingress container proxies strictly to `candidate:8080` and initiates no external calls.
  3. Neither container joins `dokploy-network` or any existing application network.
- **Strict Rule:** No host firewall changes or network creations are permitted in this phase.

---

## 4. Container Startup Compatibility & Restriction Review

Static review of whether both disposable containers can initialize under the specified sandbox restrictions:

| Restriction | Candidate Application | Ingress Reverse Proxy | Status |
| :--- | :--- | :--- | :--- |
| **User & UID** | `USER node` (UID 1000: node) | `user: "101:101"` (nginx unprivileged) | Compatible |
| **Port Privilege** | Listens on internal port `8080` (>= 1024) | Listens on internal port `8080` (>= 1024) | Compatible (no `CAP_NET_BIND_SERVICE` needed) |
| **Read-Only Rootfs** | `read_only: true` (zero filesystem writes) | `read_only: true` (all cache/pid/temp on tmpfs) | Compatible |
| **Writable Paths** | Tmpfs on `/tmp` (`size=64m,noexec,nosuid`) | Tmpfs on `/tmp`, `/var/cache/nginx`, `/var/run` | Compatible |
| **PID File Location** | Process runs directly under PID 1 | Explicitly set to `/tmp/nginx.pid` in `nginx.conf` | Compatible |
| **Privileges Dropped** | `cap_drop: [ALL]`, `no-new-privileges:true` | `cap_drop: [ALL]`, `no-new-privileges:true` | Compatible |
| **HEALTHCHECK Probe** | `wget -qO- http://127.0.0.1:8080/healthz` | `wget -qO- http://127.0.0.1:8080/healthz` | Compatible (BusyBox `wget` built into Alpine) |
| **ARM64 Compatibility**| `node:20-alpine` (multi-arch / arm64 cached) | `nginxinc/nginx-unprivileged:alpine` (arm64) | Compatible |
| **Startup Order** | Starts first; exposes `/healthz` | `depends_on: candidate: condition: service_healthy` | Safe startup sequence |
| **Pre-Health Ingress**| N/A | Does not start until candidate is healthy | Prevents 502/DNS lookup failure |

**CRITICAL NOTICE ON RUNTIME COMPATIBILITY:**  
While static analysis verifies configuration consistency, actual process startup under combined `read_only: true`, `cap_drop: [ALL]`, and `no-new-privileges:true` on the specific Oracle Linux 6.8+ kernel is **UNVERIFIED until an authorized live test occurs**. Static validation does not prove runtime execution success.

---

## 5. Candidate-to-Ingress Port Consistency Guarantee

- **Fixed Internal Port (8080):** For disposable staging smoke testing, candidate HTTP server, Nginx upstream, Dockerfile `EXPOSE`, container healthchecks, and Compose port definitions are fixed to internal port `8080`.
- **No Ingress Routing Breakage:** The Nginx upstream is strictly configured to `server candidate:8080;`. Changing `APP_PORT` in environment without a synchronized, validated upstream update is blocked by static preflight validation.
- **No Arbitrary Upstreams:** Upstream hosts other than `candidate` (e.g. external IPs, localhost, foreign hostnames) are strictly prohibited and blocked by the bundle validator.

---

## 6. Resource Headroom and Image Build Safety

### Build Side Effects & Concurrency Policy:
1. **Explicit Build Concurrency:** Concurrency is clamped to **1** maximum via `COMPOSE_PARALLEL_LIMIT=1` and sequential service build invocations (`docker compose build candidate`, then `docker compose build ingress`).
2. **Daemon-Level Resource Consumption:** Container CPU and RAM limits (`deploy.resources.limits`) **do not automatically constrain image builds**. Docker daemon and BuildKit build processes execute on the host outside container cgroups.
3. **Headroom Verification:** Host available disk and memory must be verified immediately before build dispatch. A minimum of **12 GB free disk** on root (`/`) and **8 GB memory reserve** for existing workloads is required.
4. **Base Image Cache State:**
   - Candidate: `node:20-alpine` is confirmed cached on the Oracle host (`linux/arm64`). Zero network pull required.
   - Ingress: `nginxinc/nginx-unprivileged:alpine` is confirmed not cached on Oracle. A single approved pull of this official base image (`linux/arm64`) will be required during build.
5. **No BuildKit Pruning:** Global `docker builder prune` is strictly prohibited to avoid deleting cached layers belonging to existing applications.
6. **Expected Image Provenance:** Built images must be tagged with exact project or smoke-run identifiers:
   - Candidate: `kpanel-smoke-candidate:<SMOKE_RUN_ID>`
   - Ingress: `kpanel-smoke-ingress:<SMOKE_RUN_ID>`

---

## STAGE A — AUTHORIZED ARTIFACT TRANSFER AND STATIC VERIFICATION; NO DOCKER MUTATIONS

**Operational Scope:** Stage A creates files on the VPS through SCP and archive extraction (`REMOTE_DEST_DIR` and `REMOTE_STAGING_DIR`). **It is not strictly read-only**, but performs **ZERO Docker daemon mutations, creates ZERO containers or images, and launches ZERO networks.**

### SECTION A: LOCAL WORKSTATION — PACKAGE VERIFICATION AND TRANSFER

**Execution Location:** Local Operator Workstation ONLY. Do NOT run Docker commands in this section against the VPS.

```bash
# ------------------------------------------------------------------------------
# A.1. Verify Local Archive Integrity & SHA-256 Checksum on Workstation
# ------------------------------------------------------------------------------
cd /path/to/kpanel/deploy

# Compute and verify SHA-256 manifest
sha256sum -c kpanel-staging-smoke-bundle.tar.gz.sha256
# Expected output: kpanel-staging-smoke-bundle.tar.gz: OK

# Inspect archive paths: exactly 8 files, all relative under staging-smoke/
tar -tzf kpanel-staging-smoke-bundle.tar.gz
# Verify: zero leading slashes, zero traversal entries (..), zero symlinks

# ------------------------------------------------------------------------------
# A.2. Define Target Server Parameters & Operator Confirmation
# ------------------------------------------------------------------------------
ORACLE_HOST="<oracle-vps-ip>"
# Operator must confirm the remote username (e.g. ubuntu)
TARGET_USER="${TARGET_USER:-ubuntu}"
REMOTE_DEST_DIR="/home/${TARGET_USER}/kpanel-staging-transfer"

# ------------------------------------------------------------------------------
# A.3. Transfer Archive and Manifest to Oracle VPS
# ------------------------------------------------------------------------------
ssh "${TARGET_USER}@${ORACLE_HOST}" "mkdir -p '${REMOTE_DEST_DIR}' && chmod 700 '${REMOTE_DEST_DIR}'"
scp kpanel-staging-smoke-bundle.tar.gz kpanel-staging-smoke-bundle.tar.gz.sha256 \
  "${TARGET_USER}@${ORACLE_HOST}:${REMOTE_DEST_DIR}/"
```

---

### SECTION B: ORACLE VPS — ARCHIVE VERIFICATION, EXTRACTION AND STATIC CHECKS

**Execution Location:** Remote Oracle ARM64 VPS via SSH Session. **No images, networks, or containers are created in Section B.**

```bash
# ------------------------------------------------------------------------------
# B.1. Connect to Oracle VPS & Validate Execution Environment
# ------------------------------------------------------------------------------
ssh "${TARGET_USER}@${ORACLE_HOST}"

# Confirm shell is running on remote ARM64 Oracle VPS
[ "$(uname -m)" = "aarch64" ] || { echo "ERROR: Not on ARM64 host!"; exit 1; }

# Prevent accidental targeting of unexpected Docker daemons
[ "$(docker context show)" = "default" ] || { echo "ERROR: Docker context must be default!"; exit 1; }
[ -z "${DOCKER_HOST}" ] || { echo "ERROR: DOCKER_HOST must be unset!"; exit 1; }

TARGET_USER="$(whoami)"
REMOTE_DEST_DIR="/home/${TARGET_USER}/kpanel-staging-transfer"
REMOTE_STAGING_DIR="/home/${TARGET_USER}/kpanel-disposable-staging"

# ------------------------------------------------------------------------------
# B.2. Verify SHA-256 Checksum in Transfer Directory
# ------------------------------------------------------------------------------
cd "${REMOTE_DEST_DIR}"
sha256sum -c kpanel-staging-smoke-bundle.tar.gz.sha256
# MUST output: kpanel-staging-smoke-bundle.tar.gz: OK
# If checksum fails: STOP immediately. Do NOT extract.

# ------------------------------------------------------------------------------
# B.3. Safe Archive Extraction into Dedicated Empty Staging Directory
# ------------------------------------------------------------------------------
# Fail closed if destination directory already exists with files
if [ -d "${REMOTE_STAGING_DIR}" ] && [ -n "$(ls -A "${REMOTE_STAGING_DIR}" 2>/dev/null)" ]; then
  echo "ERROR: Target staging directory ${REMOTE_STAGING_DIR} is not empty! Halting to prevent overwrite."
  exit 1
fi

mkdir -p "${REMOTE_STAGING_DIR}"
chmod 700 "${REMOTE_STAGING_DIR}"

# Extract archive with safety checks
tar -xzf "${REMOTE_DEST_DIR}/kpanel-staging-smoke-bundle.tar.gz" -C "${REMOTE_STAGING_DIR}"

# Verify exactly 8 approved files extracted
ls -la "${REMOTE_STAGING_DIR}/staging-smoke"
ls -la "${REMOTE_STAGING_DIR}/staging-smoke/candidate"
ls -la "${REMOTE_STAGING_DIR}/staging-smoke/ingress"

# ------------------------------------------------------------------------------
# B.4. Static Docker Compose Configuration Validation on VPS
# ------------------------------------------------------------------------------
cd "${REMOTE_STAGING_DIR}/staging-smoke"
docker compose config
# Must parse with zero syntax warnings or unresolved variables.

# ------------------------------------------------------------------------------
# B.5. Re-Verify Loopback Port 18080 and Host Headroom Immediately Before Execution
# ------------------------------------------------------------------------------
ss -tulpn | grep 18080 && { echo "ERROR: Port 18080 is occupied!"; exit 1; } || echo "Port 18080 confirmed free."
df -h / | awk 'NR==2 {print "Available disk: " $4}'
free -m | awk '/Mem:/ {print "Available RAM: " $7 " MB"}'
# Verify: Avail disk >= 12 GB, free RAM >= 8192 MB, 1m load <= 8.0.
```

---

## STAGE B — SEPARATELY APPROVED STAGING EXECUTION (STAGE B1 / PART B: OPERATIONS REQUIRING SEPARATE OPERATOR APPROVAL)

**Execution Location:** Remote Oracle ARM64 VPS (in active, verified SSH session).  
**CRITICAL AUTHORIZATION NOTICE:** The following commands create Docker resources and execute image builds on the VPS. **DO NOT EXECUTE WITHOUT EXPLICIT OPERATOR APPROVAL.**

Stage B remains a separate operator approval covering:
1. Exact base-image pulls (`nginxinc/nginx-unprivileged:alpine`)
2. Two sequential image builds (`candidate`, then `ingress` with `COMPOSE_PARALLEL_LIMIT=1`)
3. Creation of two containers (`candidate`, `ingress`)
4. Creation of one Compose-owned bridge network (`<project>_staging_net`)
5. Loopback port publication (`127.0.0.1:18080`)

### SECTION C: ORACLE VPS — SEPARATELY APPROVED STAGING BUILD AND STARTUP

```bash
# ------------------------------------------------------------------------------
# C.1. Validate Docker Context and Server-Side Variables
# ------------------------------------------------------------------------------
[ "$(docker context show)" = "default" ] && [ -z "${DOCKER_HOST}" ] || { echo "ERROR: Docker context invalid"; exit 1; }

RUN_TIMESTAMP="$(date +%Y%m%d%H%M%S)"
export COMPOSE_PROJECT_NAME="kpanel-smoke-${RUN_TIMESTAMP}"
export SMOKE_RUN_ID="smoke-${RUN_TIMESTAMP}"
export STAGING_INGRESS_PORT=18080
export APP_PORT=8080
export CANDIDATE_IMAGE="kpanel-smoke-candidate:${SMOKE_RUN_ID}"
export INGRESS_IMAGE="kpanel-smoke-ingress:${SMOKE_RUN_ID}"
export COMPOSE_PARALLEL_LIMIT=1

echo "Configured Project: ${COMPOSE_PROJECT_NAME}"
echo "Configured Run ID:  ${SMOKE_RUN_ID}"

# Reject collision with protected projects
case "${COMPOSE_PROJECT_NAME}" in
  kpanel|kpanel-clean|dokploy|n8n)
    echo "ERROR: Protected project collision! Aborting."; exit 1 ;;
esac

# ------------------------------------------------------------------------------
# C.2. Record Pre-Startup Host Container State & Pre-Mutation Run Intent Journal
# ------------------------------------------------------------------------------
BEFORE_START_FILE="${REMOTE_STAGING_DIR}/before-start-containers.txt"
docker ps -q > "${BEFORE_START_FILE}"
BEFORE_COUNT=$(wc -l < "${BEFORE_START_FILE}")
echo "Recorded ${BEFORE_COUNT} running pre-existing container IDs."

# Write initial durable run-intent record BEFORE the first image pull, build, or container creation.
# If interrupted at any subsequent step, this file enables safe operator discovery and cleanup.
METADATA_FILE="${REMOTE_STAGING_DIR}/staging-smoke-run.json"
cat > "${METADATA_FILE}" <<EOF
{
  "projectName": "${COMPOSE_PROJECT_NAME}",
  "smokeRunId": "${SMOKE_RUN_ID}",
  "stagingDirectory": "${REMOTE_STAGING_DIR}/staging-smoke",
  "loopbackPort": ${STAGING_INGRESS_PORT},
  "beforeStartContainersFile": "${BEFORE_START_FILE}",
  "baseImageReferences": [
    "node:20-alpine",
    "nginxinc/nginx-unprivileged:alpine"
  ],
  "candidateImage": "${CANDIDATE_IMAGE}",
  "ingressImage": "${INGRESS_IMAGE}",
  "candidateContainerId": null,
  "ingressContainerId": null,
  "stagingNetworkId": null,
  "executionStatus": "intent_recorded",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
chmod 600 "${METADATA_FILE}"
echo "Pre-mutation run intent recorded in ${METADATA_FILE} (status: intent_recorded)."

# ------------------------------------------------------------------------------
# C.3. Base Image Inspection, Immutable Digests & Authorized Pull
# ------------------------------------------------------------------------------
# Invariant: Only reviewed and authorized base images may be used.
# Candidate base: node:20-alpine (must be already cached locally)
# Ingress base: nginxinc/nginx-unprivileged:alpine (single authorized pull if missing)
# Fail closed if any unapproved image pull is necessary.
#
# NOTE: A cached Docker image does NOT guarantee an offline BuildKit build
# (BuildKit's resolver or layer cache may perform remote metadata checks depending
# on daemon configuration). Omitting --pull prevents Compose from explicitly requesting
# newer versions from the registry.

# 1. Inspect Candidate base image in local cache
if ! docker image inspect node:20-alpine >/dev/null 2>&1; then
  echo "ERROR: Required base image 'node:20-alpine' is NOT present in local Docker cache! Failing closed."
  exit 1
fi
CANDIDATE_BASE_DIGEST=$(docker image inspect --format '{{.Id}}' node:20-alpine)
echo "Verified cached candidate base image node:20-alpine ID: ${CANDIDATE_BASE_DIGEST}"

# 2. Inspect Ingress base image (allow single authorized pull if not cached)
if ! docker image inspect nginxinc/nginx-unprivileged:alpine >/dev/null 2>&1; then
  echo "Authorized pull: Retrieving reviewed ingress base image nginxinc/nginx-unprivileged:alpine..."
  docker pull nginxinc/nginx-unprivileged:alpine || {
    echo "ERROR: Failed to pull authorized base image nginxinc/nginx-unprivileged:alpine! Failing closed."
    exit 1
  }
fi
INGRESS_BASE_DIGEST=$(docker image inspect --format '{{.Id}}' nginxinc/nginx-unprivileged:alpine)
echo "Verified ingress base image nginxinc/nginx-unprivileged:alpine ID: ${INGRESS_BASE_DIGEST}"

# ------------------------------------------------------------------------------
# C.4. Sequential, Concurrency-Controlled Image Builds
# ------------------------------------------------------------------------------
cd "${REMOTE_STAGING_DIR}/staging-smoke"

# Retain strict build concurrency limit: COMPOSE_PARALLEL_LIMIT=1
export COMPOSE_PARALLEL_LIMIT=1

# Sequential build step 1: Candidate service (valid Compose build syntax; boolean --pull omitted to use cache)
echo "Building candidate service sequentially (1/2)..."
docker compose -p "${COMPOSE_PROJECT_NAME}" build candidate

# Sequential build step 2: Ingress service
echo "Building ingress service sequentially (2/2)..."
docker compose -p "${COMPOSE_PROJECT_NAME}" build ingress

# Update run journal with built image status
sed -i 's/"executionStatus": *"intent_recorded"/"executionStatus": "images_built"/' "${METADATA_FILE}"
sed -i "s/\"updatedAt\": *\"[^\"]*\"/\"updatedAt\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"/" "${METADATA_FILE}"
echo "Updated run journal to status 'images_built'."

# ------------------------------------------------------------------------------
# C.5. Launch Containers with Health Readiness & Bounded Timeout
# ------------------------------------------------------------------------------
# Supported Compose CLI options:
#   -d: Run containers in background (detached mode)
#   --no-build: Strictly prevent rebuilding images during startup
#   --pull never: Strictly prohibit pulling images during container start
#   --wait: Wait for services to achieve running/healthy status (healthchecks pass)
#   --wait-timeout 60: Bounded wait timeout (60 seconds); fails if readiness not achieved
if ! docker compose -p "${COMPOSE_PROJECT_NAME}" up -d --no-build --pull never --wait --wait-timeout 60; then
  echo "ERROR: Container startup or health readiness failed or timed out!"
  echo "PRESERVING RESOURCES FOR OPERATOR INSPECTION: Automatic cleanup is prohibited."
  echo "Inspect current container states and logs:"
  echo "  docker compose -p \"${COMPOSE_PROJECT_NAME}\" ps -a"
  echo "  docker compose -p \"${COMPOSE_PROJECT_NAME}\" logs"
  exit 1
fi
echo "Containers started and verified healthy within bounded timeout."

# ------------------------------------------------------------------------------
# C.6. Discover Container IDs via Exact Compose Service Queries (NO GUESSED NAMES)
# ------------------------------------------------------------------------------
CANDIDATE_ID=$(docker compose -p "${COMPOSE_PROJECT_NAME}" ps -q candidate)
INGRESS_ID=$(docker compose -p "${COMPOSE_PROJECT_NAME}" ps -q ingress)
NETWORK_ID=$(docker network ls -q --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}")

# Verify exactly one ID returned per service
[ -n "${CANDIDATE_ID}" ] && [ $(echo "${CANDIDATE_ID}" | wc -w) -eq 1 ] || { echo "ERROR: Candidate container discovery failed!"; exit 1; }
[ -n "${INGRESS_ID}" ] && [ $(echo "${INGRESS_ID}" | wc -w) -eq 1 ] || { echo "ERROR: Ingress container discovery failed!"; exit 1; }

echo "Discovered Candidate Container ID: ${CANDIDATE_ID}"
echo "Discovered Ingress Container ID:   ${INGRESS_ID}"
echo "Discovered Staging Network ID:      ${NETWORK_ID}"

# ------------------------------------------------------------------------------
# C.7. Update Run Metadata Journal with Actual Discovered Resource IDs
# ------------------------------------------------------------------------------
cat > "${METADATA_FILE}" <<EOF
{
  "projectName": "${COMPOSE_PROJECT_NAME}",
  "smokeRunId": "${SMOKE_RUN_ID}",
  "stagingDirectory": "${REMOTE_STAGING_DIR}/staging-smoke",
  "loopbackPort": ${STAGING_INGRESS_PORT},
  "beforeStartContainersFile": "${BEFORE_START_FILE}",
  "baseImageReferences": [
    "node:20-alpine",
    "nginxinc/nginx-unprivileged:alpine"
  ],
  "candidateImage": "${CANDIDATE_IMAGE}",
  "ingressImage": "${INGRESS_IMAGE}",
  "candidateContainerId": "${CANDIDATE_ID}",
  "ingressContainerId": "${INGRESS_ID}",
  "stagingNetworkId": "${NETWORK_ID}",
  "executionStatus": "containers_running",
  "createdAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")",
  "updatedAt": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
chmod 600 "${METADATA_FILE}"
echo "Run metadata journal updated to status 'containers_running' in ${METADATA_FILE}."
```

---

## SECTION D: ORACLE VPS — LIVE VERIFICATION (STAGE B2)

**Execution Location:** Remote Oracle ARM64 VPS (in active SSH session).

```bash
# ------------------------------------------------------------------------------
# D.1. Verify Container Health via Exact IDs
# ------------------------------------------------------------------------------
CANDIDATE_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "${CANDIDATE_ID}")
INGRESS_HEALTH=$(docker inspect --format '{{.State.Health.Status}}' "${INGRESS_ID}")

[ "${CANDIDATE_HEALTH}" = "healthy" ] || { echo "ERROR: Candidate is ${CANDIDATE_HEALTH}!"; exit 1; }
[ "${INGRESS_HEALTH}" = "healthy" ] || { echo "ERROR: Ingress is ${INGRESS_HEALTH}!"; exit 1; }
echo "Container health verified: candidate=healthy, ingress=healthy."

# ------------------------------------------------------------------------------
# D.2. Verify Network & Port Isolation
# ------------------------------------------------------------------------------
# 1. Candidate must have zero published host ports
CAND_PORTS=$(docker inspect --format '{{json .NetworkSettings.Ports}}' "${CANDIDATE_ID}")
[ "${CAND_PORTS}" = "{}" ] || [ "${CAND_PORTS}" = '{"8080/tcp":null}' ] || { echo "ERROR: Candidate has host ports: ${CAND_PORTS}"; exit 1; }

# 2. Ingress must bind strictly to 127.0.0.1
ING_BINDING=$(docker inspect --format '{{range $p, $conf := .NetworkSettings.Ports}}{{range $conf}}{{.HostIp}}:{{.HostPort}}{{end}}{{end}}' "${INGRESS_ID}")
[ "${ING_BINDING}" = "127.0.0.1:${STAGING_INGRESS_PORT}" ] || { echo "ERROR: Ingress bound to non-loopback: ${ING_BINDING}"; exit 1; }

# 3. Candidate attached ONLY to project staging bridge
CAND_NETWORKS=$(docker inspect --format '{{range $net, $conf := .NetworkSettings.Networks}}{{$net}} {{end}}' "${CANDIDATE_ID}")
[ "${CAND_NETWORKS}" = "${COMPOSE_PROJECT_NAME}_staging_net " ] || { echo "ERROR: Foreign network attached: ${CAND_NETWORKS}"; exit 1; }

# ------------------------------------------------------------------------------
# D.3. HTTP Endpoints & Status Code Verification
# ------------------------------------------------------------------------------
# Verify / responds with HTTP 200 and expected payload
ROOT_CODE=$(curl -s -o /tmp/resp_root.json -w "%{http_code}" "http://127.0.0.1:${STAGING_INGRESS_PORT}/")
[ "${ROOT_CODE}" = "200" ] || { echo "ERROR: / returned HTTP ${ROOT_CODE}!"; exit 1; }
grep -q '"status":"ok"' /tmp/resp_root.json || { echo "ERROR: / payload mismatch!"; exit 1; }
grep -q '"role":"candidate"' /tmp/resp_root.json || { echo "ERROR: / role mismatch!"; exit 1; }

# Verify /healthz responds with HTTP 200
HEALTH_CODE=$(curl -s -o /tmp/resp_healthz.json -w "%{http_code}" "http://127.0.0.1:${STAGING_INGRESS_PORT}/healthz")
[ "${HEALTH_CODE}" = "200" ] || { echo "ERROR: /healthz returned HTTP ${HEALTH_CODE}!"; exit 1; }
grep -q '"status":"healthy"' /tmp/resp_healthz.json || { echo "ERROR: /healthz payload mismatch!"; exit 1; }

echo "HTTP verification passed: / (200 OK), /healthz (200 OK)."

# ------------------------------------------------------------------------------
# D.4. Workstation Access via Encrypted SSH Tunnel (Run from Workstation)
# ------------------------------------------------------------------------------
# In a local operator workstation terminal (SSH Tunnel):
# ssh -N -L 18080:127.0.0.1:18080 ${TARGET_USER}@${ORACLE_HOST}
# In second workstation terminal:
# curl -i http://127.0.0.1:18080/
# curl -i http://127.0.0.1:18080/healthz

# NOTICE: Do NOT run a curl command against the VPS public IP from the VPS itself.
# Hairpin routing on the host invalidates self-probing public IPs.
# A true external unreachability probe requires an external scanner and separate authorization.
```

---

## STAGE C — SEPARATELY APPROVED DISPOSABLE TEARDOWN & WORKLOAD PRESERVATION AUDIT (STAGE B3)

**Execution Location:** Remote Oracle ARM64 VPS. Works reliably even after SSH session disconnect.  
**CRITICAL AUTHORIZATION NOTICE:** Destructive cleanup operations require **separate, explicit operator confirmation**. Unattended or automated cleanup is strictly prohibited.

**STRICT CLEANUP PROHIBITIONS:**
- DO NOT USE `docker compose down --remove-orphans` (risks stopping neighbor containers).
- DO NOT USE `docker compose down --volumes` or `-v` (risks destroying shared storage).
- DO NOT USE `docker image prune` (with or without `-f` or `--filter`).
- DO NOT USE `docker system prune` or `docker builder prune`.
- DO NOT USE wildcard container deletions (`docker rm $(...)`).
- DO NOT USE unattended cleanup scripts.

### SECTION E: ORACLE VPS — SEPARATELY APPROVED CLEANUP PROCEDURE

```bash
# ------------------------------------------------------------------------------
# E.1. Recover Persistent Run Identity from Metadata File (Crash Recovery Capable)
# ------------------------------------------------------------------------------
METADATA_FILE="${REMOTE_STAGING_DIR}/staging-smoke-run.json"
[ -f "${METADATA_FILE}" ] || { echo "ERROR: Run metadata file ${METADATA_FILE} missing! Halting cleanup."; exit 1; }

# Parse saved metadata
COMPOSE_PROJECT_NAME=$(grep -o '"projectName": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
SMOKE_RUN_ID=$(grep -o '"smokeRunId": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
SAVED_STATUS=$(grep -o '"executionStatus": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
SAVED_CANDIDATE_ID=$(grep -o '"candidateContainerId": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
SAVED_INGRESS_ID=$(grep -o '"ingressContainerId": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
CANDIDATE_IMAGE=$(grep -o '"candidateImage": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
INGRESS_IMAGE=$(grep -o '"ingressImage": *"[^"]*"' "${METADATA_FILE}" | cut -d'"' -f4)
BEFORE_START_FILE="${REMOTE_STAGING_DIR}/before-start-containers.txt"

echo "Recovered project: ${COMPOSE_PROJECT_NAME}"
echo "Recovered run ID:  ${SMOKE_RUN_ID}"
echo "Recorded status:   ${SAVED_STATUS:-unknown}"

# ------------------------------------------------------------------------------
# E.2. Re-Discover Current Project Resources via Labels and Verify Against Metadata
# ------------------------------------------------------------------------------
cd "${REMOTE_STAGING_DIR}/staging-smoke"

# Discover containers by exact Compose service query and labels
CURRENT_CANDIDATE=$(docker compose -p "${COMPOSE_PROJECT_NAME}" ps -q candidate 2>/dev/null || true)
CURRENT_INGRESS=$(docker compose -p "${COMPOSE_PROJECT_NAME}" ps -q ingress 2>/dev/null || true)

# Stop and report ownership conflict if IDs exist and do not match metadata
if [ -n "${SAVED_CANDIDATE_ID}" ] && [ "${SAVED_CANDIDATE_ID}" != "null" ]; then
  if [ -n "${CURRENT_CANDIDATE}" ] && [ "${CURRENT_CANDIDATE}" != "${SAVED_CANDIDATE_ID}" ]; then
    echo "OWNERSHIP CONFLICT: Candidate ID (${CURRENT_CANDIDATE}) differs from metadata (${SAVED_CANDIDATE_ID})! Halting."
    exit 1
  fi
fi
if [ -n "${SAVED_INGRESS_ID}" ] && [ "${SAVED_INGRESS_ID}" != "null" ]; then
  if [ -n "${CURRENT_INGRESS}" ] && [ "${CURRENT_INGRESS}" != "${SAVED_INGRESS_ID}" ]; then
    echo "OWNERSHIP CONFLICT: Ingress ID (${CURRENT_INGRESS}) differs from metadata (${SAVED_INGRESS_ID})! Halting."
    exit 1
  fi
fi

# Rediscover any resources created under project label (handles mid-run interruption)
PROJECT_CONTAINERS=$(docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" -q)
PROJECT_NETWORKS=$(docker network ls --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" -q)

# Verify no protected container is touched
COLLISIONS=$(docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" \
  --format "{{.Names}}" | grep -E 'kpanel-frontend|kpanel-backend|dokploy|n8n|traefik' || true)
[ -z "${COLLISIONS}" ] || { echo "SAFETY ABORT: Protected container collision: ${COLLISIONS}"; exit 1; }

# ------------------------------------------------------------------------------
# E.3. Require Explicit Operator Confirmation (Zero Unattended Cleanup)
# ------------------------------------------------------------------------------
echo "Target resources for removal under project '${COMPOSE_PROJECT_NAME}':"
docker ps -a --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format "table {{.ID}}\t{{.Names}}\t{{.Status}}"
docker network ls --filter "label=com.docker.compose.project=${COMPOSE_PROJECT_NAME}" --format "table {{.ID}}\t{{.Name}}"

read -p "Confirm project-scoped teardown for '${COMPOSE_PROJECT_NAME}'? (yes/NO): " CONFIRM
[ "${CONFIRM}" = "yes" ] || { echo "Cleanup cancelled by operator. Resources left intact."; exit 0; }

# ------------------------------------------------------------------------------
# E.4. Project-Scoped Teardown (NO --remove-orphans, NO --volumes)
# ------------------------------------------------------------------------------
docker compose -p "${COMPOSE_PROJECT_NAME}" down

# ------------------------------------------------------------------------------
# E.5. Specific Disposable Image Removal (Proven Ownership Only)
# ------------------------------------------------------------------------------
docker rmi "${CANDIDATE_IMAGE}" "${INGRESS_IMAGE}" 2>/dev/null || true
# NEVER run docker image prune, docker system prune, or wildcard rm.

# ------------------------------------------------------------------------------
# E.6. Verify 100% Pre-Existing Workload Preservation (Exact IDs & States)
# ------------------------------------------------------------------------------
if [ -f "${BEFORE_START_FILE}" ]; then
  echo "Verifying all pre-existing containers remain present and running..."
  FAILED_CONTAINERS=0
  while read -r CID; do
    [ -n "${CID}" ] || continue
    STATE=$(docker inspect --format '{{.State.Status}}' "${CID}" 2>/dev/null || echo "MISSING")
    if [ "${STATE}" != "running" ]; then
      echo "CRITICAL: Pre-existing container ${CID} is ${STATE}!"
      FAILED_CONTAINERS=$((FAILED_CONTAINERS + 1))
    fi
  done < "${BEFORE_START_FILE}"

  if [ ${FAILED_CONTAINERS} -eq 0 ]; then
    echo "SUCCESS: All pre-existing production containers verified intact and running."
  else
    echo "ERROR: ${FAILED_CONTAINERS} pre-existing container(s) mutated! Check host immediately."
    exit 1
  fi
fi

# Clean up local run metadata file after verified cleanup
rm -f "${METADATA_FILE}"
echo "Cleanup completed cleanly."
```
