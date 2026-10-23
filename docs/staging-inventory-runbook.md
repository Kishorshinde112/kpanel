# K-PANEL OPERATOR RUNBOOK: VPS HOST INVENTORY COLLECTION & STAGING PREFLIGHT

**Phase:** 4C3D2 — Operator-Controlled VPS Inventory Preparation
**Target Environment:** Oracle Cloud Ampere A1 ARM64 (Ubuntu, 4 OCPU, 24 GB RAM)
**Security Guarantee:** STRICTLY READ-ONLY. Zero container lifecycle actions, zero network attachments, zero configuration modifications.
**Reviewed Script Checksum (SHA-256):** `87a25ccdf8238cb703be1ad7e05b93729b0f9b2dcd13a538ba51e1a498f064f5`

---

## 1. Safety & Architecture Guardrails

**Strict Operating Boundaries:**
- The automated AI assistant is **NOT authorized to SSH into the Oracle VPS or execute commands on the production host**.
- Only the **human operator** may run commands on the target VPS.
- The collection script executes **exclusively read-only Docker inspection operations**.
- **ZERO container process execution (`docker exec` is completely removed).**
- **ZERO container creation, starting, stopping, restarting, or deletion.**
- **ZERO Docker network creation, connection, disconnection, or modification.**
- **ZERO writes to host configuration files or reverse-proxy directories.**
- **ZERO public API exposure; local Traefik API probing is strictly opt-in (`--probe-api`) and disabled by default.**
- **Do NOT modify host user groups, Docker daemon socket permissions, or firewall settings.** If Docker permissions are denied, the script safely records `permission_denied` as a blocker without modifying host security.

---

## 2. Audited Command Classification

The collection script (`scripts/collect-kpanel-host-inventory.sh`) executes exclusively read-only commands bounded by hard timeouts:

| Command | Purpose | Safety Classification | Bounded Timeout |
| :--- | :--- | :--- | :--- |
| `hostname` | Collects host system name | Safe, read-only | Direct |
| `uname -s, -m, -r` | OS name, architecture, kernel | Safe, read-only | Direct |
| `date -u` | UTC capture timestamp | Safe, read-only | Direct |
| `docker info` | Tests daemon access & permissions | Safe, read-only | 5 seconds |
| `docker version` | Client & server Docker versions | Safe, read-only | 3 seconds |
| `docker network ls -q` | Lists Docker network IDs | Safe, read-only | 5 seconds |
| `docker network inspect <ids>` | Reads network driver, scope, internal status, and attached container names/IPs | Safe, read-only (explicit fields only) | 10 seconds |
| `docker ps --filter "name=traefik"` | Discovers running Traefik candidate container | Safe, read-only | 5 seconds |
| `docker inspect <traefik-id>` | Inspects allowlisted provider flags and bind mounts ONLY | Safe, read-only (strictly filters out `.Config.Env`) | 3 seconds |
| `curl 127.0.0.1:<port>/api/rawdata` | Strictly opt-in via `--probe-api` (disabled by default) | Loopback only, no redirects, bounded size | 2 seconds |

### Commands Prohibited and Strictly Absent
- **ZERO `docker exec`** (no container process execution).
- **ZERO export of raw `.Config.Cmd` or `.Config.Entrypoint` arrays.**
- **ZERO `docker run`, `docker start`, `docker stop`, `docker rm`.**
- **ZERO `docker network connect`, `docker network disconnect`, `docker network create/rm`.**
- **ZERO `docker system prune`, `docker compose up/down`.**
- **ZERO `systemctl restart`, `service restart`.**
- **ZERO `iptables`, `ufw`, `firewall-cmd` modifications.**
- **ZERO reads from `.env` files, TLS keys, database passwords, or session tokens.**

---

## 3. Files Accessed by the Script

The script accesses **zero application secret files**:
- **Accessed:** `/var/run/docker.sock` (Docker daemon Unix domain socket in read-only inspection mode).
- **Accessed:** Virtual pseudo-filesystems read by `uname` and `hostname` (`/proc/version`, `/proc/sys/kernel/hostname`).
- **NEVER Accessed:** `.env` files, TLS certificates (`*.pem`, `*.key`), database passwords, JWT/session secrets, application credentials, or source repositories.

---

## 4. Full Private Inventory vs. Redacted Sharing Summary

The collection process produces two distinct outputs:

1. **Private Full Inventory (`kpanel-host-inventory.json`):**
   - Retained locally on the operator workstation.
   - Enforces `0600` file permissions (`umask 077`).
   - Contains exact network IDs, container IDs, and route rules necessary for offline preflight analysis.
   - **NEVER committed to git and NEVER uploaded to external services.**

2. **Redacted Review Summary (`kpanel-inventory-sanitized.json`):**
   - Generated using the `--redact` / `--sanitize` flag.
   - Masks private IPv4 ranges (`10.x.x.x`, `172.16-31.x.x`, `192.168.x.x`, `100.64-127.x.x`, `127.x.x.x`).
   - Masks private IPv6 ranges (ULA `fc00::/7`, link-local `fe80::/10`, loopback `::1`).
   - Masks system hostname (`[REDACTED-HOST]`) and internal container names.
   - Sanitizes sensitive host filesystem paths and usernames (`/home/[REDACTED-USER]`, `/Users/[REDACTED-USER]`, `/[REDACTED-ROOT]`).
   - Redacts potential credentials in query parameters or command flags.
   - Explicitly notes that exact network authorization and domain ownership cannot be verified from redacted identifiers alone.
   - Includes disclaimer: automated redaction does not guarantee zero sensitive data; operator manual review is required.

---

## 5. Step-by-Step Operator Execution Runbook

Follow these exact steps to collect evidence safely:

### Step 1: Review the Collector Script (Workstation)
Inspect the script content locally before transfer:
```bash
less scripts/collect-kpanel-host-inventory.sh
```
Verify that no mutating commands exist and that `docker exec` is completely absent.

### Step 2: Transfer the Reviewed Script to the Oracle VPS (Workstation)
Transfer the reviewed script securely over SSH. Do not use `curl | bash`:
```bash
scp scripts/collect-kpanel-host-inventory.sh user@<oracle-vps-ip>:/home/user/
```

### Step 3: Check Script Checksum on the VPS (Oracle VPS)
SSH into the Oracle VPS:
```bash
ssh user@<oracle-vps-ip>
```
Compute the SHA-256 checksum of the transferred script:
```bash
sha256sum /home/user/collect-kpanel-host-inventory.sh
```
**Verify:** The output MUST match the reviewed checksum:
`87a25ccdf8238cb703be1ad7e05b93729b0f9b2dcd13a538ba51e1a498f064f5`

If the checksum does not match, do NOT execute the script. Re-transfer from the reviewed repository.

### Step 4: Set Execute Permission (Oracle VPS)
```bash
chmod +x /home/user/collect-kpanel-host-inventory.sh
```

### Step 5: Run Collection & Save Private Inventory (Oracle VPS)
Run the script as the authorized operator to collect the private full inventory:
```bash
# Saves private full inventory with restrictive permissions (0600 via umask 077)
/home/user/collect-kpanel-host-inventory.sh -o /home/user/kpanel-host-inventory.json
```
*Note on API Probing:* By default, no HTTP calls are made. If you have verified that Traefik exposes an internal loopback API on port 8080 and wish to probe it, you may pass `--probe-api` (e.g. `--probe-api --api-port 8080`).

### Step 6: Produce Redacted Review Summary (Oracle VPS)
Generate the sanitized sharing summary:
```bash
/home/user/collect-kpanel-host-inventory.sh --redact -o /home/user/kpanel-inventory-sanitized.json
```
Alternatively, produce both in one run:
```bash
/home/user/collect-kpanel-host-inventory.sh -o /home/user/kpanel-host-inventory.json --summary-output /home/user/kpanel-inventory-sanitized.json
```

### Step 7: Examine Output for Secrets (Oracle VPS)
Verify file permissions and inspect the outputs for any unintended sensitive data:
```bash
# 1. Verify file permissions are strictly 0600
ls -la /home/user/kpanel-host-inventory.json /home/user/kpanel-inventory-sanitized.json
# Expected: -rw------- 1 user user ...

# 2. Verify valid JSON syntax
python3 -m json.tool /home/user/kpanel-inventory-sanitized.json > /dev/null && echo "VALID JSON"

# 3. Check for any credentials or secret keywords
grep -inE "password|secret|token|api_key|private" /home/user/kpanel-inventory-sanitized.json || echo "CLEAN: No secret keywords found"

# 4. View Traefik provider and topology summary
python3 -c "import json; data=json.load(open('/home/user/kpanel-inventory-sanitized.json')); print('Traefik:', data.get('traefik',{}).get('status')); print('Providers:', data.get('providers')); print('Networks:', len(data.get('networks',[]))); print('Routers:', len(data.get('routers',[])))"
```

### Step 8: Transfer Review Summary Securely to Workstation (Workstation)
From your local operator workstation, download the sanitized review summary:
```bash
scp user@<oracle-vps-ip>:/home/user/kpanel-inventory-sanitized.json ./kpanel-inventory-sanitized.json
```
If you need the private full inventory for local offline preflight testing:
```bash
scp user@<oracle-vps-ip>:/home/user/kpanel-host-inventory.json ./kpanel-host-inventory.json
```

**Git Hygiene Notice:**
`kpanel-host-inventory.json` and `kpanel-inventory-sanitized.json` are excluded by `.gitignore`. **NEVER commit raw or real host inventory files into version control.**

### Step 9: Run Offline Preflight Harness (Workstation)
On your local workstation, run K-Panel's offline smoke-test preflight harness:
```bash
node backend/scripts/stagingPreflightHarness.js \
  --inventory ./kpanel-inventory-sanitized.json \
  --domain myapp.kpanel.dev \
  --app demo-app \
  --allow-stale
```
Examine the scenario classification, check results, and blockers.

### Step 10: Send Sanitized Results to ChatGPT for Architecture Review
Share the sanitized output from `kpanel-inventory-sanitized.json` and the preflight report with ChatGPT for architectural evaluation.

---

## 6. Troubleshooting & Permission Handling

| Observation | Root Cause | Operator Guidance |
| :--- | :--- | :--- |
| `dockerStatus: "permission_denied"` | Operator user lacks read permissions on `/var/run/docker.sock` | **Do NOT modify daemon socket permissions or add groups without operator authorization.** If operating as non-root, execute with `sudo /home/user/collect-kpanel-host-inventory.sh ...` or report the permission blocker. |
| `dockerStatus: "daemon_not_running"` | Docker daemon is stopped or socket unavailable | Check daemon status with `systemctl status docker`. Do NOT restart without authorization. |
| `apiStatus: "disabled_or_skipped"` | Default execution (no `--probe-api` flag passed) | **Expected and safe default behavior.** Script relies on host-side Docker inspection. |
| `apiStatus: "disabled_or_unreachable"` | Traefik internal API is disabled on loopback | **Expected behavior.** Dokploy Traefik keeps API disabled by default. Script continues safely. |
| `status: "multiple-instances-detected"` | More than one Traefik container found running | The script lists all candidates. Operator must identify the authoritative container ID before proceeding. |
| `decision: "FILE_PROVIDER_NOT_CONFIGURED"` (Scenario B) | Traefik running without dynamic File provider | Traefik lacks `--providers.file`. See Section 7 for resolution paths. |
| `decision: "FILE_PROVIDER_MOUNT_UNKNOWN"` (Scenario B) | Traefik File provider directory is not bind-mounted to host | Dynamic route directory cannot be written from host. Host bind mount must be identified. |
| `decision: "NO_APPROVED_PROXY_NETWORK"` (Scenario D) | No isolated bridge network matches server configuration | Target network belongs to Dokploy/n8n or is unapproved. Custom bridge network required. |

---

## 7. Interpreting Host Integration Scenarios (A, B, C, D)

- **Scenario A (`DEDICATED_FILE_PROVIDER_AVAILABLE`):**
  - Existing Traefik supports dynamic File provider with `watch: true` mapped to a known host directory.
  - Dedicated dynamic route files can be dropped into the dynamic configuration directory without restarting Traefik.
  - Zero downtime risk to existing Dokploy or n8n workloads.

- **Scenario B (`FILE_PROVIDER_NOT_CONFIGURED` or `FILE_PROVIDER_MOUNT_UNKNOWN`):**
  - Traefik is running, but File provider is absent or dynamic directory is not mapped to host.
  - **Risk:** Restarting Traefik to change startup args causes downtime for existing Dokploy and n8n workloads.
  - **Alternative:** Assess whether deploying a dedicated, isolated K-Panel reverse proxy container is safer than mutating shared Dokploy Traefik.

- **Scenario C (`STAGING_UNVERIFIED` / `MULTIPLE_PROXIES_DETECTED` / `TRAEFIK_NOT_FOUND`):**
  - Traefik container cannot be identified, or multiple unverified proxies are detected.
  - Deployment is strictly blocked. Operator must explicitly verify proxy ownership.

- **Scenario D (`NO_APPROVED_PROXY_NETWORK`):**
  - No approved isolated bridge network exists that Traefik participates in.
  - Attaching candidate container to foreign Dokploy/n8n networks is prohibited. Dedicated proxy bridge network required.

---

## 8. Why a "Ready" Decision is NOT Permission to Deploy

A result of `STAGING_READY_FOR_AUTHORIZED_TEST` from the offline harness means:
1. The evaluated topology snapshot satisfies compatibility requirements.
2. No router conflicts or DNS alias collisions were detected in the offline snapshot.
3. Candidate container parameters and rollback plans are well-formed.

**Crucial Production Safety Boundary:**
- An offline readiness report **DOES NOT** grant permission to mutate the live Oracle VPS.
- Saved inventory represents a historical snapshot (valid for architecture review up to 24h).
- Live activation requires **fresh, verified live evidence captured immediately (≤ 60s) before any route file write**.
- Live traffic switching requires human operator authorization established through a trusted server-side boundary, an active worker lease with an unexpired fencing token, and an atomic file write with durable rollback journal.
