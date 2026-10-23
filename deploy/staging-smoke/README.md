# K-Panel Disposable Staging Bundle (Phase 4C3D4)

This directory contains the operator-reviewable, disposable staging test bundle designed for isolated validation on the Oracle Ampere A1 (ARM64) host.

## Directory Structure

```
deploy/staging-smoke/
├── docker-compose.yml       # Disposable isolated Compose stack definition
├── .env.example             # Non-secret environment configuration template
├── README.md                # Bundle overview and security invariants
├── RUNBOOK.md               # Operator lifecycle runbook (preflight, start, verify, cleanup)
├── candidate/
│   ├── Dockerfile           # Stateless, non-root, ARM64 candidate Dockerfile
│   └── server.js            # Pure Node.js HTTP server (GET / and GET /healthz)
└── ingress/
    ├── Dockerfile           # Minimal unprivileged Nginx reverse proxy Dockerfile
    └── nginx.conf           # Hardened, loopback-only reverse proxy configuration
```

## Security & Isolation Invariants

| Dimension | Policy Specification |
| :--- | :--- |
| **Project Namespace** | Unique Compose project name (`kpanel-smoke-<run-id>`). Collisions with `kpanel`, `kpanel-clean`, `dokploy`, `n8n` are rejected. |
| **Network Model** | Dedicated bridge network created and owned by Compose (`<project>_staging_net`). Zero Dokploy overlay attachment. |
| **Host Port Publishing** | Candidate has **zero published host ports**. Staging ingress binds strictly to `127.0.0.1:<port>:8080`. |
| **Docker Socket** | Strictly **zero `/var/run/docker.sock` mounts** on any container. |
| **Privileges** | `privileged: false`, `cap_drop: [ALL]`, `no-new-privileges: true`, unprivileged users. |
| **Filesystem** | `read_only: true` with restricted tmpfs mounts for ephemeral requirements. |
| **Resource Limits** | Candidate: 1.0 CPU, 1024 MB RAM, 256 PIDs. Ingress: 0.5 CPU, 256 MB RAM, 64 PIDs. |
| **Existing Workloads** | Legacy K-Panel (`kpanel-frontend-1`, `kpanel-backend-1`), Dokploy Traefik, and n8n remain untouched. |
| **Pruning Policy** | Automated global Docker pruning (`docker system prune`) is strictly prohibited. |

## Offline Validation

Run the offline bundle validator:
```bash
node backend/scripts/validateIsolatedStagingBundle.js
```
