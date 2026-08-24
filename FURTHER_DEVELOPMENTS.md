# K-Panel Development Roadmap & Strategy

## Core Architecture Principles (Hostinger-Grade)
To evolve K-Panel into a professional-grade hosting solution, we are adopting these architectural standards:

1. **Reverse Proxy Orchestration:**
   - Integrate **Traefik** for automatic SSL (Let's Encrypt) and dynamic domain routing using Docker labels.
   - Goal: Zero manual configuration when adding new sites.

2. **Blueprint Templates (Event-Driven Deployment):**
   - Implement "Blueprints" for standardized stacks:
     - `Node-Stack`: App + Redis.
     - `WP-Stack`: WordPress + MariaDB + Redis.
   - Each deployment should pull from a template blueprint to ensure environment consistency.

3. **Resource Governance (Cgroups):**
   - Enforce resource limits (`deploy.resources.limits`) in all generated `docker-compose.yml` files.
   - Implement resource monitoring to alert the dashboard when containers exceed memory/CPU thresholds.

4. **Zero-Downtime Deployment (Blue-Green):**
   - Strategy: Build `v2` container -> Verify health -> Redirect traffic via Traefik.
   - Ensures no site downtime during auto-deployments.

5. **Unified Observability:**
   - Integrate `cAdvisor` to collect real-time CPU/RAM/Disk metrics for all containers.
   - Expose metrics to the K-Panel dashboard for professional-grade analytics.

## 💡 VPS & Architecture Strategy (Future-Proofing)
- **Hostinger-Grade Features for K-Panel:**
  - **Reverse Proxy Orchestration:** Move to Traefik for auto-SSL and domain routing.
  - **Blueprint Templates:** Standardize stacks (Node, WP, Laravel) for 1-click deployments.
  - **Resource Governance:** Use Cgroups (`deploy.resources.limits`) to ensure app stability.
  - **Zero-Downtime:** Implement Blue-Green deployment strategies.
  - **Observability:** Integrate cAdvisor for professional-grade real-time metrics.

## 🛡️ VPS Resilience Roadmap (Future Tasks)
- **Off-site Backups:** Automate DB dumps to Cloudflare R2/S3 using Restic/Borg.
- **Monitoring:** Deploy Uptime Kuma for service health and Telegram/WhatsApp alerts.
- **Security Hardening:** Implement Fail2Ban, CrowdSec, and UFW; minimize open ports.
- **Zero-Trust:** Integrate Tailscale for private/secure server management.

## Current Build & Maintenance Rules
- **Memory Constraint Fix:** Avoid `npm run build` inside containers for heavy tasks. Use local builds and serve with `npm run start` or `next start` (static production server).
- **Log Rotation:** Docker daemon is configured with global log rotation (`max-size: "10m"`, `max-file: "3"`) to prevent disk bloat.
- **Storage Management:** Periodically run `docker builder prune` and audit project directories for `node_modules` or redundant SQL dumps.
