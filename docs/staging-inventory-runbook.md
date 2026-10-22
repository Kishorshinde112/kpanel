# K-PANEL OPERATOR RUNBOOK: VPS HOST INVENTORY COLLECTION & STAGING PREFLIGHT

**Phase:** 4C3D1 — Real Host Inventory Safety Review & Staging Preflight  
**Target Environment:** Oracle Cloud Ampere A1 ARM64 (Ubuntu, 4 OCPU, 24 GB RAM)  
**Security Guarantee:** STRICTLY READ-ONLY. Zero container lifecycle actions, zero network attachments, zero configuration modifications.

---

## 1. Prerequisites

Before running the inventory script on the Oracle VPS:

1. **Host Access:** SSH access to the Oracle VPS as a user with read permissions for Docker (e.g. member of the `docker` group, or root/sudo read access).
2. **Host Architecture:** Ubuntu Linux on ARM64 (`aarch64`).
3. **Required Utilities:**
   - Standard POSIX utilities: `bash` (v4+), `uname`, `hostname`, `date`, `grep`, `sed`, `awk`, `cut`, `tr`, `head`.
   - `docker` CLI (read-only client).
   - Optional: `timeout` (recommended for bounded command duration), `curl` (strictly loopback tests only).
4. **Existing Workloads Status:**
   - Existing Dokploy, n8n, Traefik, and container workloads MUST remain completely running and untouched.
   - Do NOT stop, restart, or alter any service or firewall.
   - Do NOT expose the Traefik dashboard or API to public interfaces.

---

## 2. Command Audit & Inventory

The collection script (`scripts/collect-kpanel-host-inventory.sh`) executes **exclusively read-only commands** bounded by strict timeouts:

| Command | Purpose | Safety Classification | Bounded Timeout |
| :--- | :--- | :--- | :--- |
| `hostname` | Collects host system name | Safe, read-only | Direct |
| `uname -s, -m, -r` | OS name, architecture, kernel | Safe, read-only | Direct |
| `date -u` | Capture timestamp (UTC) | Safe, read-only | Direct |
| `docker info` | Tests daemon access & permissions | Safe, read-only | 5 seconds |
| `docker version` | Client & server Docker versions | Safe, read-only | 3 seconds |
| `docker network ls -q` | Lists Docker network IDs | Safe, read-only | 5 seconds |
| `docker network inspect <ids>` | Reads network driver, scope, internal status, and attached container names/IPs | Safe, read-only (explicit fields only) | 10 seconds |
| `docker ps --filter "name=traefik"` | Discovers running Traefik candidate container | Safe, read-only | 5 seconds |
| `docker inspect <traefik-id>` | Inspects `.Config.Cmd` and `.Mounts` ONLY | Safe, read-only (strictly filters out `.Config.Env`) | 3 seconds |
| `docker exec <traefik-id> traefik version` | Retrieves Traefik binary version string | Safe, read-only | 3 seconds |
| `curl 127.0.0.1:8080/api/rawdata` | Tests if local loopback API is accessible | Safe, read-only (loopback only, skipped if closed) | 2 seconds |

### Strictly Prohibited and Absent Commands

The script **never** executes:
- `docker run`, `docker start`, `docker stop`, `docker rm`
- `docker network connect`, `docker network disconnect`, `docker network create/rm`
- `docker system prune`, `docker compose up/down`
- `systemctl restart`, `service restart`
- `iptables`, `ufw`, `firewall-cmd` modifications
- Writes to any production directory or reverse-proxy configuration
- Dumps of `.Config.Env` or environment variables

---

## 3. Files Accessed by the Script

The script accesses **zero application secret files**:
- **Accessed:** `/var/run/docker.sock` (Docker daemon Unix domain socket in read-only inspection mode).
- **Accessed:** Virtual pseudo-filesystems read by `uname` and `hostname` (`/proc/version`, `/proc/sys/kernel/hostname`).
- **NEVER Accessed:** `.env` files, TLS certificates (`*.pem`, `*.key`), database passwords, JWT/session secrets, application credentials, or source repositories.

---

## 4. Execution Permissions & Restrictive File Handling

The script enforces restrictive permissions:
1. **Umask 077:** Enforced immediately at script start. Any output file created will have `0600` permissions (readable and writable only by the executing operator).
2. **Atomic Write:** Writes to a temporary file (`<output>.tmp.$$`), sets `chmod 600`, and atomically moves it into place.

---

## 5. Running the Inventory Collection on the Target VPS

### Step 5.1: Transfer Script to Target VPS

From your local operator workstation:
```bash
scp scripts/collect-kpanel-host-inventory.sh user@<oracle-vps-ip>:/home/user/
```

### Step 5.2: Execute Collection Script

On the Oracle VPS:
```bash
# Set execute permission
chmod +x /home/user/collect-kpanel-host-inventory.sh

# Run collection to a restricted output file (umask 077 -> mode 0600)
/home/user/collect-kpanel-host-inventory.sh -o /home/user/kpanel-host-inventory.json
```

If you wish to produce a sanitized inventory directly on the VPS for architecture review:
```bash
/home/user/collect-kpanel-host-inventory.sh --redact -o /home/user/kpanel-host-inventory-redacted.json
```

---

## 6. How to Inspect the Collected Inventory

Before transferring or sharing the inventory, verify that the output contains no secrets:

```bash
# 1. Verify file permissions are strictly 0600
ls -la /home/user/kpanel-host-inventory.json
# Expected: -rw------- 1 user user ...

# 2. Verify valid JSON syntax
python3 -m json.tool /home/user/kpanel-host-inventory.json > /dev/null && echo "VALID JSON"

# 3. Check for any unintentional secret leaks (should return 0 matches)
grep -inE "password|secret|token|key|private" /home/user/kpanel-host-inventory.json || echo "CLEAN: No secret keywords found"

# 4. View Traefik provider and network summary
jq '{traefik: .traefik, providers: .providers, networksCount: (.networks | length), routersCount: (.routers | length)}' /home/user/kpanel-host-inventory.json
```

---

## 7. How to Sanitize Output for Architecture Review

If sharing the inventory with architecture reviewers (such as ChatGPT or external reviewers), sanitize internal IP addresses and hostnames:

```bash
# Option A: Run script with --redact flag (on VPS)
./collect-kpanel-host-inventory.sh --redact -o kpanel-inventory-sanitized.json

# Option B: Use K-Panel's offline harness with --redact (on operator workstation)
node backend/scripts/stagingPreflightHarness.js --inventory kpanel-host-inventory.json --redact --json > kpanel-inventory-sanitized.json
```

### What Gets Redacted:
- Hostname is replaced with `[REDACTED-HOST]`.
- Container IPv4 addresses are masked: `172.28.0.2` → `172.28.x.x`.
- Router domain names can be hashed or preserved based on review requirements.

---

## 8. Secure Transfer to Local Operator Workstation

Transfer the inventory file over encrypted SSH:
```bash
scp user@<oracle-vps-ip>:/home/user/kpanel-host-inventory.json ./kpanel-host-inventory.json
```

**Git Hygiene Notice:**
`kpanel-host-inventory.json` is automatically ignored by `.gitignore`. **NEVER commit raw or real host inventory files into version control.**

---

## 9. Importing into K-Panel's Offline Preflight Harness

On your local workstation, run the offline smoke-test preflight harness:

```bash
# Run preflight against the captured inventory for a target domain and application
node backend/scripts/stagingPreflightHarness.js \
  --inventory ./kpanel-host-inventory.json \
  --domain myapp.kpanel.dev \
  --app demo-app \
  --allow-stale
```

### Output Options:
- **Human-Readable Summary:** Default output displays scenario classification, all 16 check results, blockers, and safety invariant confirmations.
- **Pure JSON Output:** Pass `--json` to output machine-readable evaluation results.
- **Sanitized Output:** Pass `--redact` to generate safe output suitable for architectural reviews.

---

## 10. Common Failure Modes & Troubleshooting

| Observation | Root Cause | Operator Remedy |
| :--- | :--- | :--- |
| `dockerStatus: "permission_denied"` | User executing script is not in `docker` group | Add user to group: `sudo usermod -aG docker $USER` (re-login required), or execute with `sudo`. |
| `dockerStatus: "daemon_not_running"` | Docker daemon is stopped or socket unavailable | Inspect daemon status: `sudo systemctl status docker`. |
| `apiStatus: "disabled_or_unreachable"` | Traefik API is not enabled on loopback port 8080 | **Expected behavior.** Dokploy Traefik keeps the API disabled by default for security. The script continues safely using Docker inspection. |
| `FILE_PROVIDER_NOT_CONFIGURED` (Scenario B) | Traefik was started without `--providers.file` | Traefik has no File provider configured. See Section 11 for Scenario B resolution options. |
| `FOREIGN_NETWORK_FORBIDDEN` (Scenario D) | Target proxy network belongs to Dokploy or n8n | K-Panel refuses to attach to foreign networks. A dedicated custom bridge network must be approved. |
| `STAGING_BLOCKED_STALE_INVENTORY` | Inventory captured > 24 hours ago (or > 60s for activation) | Saved inventory cannot authorize production mutations. Recapture fresh inventory before preflight. |

---

## 11. Interpreting Readiness Decisions & Host Scenarios

### Host Topology Scenarios

- **Scenario A (`DEDICATED_FILE_PROVIDER_AVAILABLE`):**
  - Existing Traefik supports dynamic File provider with `watch: true`.
  - Dynamic route files can be dropped into the mapped dynamic configuration directory without restarting Traefik.
  - Zero downtime risk to Dokploy or n8n.
- **Scenario B (`FILE_PROVIDER_NOT_CONFIGURED`):**
  - Traefik is running but lacks File provider arguments.
  - Enabling File provider would require modifying Traefik startup flags and restarting the container.
  - **Risk:** Restarting Traefik creates a service interruption for existing Dokploy and n8n workloads.
  - **Alternative:** Evaluate whether deploying a dedicated, isolated K-Panel reverse proxy container is safer than mutating shared Traefik.
- **Scenario C (`STAGING_UNVERIFIED`):**
  - Traefik container cannot be identified, or multiple unverified proxies are detected.
  - Deployment is blocked. Operator must explicitly verify proxy container identity.
- **Scenario D (`NO_APPROVED_PROXY_NETWORK`):**
  - No approved isolated bridge network exists that Traefik participates in.
  - Candidate container cannot safely join without breaking isolation or leaking ports.

### Structured Readiness Decision Codes

| Decision Code | Meaning | Can Deploy? |
| :--- | :--- | :--- |
| `STAGING_READY_FOR_AUTHORIZED_TEST` | All 16 checks passed; topology compatible, no route conflicts, network and rollback ready. | **Ready for AUTHORIZED TEST only** (requires explicit operator sign-off). |
| `STAGING_BLOCKED_PROVIDER` | Traefik instance unidentified, provider disabled, or directory path mismatch. | **BLOCKED.** |
| `STAGING_BLOCKED_FOREIGN_ROUTE` | Target domain or route collides with existing Dokploy, n8n, or catch-all router. | **BLOCKED.** |
| `STAGING_BLOCKED_NETWORK` | Approved proxy network missing, unapproved, foreign, or DNS alias collision detected. | **BLOCKED.** |
| `STAGING_BLOCKED_UNREACHABLE` | Backend service unreachable from proxy or probe failed. | **BLOCKED.** |
| `STAGING_BLOCKED_CANDIDATE_HEALTH` | Candidate container is unhealthy, uninspected, or image digest drifted. | **BLOCKED.** |
| `STAGING_BLOCKED_AUTHORIZATION` | Missing active worker lease, stale fencing token, or missing operator approval. | **BLOCKED.** |
| `STAGING_BLOCKED_STALE_INVENTORY` | Inventory evidence is stale (> 24h for planning, > 60s for activation). | **BLOCKED.** |
| `STAGING_BLOCKED_ROLLBACK` | Previous release container unhealthy or rollback target missing. | **BLOCKED.** |
| `STAGING_UNVERIFIED` | Inventory missing, malformed, or proxy ownership unverifiable. | **BLOCKED.** |

---

## 12. Why a "Ready" Decision is NOT Permission to Deploy

A result of `STAGING_READY_FOR_AUTHORIZED_TEST` from the offline harness means:
1. The evaluated topology snapshot satisfies compatibility requirements.
2. No router conflicts or DNS alias collisions were detected in the offline snapshot.
3. Candidate container parameters and rollback plans are well-formed.

**Crucial Production Safety Boundary:**
- An offline readiness report **DOES NOT** grant permission to mutate the live Oracle VPS.
- Saved inventory represents a historical observation (valid for architecture review up to 24h).
- Live activation requires **fresh, verified live evidence captured immediately (≤ 60s) before any route file write**.
- Live traffic switching requires human operator authorization established through a trusted server-side boundary, an active worker lease with an unexpired fencing token, and an atomic file write with durable rollback journal.

---

## 13. Prerequisites for Future Live Staging Testing (Phase 4C3D2+)

Live staging testing will remain blocked until:
1. Architecture reviewer (ChatGPT) reviews the sanitized Oracle VPS inventory.
2. The exact host dynamic configuration path is confirmed (or unresolved server paths are resolved).
3. The exact server-configured approved network ID (`KPANEL_PROXY_NETWORK_ID`) is established in the server environment.
4. Operator signs off on Phase 4C3D2 authorization.
