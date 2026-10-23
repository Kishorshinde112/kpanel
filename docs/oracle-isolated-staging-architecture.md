# K-PANEL OPERATOR RUNBOOK: ORACLE VPS ISOLATED STAGING ARCHITECTURE

**Phase:** 4C3D3 — Oracle VPS Architecture Adaptation (Local Development & Operator Review Only)  
**Host Context:** Oracle Cloud Infrastructure Ampere A1 (ARM64, Ubuntu 24.04.3 LTS, 4 OCPU, ~23 GiB RAM, 54 GB free disk)  
**Execution Status:** LOCAL DEVELOPMENT & OFFLINE PLANNING ONLY. Zero host mutations, zero live container actions.  
**Architecture Strategy:** `isolated-loopback-staging` (Shared Dokploy Traefik production integration is strictly deferred).  

---

## 1. Actual VPS Findings & Reconciliation

Based on the verified point-in-time read-only infrastructure observation report from the Oracle VPS, the host topology has been established as follows:

| Host Property | Observed Value | Reconciliation & Architectural Impact |
| :--- | :--- | :--- |
| **Operating System** | Ubuntu 24.04.3 LTS (ARM64) | Target architecture is `aarch64`. Multi-arch or native ARM64 container builds required. |
| **Linux Kernel** | Oracle 6.17.0-1002-oracle | Kernel cgroup v2 active, overlay2 storage driver. Compatible with standard container isolation. |
| **Compute & Memory** | 4 OCPU, ~23 GiB RAM (~14 GiB available) | Conservative resource budgeting required. Headroom must be reserved for existing workloads and OS. |
| **Disk Capacity** | 145 GB total root disk, 54 GB free | 54 GB available disk headroom. Hard floor of 10 GB free space must be preserved; disk pressure guards required. |
| **Docker Engine** | Docker Engine 29.1.3 | Daemon functional with cgroup v2. Single-node Docker Swarm manager is active. |
| **Docker Buildx** | Docker Buildx v0.31.1 on host | Available on host, but `backend/Dockerfile` installs basic `docker-cli` without Buildx plugin. Builds must be decoupled. |
| **Running Containers** | 45 active workloads | High multi-tenant density beside Dokploy, n8n, Traefik, Caddy, Nginx, Cloudflare Tunnel. |
| **Ingress Ports 80/443** | Owned by Dokploy-managed Traefik v3.6.7 | Direct binding to 80/443 is impossible and prohibited. K-Panel staging cannot bind to public ingress ports. |
| **Traefik Networks** | `dokploy-network` (Swarm overlay) + 2 bridges | Dokploy manages Traefik network attachments. Attaching K-Panel candidates to `dokploy-network` is prohibited. |
| **Traefik Dynamic Dir** | Owned by Dokploy (`/etc/dokploy/traefik/dynamic`) | Modifying Dokploy's dynamic file directory risks conflict, overwrite, or breaking Dokploy workloads. |
| **Traefik File Watch** | Unverified | Dynamic file watching is not verified on the running Traefik instance. |
| **Existing K-Panel** | `kpanel-frontend-1`, `kpanel-backend-1` running | Legacy test installation active on `kpanel-clean_kpanel_net`. Must be treated as protected foreign workloads. |
| **Docker Networks** | No network with `Internal=true` | Zero reported internal networks. Dedicated staging bridge network does not yet exist. |

---

## 2. Verified vs. Unverified Details

It is critical to distinguish what is factually verified from what remains unverified on the VPS:

### Verified Facts (Operator Observation)
1. Single-node Docker Swarm is active on the host.
2. 45 container workloads are running concurrently.
3. Dokploy-managed Traefik v3.6.7 owns host ports 80 and 443.
4. An existing earlier K-Panel test installation (`kpanel-frontend-1`, `kpanel-backend-1`) is running on bridge network `kpanel-clean_kpanel_net`.
5. Dokploy uses an overlay network named `dokploy-network`.
6. Host root disk has 54 GB free space.

### Unverified Details (Strictly Unknown / Unapproved)
1. **File Provider Dynamic Reload:** Whether Traefik was started with `--providers.file.watch=true` or automatically detects file modifications.
2. **Dokploy Directory Synchronization:** Whether Dokploy periodically purges or overwrites foreign files in `/etc/dokploy/traefik/dynamic`.
3. **Domain Ownership & DNS:** Whether target domains configured in K-Panel are properly delegated, proxied via Cloudflare, or already claimed by Dokploy/Nginx.
4. **Staging Network Authorization:** No dedicated staging network has been created or approved on the host.
5. **Database / Volume Schema of Legacy K-Panel:** The SQLite schema and volume state of `kpanel-clean` are unknown and unreconciled.

---

## 3. Why Direct Dokploy Traefik Integration is Deferred

Direct integration with the Dokploy-managed Traefik instance for initial staging is **strictly deferred and blocked** (`shared-traefik-production: BLOCKED_UNVERIFIED`) for the following reasons:

1. **Risk of Production Routing Outage:** Dokploy Traefik routes production traffic for Dokploy, n8n, and other live services on the host. Writing unverified route files into Dokploy's directory risks crashing Traefik's dynamic configuration parser or routing public traffic to an unfinished candidate.
2. **Network Collision & Overlay Complexity:** Dokploy Traefik attaches to a Swarm overlay network (`dokploy-network`). Connecting candidate containers across Swarm overlay boundaries introduces Swarm service VIP routing dependencies, multi-node overlay routing artifacts, and cross-talk with Dokploy core containers.
3. **Unverified Watch Invariant:** If Traefik's File provider dynamic file watching is disabled or unmapped, written route files will not trigger live traffic switching, giving a false appearance of deployment readiness.
4. **Ownership Inversion:** Dokploy is designed to be the authoritative manager of its Traefik instance. Injecting routes from an external management panel breaks Dokploy's state reconciliation model.

---

## 4. Proposed Isolated Ingress Topology

To validate K-Panel candidates safely without touching Dokploy or exposing services to the public internet, we adopt the `isolated-loopback-staging` strategy.

### Architectural Layout:

```
[ Operator Workstation ]
          │
          │ SSH Tunnel: `ssh -N -L 18080:127.0.0.1:18080 user@oracle-vps`
          ▼
[ Oracle VPS: 127.0.0.1:18080 (Loopback High Port Only) ]
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│ Compose Project: `kpanel-staging`                           │
│                                                             │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Staging Ingress Container                           │   │
│   │ (kpanel-staging-ingress-<depId>)                    │   │
│   │ - Binds exclusively to 127.0.0.1:18080              │   │
│   │ - Lightweight proxy (Caddy / Nginx / Traefik)       │   │
│   │ - Resource limit: 0.5 CPU, 256 MB RAM               │   │
│   │ - No Docker socket mount                            │   │
│   └──────────────────────────┬──────────────────────────┘   │
│                              │                              │
│                              │ Bridge: `kpanel_staging_net` │
│                              │ (Dedicated, isolated)        │
│                              ▼                              │
│   ┌─────────────────────────────────────────────────────┐   │
│   │ Candidate Application Container                     │   │
│   │ (kpanel-staging-candidate-<depId>)                  │   │
│   │ - ZERO published host ports (ports: [])             │   │
│   │ - Exposes internal port (e.g. 3000) on bridge only  │   │
│   │ - Resource limits: 1.0 CPU, 1024 MB RAM             │   │
│   │ - CapDrop: [ALL], no-new-privileges                 │   │
│   │ - Zero Dokploy network membership                   │   │
│   │ - Labels: traefik.enable=false                      │   │
│   └─────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

---

## 5. Docker Network Requirements

1. **Dedicated Staging Bridge:** Staging candidate containers and the staging ingress container must communicate **exclusively over an isolated bridge network** (e.g. `kpanel_staging_net` or `kpanel-staging-net`).
2. **Prohibited Network Memberships:**
   - **NO attachment to `dokploy-network`** (Swarm overlay).
   - **NO attachment to default `bridge` network** (Docker default bridge lacks embedded DNS resolution and isolates poorly).
   - **NO attachment to `host` network mode.**
   - **NO attachment to `caddy_default` or `n8n_net`.**
3. **Approval Boundary:** Creation of `kpanel_staging_net` requires explicit operator execution and approval. Automated network creation on the VPS remains disabled in this phase.

---

## 6. Loopback Binding & Port Requirements

1. **Strict 127.0.0.1 Binding:** Ingress must bind **exclusively to the IPv4 loopback interface** (`127.0.0.1:<port>`).
   - Binding to `0.0.0.0` (all interfaces) or `::` (IPv6 all) is **strictly prohibited** by code validation (`NON_LOOPBACK_BINDING_PROHIBITED`).
2. **High Port Range (>= 1024):** The operator-selected ingress port must be an unprivileged high port (between 1024 and 65535).
   - Selecting ports `< 1024` (e.g. 80, 443, 22) is rejected with `PRIVILEGED_PORT_PROHIBITED`.
3. **Occupied Port Conflict Prevention:** The selected port must not conflict with known services:
   - Prohibited ports: `22, 53, 80, 443, 2375, 2376, 2377, 3000, 3030, 4222, 5000, 5001, 5678, 7946, 4789, 8080, 9000, 9443`.
   - Recommended candidate port: **`18080`** (or another operator-verified free high port).

---

## 7. SSH Tunnel Access Model

Testing is conducted entirely through an encrypted SSH tunnel from the operator's workstation:

```bash
# Operator opens an encrypted local port forward to the VPS loopback port:
ssh -N -L 18080:127.0.0.1:18080 operator-user@<oracle-vps-ip>
```

### Verification from Workstation:
```bash
# Operator tests the staged application directly via localhost:
curl -v http://127.0.0.1:18080/
```

### Safety Benefits:
- **Zero Public Exposure:** The staging candidate is invisible to the public internet, port scanners, and search engines.
- **Zero DNS Record Creation:** No public DNS records need to be registered or propagated.
- **Zero TLS Certificate Issuance:** No Let's Encrypt rate-limiting or ACME HTTP-01 challenges are required.
- **Zero Dokploy / Cloudflare Interference:** Production traffic routing is completely bypassed.

---

## 8. Resource Budgets & Headroom Governance

The Oracle VPS has 4 OCPU, ~23 GiB RAM, and 54 GB free root disk with 45 running workloads. To avoid CPU starvation, out-of-memory (OOM) kills, or disk exhaustion:

1. **Candidate Container Limits:**
   - **Default CPU:** `1.0` OCPU (maximum operator ceiling: `2.0` OCPU).
   - **Default Memory:** `1024 MB` (1 GiB) (maximum operator ceiling: `4096 MB`).
   - **PIDs Limit:** `256` (prevents fork bombs).
2. **Staging Ingress Limits:**
   - **CPU:** `0.5` OCPU.
   - **Memory:** `256 MB`.
   - **PIDs Limit:** `128`.
3. **System Headroom Reservation:**
   - At least **8 GB RAM** must remain unallocated to service the OS and existing 45 workloads.
4. **Build Concurrency Clamped to 1:**
   - **`MAX_BUILD_CONCURRENCY = 1`**. Concurrent container builds are strictly prohibited to prevent CPU spikes and memory exhaustion.
5. **Disk Headroom Guard:**
   - **Minimum 10 GB free root disk floor:** Operations fail closed with `DISK_PRESSURE_ABORT` if free disk falls below 10 GB.
   - **12 GB required before image build:** Prevents Docker BuildKit from filling the root partition.
6. **Strict Prohibition on Automatic Global Pruning:**
   - **`DOCKER_SYSTEM_PRUNE_PROHIBITED`**: Automated invocation of `docker system prune`, `docker volume prune`, or `docker builder prune -a` is **strictly prohibited in code and design**.
   - Global pruning on a host running 45 workloads risks deleting Dokploy, n8n, or Traefik base images, volume data, and build caches.

---

## 9. Docker Socket Security Boundary

### Critical Architectural Finding:
Mounting `/var/run/docker.sock` with `:ro` in Docker Compose **does NOT make the Docker API read-only**.  
The Docker daemon communicates via HTTP requests over the Unix domain socket. Standard HTTP POST, DELETE, and PUT operations (such as container creation, stopping, deletion, and exec) can still be sent over a `:ro` mounted socket stream. Exposing the Docker socket directly into a public web frontend grants full host root access.

### 4-Tier Architectural Separation Model:

| Architectural Tier | Component | Docker Access Level | Allowed Endpoints / Operations |
| :--- | :--- | :--- | :--- |
| **Tier 1: Dashboard / Web UI** | Frontend & User API | **Zero Docker Socket** | Interacts exclusively with SQLite database and internal queue. Socket mount strictly removed. |
| **Tier 2: Read-Only Inventory** | Inventory Adapter | **Read-Only Inspection** | `GET /version`, `GET /info`, `GET /containers/json`, `GET /networks`. All POST/DELETE methods blocked. |
| **Tier 3: Deployment Executor** | Background Worker | **Constrained Staging Lifecycle** | `POST /containers/create`, `POST /containers/*/start`, `POST /containers/*/stop`. Enforces label fencing (`io.kpanel.managed=true`), resource limits, non-root user, and no host bind mounts. |
| **Tier 4: Build Executor** | Build Worker | **Isolated Image Builder** | Dedicated rootless BuildKit instance or isolated subprocess. Concurrency = 1. Decoupled from Web API. |

---

## 10. Existing K-Panel Instance Preservation & Protection

The running containers `kpanel-frontend-1` and `kpanel-backend-1` belong to an earlier test installation of uncertain schema and configuration.

### Protection Rules:
1. **Protected Foreign Workload Classification:** Treat both existing containers as protected foreign workloads.
2. **Never Overwrite or Recreate:** Do NOT run `docker compose up` with project name `kpanel` or `kpanel-clean`.
3. **Dedicated Staging Namespace:** All staging Compose resources must use the dedicated project namespace **`kpanel-staging`**.
4. **Deterministic Service Naming:** Candidate containers are named `kpanel-staging-candidate-<depId>`, and ingress is named `kpanel-staging-ingress-<depId>`.
5. **Volume Preservation:** Under NO circumstances delete, overwrite, or mount the existing `backend/data/kpanel.db` volume.
6. **Future Cutover Plan:** Any future reconciliation, database migration, or container replacement must be explicitly approved by the operator as a separate maintenance window.

---

## 11. Staging Go / No-Go Criteria

Before any authorized live staging test may proceed on the Oracle VPS, the operator must verify all Go/No-Go criteria:

| Checklist Item | Required Condition | Status |
| :--- | :--- | :--- |
| **1. Dedicated Staging Network** | `kpanel_staging_net` created as isolated bridge (`driver: bridge`, not overlay) | Pending operator approval |
| **2. Loopback Port Verified** | Loopback high port (e.g. `18080`) verified free via `ss -tulpn \| grep 18080` | Pending operator check |
| **3. Project Namespace Isolated** | Compose project name is `kpanel-staging` (not `kpanel` or `kpanel-clean`) | Verified in specification |
| **4. Candidate Port Publishing** | Candidate has `ports: []` (zero published host ports) | Verified in specification |
| **5. Staging Ingress Binding** | Ingress binds strictly to `127.0.0.1:<port>` | Verified in specification |
| **6. Dokploy Isolation** | Zero connection to `dokploy-network`; zero writes to Dokploy Traefik directory | Verified in specification |
| **7. Host Disk Headroom** | Free root disk space >= 15 GB | Verified (> 50 GB free) |
| **8. Memory Headroom** | Available RAM >= 8 GB | Verified (~14 GB available) |
| **9. Existing K-Panel Protected** | `kpanel-frontend-1` and `kpanel-backend-1` remain running untouched | Invariant enforced |
| **10. SSH Tunnel Prepared** | Operator can open `ssh -N -L <port>:127.0.0.1:<port>` from workstation | Workstation ready |

---

## 12. Rollback & Cleanup Scope

In the event of a staging test failure or upon completion of smoke testing:

1. **Staging Scope Only:** Rollback and cleanup operations must affect **ONLY** resources labeled with:
   - `io.kpanel.role=staging-candidate`
   - `io.kpanel.role=staging-ingress`
   - Project namespace: `kpanel-staging`
2. **Protected Workloads Excluded:** Under NO circumstances may rollback commands touch:
   - `kpanel-frontend-1` or `kpanel-backend-1`
   - `dokploy-traefik`, `dokploy-core`, `caddy`, `nginx`, `n8n`, or `cloudflared`
   - Any container or network not bearing `io.kpanel.managed=true`
3. **No Network Deletion During Staging:** The dedicated `kpanel_staging_net` network remains persistent for subsequent tests; do not prune networks globally.
4. **Zero Global Pruning:** Never execute `docker system prune` or `docker network prune`.

---

## 13. Summary of Operational Guardrails

- **Zero Host Mutation in this Phase:** All work completed is local code, architecture definitions, and automated offline tests.
- **Production Status Unchanged:** Local staging success does NOT transition release plans to activated production state.
- **Production Routing Stays Blocked:** Public Traefik routing remains strictly deferred until explicit operator authorization and verified domain ownership.
