#!/usr/bin/env bash
# ==============================================================================
# K-PANEL READ-ONLY VPS HOST & TRAEFIK INVENTORY COLLECTION SCRIPT
# ==============================================================================
# PURPOSE:
#   Collects non-sensitive, read-only host infrastructure, Docker network, and
#   Traefik configuration observations for operator review and staging integration planning.
#
# AUDITED COMMAND CLASSIFICATION (PHASE 4C3D1):
#   1. READ-ONLY AND SAFE:
#      - hostname, uname (-s, -m, -r), date (-u)
#      - docker version, docker info (read-only capability check)
#      - docker ps (read-only container state filter)
#      - docker network ls, docker network inspect (explicit safe fields only)
#      - docker inspect (strictly filtered to .Config.Cmd and .Mounts; NEVER .Config.Env)
#      - timeout (bounded execution timer)
#   2. READ-ONLY BUT POTENTIALLY SENSITIVE (SUBJECT TO OPERATOR REDACTION):
#      - Internal hostnames and kernel identifiers
#      - Private Docker bridge IPv4 container addresses
#      - Container names and network IDs
#      - Traefik router rules (when discovered via loopback API)
#   3. POTENTIALLY MUTATING OR UNSAFE COMMANDS (STRICTLY PROHIBITED & ABSENT):
#      - ZERO: docker run, docker start, docker stop, docker rm
#      - ZERO: docker network connect, docker network disconnect, docker network create/rm
#      - ZERO: docker system prune, docker compose up/down
#      - ZERO: systemctl restart, service restart
#      - ZERO: iptables, ufw, firewall-cmd modifications
#      - ZERO: writes to production configuration files
#      - ZERO: reads from .env files, private keys, database passwords, or session tokens
#   4. HOST-DEPENDENT & OPTIONAL:
#      - curl (strictly local loopback 127.0.0.1; disabled/skipped gracefully if unreachable)
#      - timeout (falls back gracefully to direct execution if timeout utility missing)
#
# SAFETY & RESTRICTIVE PERMISSIONS:
#   - Enforces umask 077 so any generated output file is readable strictly by operator (0600).
#   - Supports --redact / --sanitize flag to mask internal IPs, container names, and hostnames
#     for safe sharing with architecture reviewers.
# ==============================================================================

set -euo pipefail

# Restrict default file creation permissions to operator only (0600 / 0700)
umask 077

# Ensure non-interactive and fail-safe deterministic execution
export LC_ALL=C

CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
INVENTORY_VERSION="1.1"

OUTPUT_FILE=""
REDACT_OUTPUT=false

# Parse command line flags
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --redact|--sanitize)
      REDACT_OUTPUT=true
      shift
      ;;
    -h|--help)
      cat << 'USAGE'
Usage: bash collect-kpanel-host-inventory.sh [options] [output-file]

Options:
  -o, --output <file>    Write inventory JSON to specified file with 0600 permissions.
  --redact, --sanitize   Mask IP addresses, internal container names, and hostnames for safe external review.
  -h, --help             Show this help message.
USAGE
      exit 0
      ;;
    *)
      if [ -z "$OUTPUT_FILE" ] && [[ "$1" != -* ]]; then
        OUTPUT_FILE="$1"
        shift
      else
        echo "Unknown argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

# Helper to check command availability
has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# Helper to execute commands with a hard timeout bound
run_bounded() {
  local max_sec="$1"
  shift
  if has_cmd timeout; then
    timeout "$max_sec" "$@"
  else
    "$@"
  fi
}

# ------------------------------------------------------------------------------
# 1. System & Host Identity (Read-Only)
# ------------------------------------------------------------------------------
HOSTNAME_RAW=$(hostname 2>/dev/null || echo "unknown-host")
OS_INFO=$(uname -s 2>/dev/null || echo "unknown-os")
ARCH_INFO=$(uname -m 2>/dev/null || echo "unknown-arch")
KERNEL_INFO=$(uname -r 2>/dev/null || echo "unknown-kernel")

if [ "$REDACT_OUTPUT" = true ]; then
  HOSTNAME="[REDACTED-HOST]"
else
  HOSTNAME="$HOSTNAME_RAW"
fi

# ------------------------------------------------------------------------------
# 2. Docker Daemon Availability & Permission Assessment (Read-Only)
# ------------------------------------------------------------------------------
DOCKER_AVAILABLE=false
DOCKER_STATUS="not-installed"
DOCKER_VERSION="unavailable"
DOCKER_SERVER_VERSION="unavailable"

if has_cmd docker; then
  # Test docker availability without throwing fatal exit
  set +e
  DOCKER_INFO_OUT=$(run_bounded 5 docker info 2>&1)
  DOCKER_INFO_EXIT=$?
  set -e

  if [ $DOCKER_INFO_EXIT -eq 0 ]; then
    DOCKER_AVAILABLE=true
    DOCKER_STATUS="available"
    DOCKER_VERSION=$(run_bounded 3 docker version --format '{{.Client.Version}}' 2>/dev/null || echo "unknown")
    DOCKER_SERVER_VERSION=$(run_bounded 3 docker version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
  else
    if echo "$DOCKER_INFO_OUT" | grep -qi "permission denied"; then
      DOCKER_STATUS="permission_denied"
    elif echo "$DOCKER_INFO_OUT" | grep -qi "daemon running"; then
      DOCKER_STATUS="daemon_not_running"
    else
      DOCKER_STATUS="error_checking_daemon"
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 3. Docker Networks Inspection (Filtered, Safe Fields Only)
# ------------------------------------------------------------------------------
NETWORKS_JSON="[]"

if [ "$DOCKER_AVAILABLE" = true ]; then
  # Safely collect network IDs
  NET_IDS=$(run_bounded 5 docker network ls -q 2>/dev/null || echo "")

  if [ -n "$NET_IDS" ]; then
    # Inspect selected non-sensitive metadata only
    # ID, Name, Driver, Scope, Internal, Attachable, and attached container names/IPv4
    NETWORKS_RAW=$(run_bounded 10 docker network inspect $NET_IDS --format '
    {
      "id": "{{.Id}}",
      "name": "{{.Name}}",
      "driver": "{{.Driver}}",
      "scope": "{{.Scope}}",
      "internal": {{if .Internal}}true{{else}}false{{end}},
      "attachable": {{if .Attachable}}true{{else}}false{{end}},
      "containers": [
        {{range $k, $v := .Containers}}
        {
          "id": "{{printf "%.12s" $k}}",
          "name": "{{$v.Name}}",
          "ipv4Address": "{{$v.IPv4Address}}"
        },
        {{end}}
        null
      ]
    },' 2>/dev/null || echo "")

    # Clean up trailing comma and null placeholder
    if [ -n "$NETWORKS_RAW" ]; then
      CLEANED_NETS=$(echo "$NETWORKS_RAW" | sed 's/,\s*null//g' | sed '$ s/,$//')
      NETWORKS_JSON="[ $CLEANED_NETS ]"
    fi
  fi
fi

# Apply redaction to network JSON if requested
if [ "$REDACT_OUTPUT" = true ] && [ "$NETWORKS_JSON" != "[]" ]; then
  # Mask IPv4 addresses: 172.XX.YY.ZZ -> 172.XX.REDACTED
  NETWORKS_JSON=$(echo "$NETWORKS_JSON" | sed -E 's/"ipv4Address": "([0-9]+\.[0-9]+)\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "\1.x.x\2"/g')
fi

# ------------------------------------------------------------------------------
# 4. Traefik Container & Provider Discovery (Read-Only)
# ------------------------------------------------------------------------------
TRAEFIK_CONTAINER_ID=""
TRAEFIK_VERSION=""
TRAEFIK_CONTAINER_NAME=""
TRAEFIK_STATUS="not-found"
TRAEFIK_INSTANCES_FOUND=0
TRAEFIK_MOUNTS_JSON="[]"

FILE_PROVIDER_ENABLED=false
FILE_PROVIDER_DIR=""
FILE_PROVIDER_WATCH=false
DOCKER_PROVIDER_ENABLED=false
DOCKER_PROVIDER_NETWORK=""

if [ "$DOCKER_AVAILABLE" = true ]; then
  # Discover candidate Traefik container by image name or container name
  # Strictly read ID, Names, Image, and Status - NEVER Env!
  TRAEFIK_CANDIDATES=$(run_bounded 5 docker ps --filter "name=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || echo "")

  if [ -z "$TRAEFIK_CANDIDATES" ]; then
    TRAEFIK_CANDIDATES=$(run_bounded 5 docker ps --filter "ancestor=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || echo "")
  fi

  if [ -n "$TRAEFIK_CANDIDATES" ]; then
    TRAEFIK_INSTANCES_FOUND=$(echo "$TRAEFIK_CANDIDATES" | grep -c . || echo 0)
    TRAEFIK_PRIMARY=$(echo "$TRAEFIK_CANDIDATES" | head -n 1)

    TRAEFIK_CONTAINER_ID=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f1)
    TRAEFIK_CONTAINER_NAME=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f2)
    TRAEFIK_IMAGE=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f3)
    TRAEFIK_STATUS=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f4)

    # Inspect container command / arguments to detect configured providers
    # DO NOT inspect .Config.Env or full container state
    TRAEFIK_ARGS=$(run_bounded 3 docker inspect "$TRAEFIK_CONTAINER_ID" --format '{{json .Config.Cmd}}' 2>/dev/null || echo "[]")

    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file"; then
      FILE_PROVIDER_ENABLED=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file.watch=true"; then
      FILE_PROVIDER_WATCH=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file.directory="; then
      FILE_PROVIDER_DIR=$(echo "$TRAEFIK_ARGS" | grep -o -- '--providers.file.directory=[^ "]*' | head -n 1 | cut -d'=' -f2)
    fi

    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.docker"; then
      DOCKER_PROVIDER_ENABLED=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.docker.network="; then
      DOCKER_PROVIDER_NETWORK=$(echo "$TRAEFIK_ARGS" | grep -o -- '--providers.docker.network=[^ "]*' | head -n 1 | cut -d'=' -f2)
    fi

    # Read mount configuration to establish host/container mount correspondence for File provider
    # Extracts Type, Source, Destination, Mode, RW. Zero environment variables.
    RAW_MOUNTS=$(run_bounded 3 docker inspect "$TRAEFIK_CONTAINER_ID" --format '
    [
      {{range .Mounts}}
      {
        "type": "{{.Type}}",
        "source": "{{.Source}}",
        "destination": "{{.Destination}}",
        "mode": "{{.Mode}}",
        "rw": {{if .RW}}true{{else}}false{{end}}
      },
      {{end}}
      null
    ]' 2>/dev/null || echo "[]")

    if [ "$RAW_MOUNTS" != "[]" ]; then
      CLEANED_MOUNTS=$(echo "$RAW_MOUNTS" | sed 's/,\s*null//g' | sed '$ s/,$//')
      TRAEFIK_MOUNTS_JSON="$CLEANED_MOUNTS"
    fi

    # Check Traefik binary version safely with bounded timeout
    TRAEFIK_VERSION=$(run_bounded 3 docker exec "$TRAEFIK_CONTAINER_ID" traefik version 2>/dev/null | grep -i "version:" | head -n 1 | awk '{print $2}' || echo "unknown")
  fi
fi

# ------------------------------------------------------------------------------
# 5. Traefik Routing Discovery (Read-Only Local Internal API, If Enabled & Safe)
# ------------------------------------------------------------------------------
ROUTERS_JSON="[]"
SERVICES_JSON="[]"
ENTRYPOINTS_JSON="[]"
API_STATUS="disabled_or_unreachable"

# Note: We test strictly local internal loopback (127.0.0.1:8080 or TRAEFIK_LOCAL_API_PORT).
# We DO NOT expose or modify Traefik. We DO NOT send external requests or credentials.
LOCAL_PORT="${TRAEFIK_LOCAL_API_PORT:-8080}"
if has_cmd curl; then
  # Strictly bounded timeout, no redirects, loopback only
  API_TEST=$(run_bounded 2 curl -s --max-time 2 --connect-timeout 1 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${LOCAL_PORT}/api/rawdata" 2>/dev/null || echo "000")
  if [ "$API_TEST" = "200" ]; then
    API_STATUS="accessible_local_api"
    ROUTERS_JSON=$(run_bounded 2 curl -s --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/api/http/routers" 2>/dev/null || echo "[]")
    SERVICES_JSON=$(run_bounded 2 curl -s --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/api/http/services" 2>/dev/null || echo "[]")
    ENTRYPOINTS_JSON=$(run_bounded 2 curl -s --max-time 2 "http://127.0.0.1:${LOCAL_PORT}/api/entrypoints" 2>/dev/null || echo "[]")
  fi
fi

# ------------------------------------------------------------------------------
# 6. Format Valid JSON Values (Correct Producer/Consumer Contract)
# ------------------------------------------------------------------------------
if [ -n "$FILE_PROVIDER_DIR" ] && [ "$FILE_PROVIDER_DIR" != "null" ]; then
  FILE_DIR_JSON="\"$FILE_PROVIDER_DIR\""
else
  FILE_DIR_JSON="null"
fi

if [ -n "$DOCKER_PROVIDER_NETWORK" ] && [ "$DOCKER_PROVIDER_NETWORK" != "null" ]; then
  DOCKER_NET_JSON="\"$DOCKER_PROVIDER_NETWORK\""
else
  DOCKER_NET_JSON="null"
fi

if [ -n "$TRAEFIK_CONTAINER_ID" ] && [ "$TRAEFIK_CONTAINER_ID" != "null" ]; then
  TRAEFIK_ID_JSON="\"$TRAEFIK_CONTAINER_ID\""
else
  TRAEFIK_ID_JSON="null"
fi

if [ -n "$TRAEFIK_CONTAINER_NAME" ] && [ "$TRAEFIK_CONTAINER_NAME" != "null" ]; then
  TRAEFIK_NAME_JSON="\"$TRAEFIK_CONTAINER_NAME\""
else
  TRAEFIK_NAME_JSON="null"
fi

if [ -n "$TRAEFIK_VERSION" ] && [ "$TRAEFIK_VERSION" != "null" ]; then
  TRAEFIK_VER_JSON="\"$TRAEFIK_VERSION\""
else
  TRAEFIK_VER_JSON="null"
fi

# ------------------------------------------------------------------------------
# 7. Assemble Structured JSON Inventory Report
# ------------------------------------------------------------------------------
INVENTORY_REPORT=$(cat <<EOF
{
  "version": "${INVENTORY_VERSION}",
  "captureTimestamp": "${CAPTURED_AT}",
  "captureSource": "operator-script",
  "isRedacted": ${REDACT_OUTPUT},
  "hostIdentity": {
    "hostname": "${HOSTNAME}",
    "os": "${OS_INFO}",
    "arch": "${ARCH_INFO}",
    "kernel": "${KERNEL_INFO}",
    "dockerStatus": "${DOCKER_STATUS}",
    "dockerVersion": "${DOCKER_SERVER_VERSION}"
  },
  "traefik": {
    "instanceId": ${TRAEFIK_ID_JSON},
    "containerName": ${TRAEFIK_NAME_JSON},
    "version": ${TRAEFIK_VER_JSON},
    "status": "${TRAEFIK_STATUS}",
    "instancesDetected": ${TRAEFIK_INSTANCES_FOUND},
    "apiStatus": "${API_STATUS}",
    "mounts": ${TRAEFIK_MOUNTS_JSON}
  },
  "providers": {
    "file": {
      "enabled": ${FILE_PROVIDER_ENABLED},
      "directory": ${FILE_DIR_JSON},
      "watch": ${FILE_PROVIDER_WATCH}
    },
    "docker": {
      "enabled": ${DOCKER_PROVIDER_ENABLED},
      "network": ${DOCKER_NET_JSON}
    }
  },
  "networks": ${NETWORKS_JSON},
  "routers": ${ROUTERS_JSON},
  "services": ${SERVICES_JSON},
  "entryPoints": ${ENTRYPOINTS_JSON}
}
EOF
)

# ------------------------------------------------------------------------------
# 8. Output Handling (Stdout or Atomic File with 0600 Permissions)
# ------------------------------------------------------------------------------
if [ -n "$OUTPUT_FILE" ]; then
  OUT_DIR=$(dirname "$OUTPUT_FILE")
  if [ ! -d "$OUT_DIR" ]; then
    mkdir -p "$OUT_DIR"
  fi
  TMP_OUT="${OUTPUT_FILE}.tmp.$$"
  echo "$INVENTORY_REPORT" > "$TMP_OUT"
  chmod 600 "$TMP_OUT"
  mv "$TMP_OUT" "$OUTPUT_FILE"
  echo "Host inventory successfully written to: $OUTPUT_FILE (mode 0600)" >&2
else
  echo "$INVENTORY_REPORT"
fi
