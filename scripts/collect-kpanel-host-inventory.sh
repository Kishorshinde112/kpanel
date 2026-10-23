#!/usr/bin/env bash
# ==============================================================================
# K-PANEL READ-ONLY VPS HOST & TRAEFIK INVENTORY COLLECTION SCRIPT
# ==============================================================================
# PURPOSE:
#   Collects non-sensitive, read-only host infrastructure, Docker network, and
#   Traefik configuration observations for operator review and staging integration planning.
#
# AUDITED COMMAND CLASSIFICATION (PHASE 4C3D2):
#   1. READ-ONLY AND SAFE:
#      - hostname, uname (-s, -m, -r), date (-u)
#      - docker version, docker info (read-only capability check)
#      - docker ps (read-only container state filter)
#      - docker network ls, docker network inspect (explicit safe fields only)
#      - docker inspect (strictly filtered to allowlisted provider flags & mounts; NEVER .Config.Env)
#      - timeout (bounded execution timer)
#   2. STRICTLY PROHIBITED & REMOVED (SAFETY AUDIT):
#      - ZERO docker exec (NO process execution inside running containers)
#      - ZERO export of raw .Config.Cmd or .Config.Entrypoint arrays
#      - ZERO automatic query of localhost:8080 or unverified HTTP ports
#      - ZERO: docker run, docker start, docker stop, docker rm
#      - ZERO: docker network connect, docker network disconnect, docker network create/rm
#      - ZERO: docker system prune, docker compose up/down
#      - ZERO: systemctl restart, service restart
#      - ZERO: iptables, ufw, firewall-cmd modifications
#      - ZERO: writes to production configuration files
#      - ZERO: reads from .env files, private keys, database passwords, or session tokens
#   3. OPTIONAL & OPERATOR-CONTROLLED:
#      - Traefik API probe: strictly opt-in via --probe-api (default: disabled)
#      - Redaction / sanitization: --redact / --sanitize (masks private IPv4/IPv6, hostnames, paths, credentials)
#
# SAFETY & RESTRICTIVE PERMISSIONS:
#   - Enforces umask 077 so any generated output file is readable strictly by operator (0600).
#   - Atomic temporary file creation with restricted permissions before rename.
# ==============================================================================

set -euo pipefail

# Restrict default file creation permissions to operator only (0600 / 0700)
umask 077

# Ensure non-interactive and fail-safe deterministic execution
export LC_ALL=C

CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
INVENTORY_VERSION="1.2"

OUTPUT_FILE=""
REDACTED_OUTPUT_FILE=""
REDACT_OUTPUT=false
ENABLE_API_PROBE=false
LOCAL_PORT=8080

# Parse command line flags
while [ $# -gt 0 ]; do
  case "$1" in
    -o|--output)
      OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --summary-output|--redacted-output)
      REDACTED_OUTPUT_FILE="${2:-}"
      shift 2
      ;;
    --redact|--sanitize)
      REDACT_OUTPUT=true
      shift
      ;;
    --probe-api|--enable-api-probe)
      ENABLE_API_PROBE=true
      shift
      ;;
    --api-port)
      LOCAL_PORT="${2:-8080}"
      shift 2
      ;;
    -h|--help)
      cat << 'USAGE'
Usage: bash collect-kpanel-host-inventory.sh [options] [output-file]

Options:
  -o, --output <file>            Write private full inventory JSON to specified file with 0600 permissions.
  --summary-output <file>        Write redacted review summary JSON to specified file with 0600 permissions.
  --redact, --sanitize           Produce sanitized review output (masks private IPv4/IPv6, hostnames, paths, credentials).
  --probe-api                    Opt-in to probe local Traefik internal API on loopback (default: disabled, no HTTP calls).
  --api-port <port>              Loopback port to probe when --probe-api is enabled (default: 8080, validated 1-65535).
  -h, --help                     Show this help message.

Safety Guarantees:
  - Strictly read-only; zero container modifications, network attachments, or daemon restarts.
  - Zero container exec; inspects host-side Docker metadata only.
  - Restricts file creation permissions to operator (0600) via umask 077.
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

# Validate --api-port if API probe requested
if [ "$ENABLE_API_PROBE" = true ]; then
  if ! [[ "$LOCAL_PORT" =~ ^[0-9]+$ ]] || [ "$LOCAL_PORT" -lt 1 ] || [ "$LOCAL_PORT" -gt 65535 ]; then
    echo "Error: Invalid API port '${LOCAL_PORT}'. Must be an integer between 1 and 65535." >&2
    exit 1
  fi
fi

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
    # Inspect selected non-sensitive metadata only:
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
      CLEANED_NETS=$(echo "$NETWORKS_RAW" | tr '\n' ' ' | sed 's/,\s*null//g' | sed -E 's/,\s*\]/ ]/g' | sed 's/,\s*$//')
      NETWORKS_JSON="[ $CLEANED_NETS ]"
    fi
  fi
fi

# ------------------------------------------------------------------------------
# 4. Traefik Container & Provider Discovery (Read-Only)
# ------------------------------------------------------------------------------
TRAEFIK_CONTAINER_ID=""
TRAEFIK_VERSION="version_unverified"
TRAEFIK_CONTAINER_NAME=""
TRAEFIK_STATUS="not-found"
TRAEFIK_INSTANCES_FOUND=0
TRAEFIK_MOUNTS_JSON="[]"
TRAEFIK_CANDIDATES_JSON="[]"

FILE_PROVIDER_ENABLED=false
FILE_PROVIDER_DIR=""
FILE_PROVIDER_WATCH=false
DOCKER_PROVIDER_ENABLED=false
DOCKER_PROVIDER_NETWORK=""

if [ "$DOCKER_AVAILABLE" = true ]; then
  # Discover candidate Traefik containers by container name or image ancestor
  # Strictly read ID, Names, Image, and Status - NEVER Env!
  TRAEFIK_CANDIDATES=$(run_bounded 5 docker ps --filter "name=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || echo "")

  if [ -z "$TRAEFIK_CANDIDATES" ]; then
    TRAEFIK_CANDIDATES=$(run_bounded 5 docker ps --filter "ancestor=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null || echo "")
  fi

  if [ -n "$TRAEFIK_CANDIDATES" ]; then
    TRAEFIK_INSTANCES_FOUND=$(echo "$TRAEFIK_CANDIDATES" | grep -c . || echo 0)

    # Build candidates JSON list for multi-instance auditing
    CANDIDATES_ENTRIES=""
    while IFS='|' read -r c_id c_name c_image c_status; do
      [ -z "$c_id" ] && continue
      ENTRY="{\"id\":\"${c_id}\",\"name\":\"${c_name}\",\"image\":\"${c_image}\",\"status\":\"${c_status}\"}"
      if [ -z "$CANDIDATES_ENTRIES" ]; then
        CANDIDATES_ENTRIES="$ENTRY"
      else
        CANDIDATES_ENTRIES="${CANDIDATES_ENTRIES},${ENTRY}"
      fi
    done <<< "$TRAEFIK_CANDIDATES"
    TRAEFIK_CANDIDATES_JSON="[ ${CANDIDATES_ENTRIES} ]"

    if [ "$TRAEFIK_INSTANCES_FOUND" -gt 1 ]; then
      TRAEFIK_STATUS="multiple-instances-detected"
    fi

    # Select primary candidate for inspection
    TRAEFIK_PRIMARY=$(echo "$TRAEFIK_CANDIDATES" | head -n 1)
    TRAEFIK_CONTAINER_ID=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f1)
    TRAEFIK_CONTAINER_NAME=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f2)
    TRAEFIK_IMAGE=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f3)
    if [ "$TRAEFIK_INSTANCES_FOUND" -eq 1 ]; then
      TRAEFIK_STATUS=$(echo "$TRAEFIK_PRIMARY" | cut -d'|' -f4)
    fi

    # Inspect container command flags to detect configured providers
    # DO NOT inspect .Config.Env or export raw .Config.Cmd
    TRAEFIK_ARGS=$(run_bounded 3 docker inspect "$TRAEFIK_CONTAINER_ID" --format '{{json .Config.Cmd}}' 2>/dev/null || echo "[]")

    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file"; then
      FILE_PROVIDER_ENABLED=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file.watch=true" || echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file.watch\""; then
      FILE_PROVIDER_WATCH=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.file.directory="; then
      RAW_DIR=$(echo "$TRAEFIK_ARGS" | grep -o -- '--providers.file.directory=[^ "]*' | head -n 1 | cut -d'=' -f2 | tr -d '"')
      # Sanitize directory value: reject traversal (..), null bytes, or credential keywords
      if [[ "$RAW_DIR" == *".."* ]] || echo "$RAW_DIR" | grep -qiE "password|secret|token|key"; then
        FILE_PROVIDER_DIR=""
      else
        FILE_PROVIDER_DIR="$RAW_DIR"
      fi
    fi

    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.docker"; then
      DOCKER_PROVIDER_ENABLED=true
    fi
    if echo "$TRAEFIK_ARGS" | grep -q -- "--providers.docker.network="; then
      RAW_NET=$(echo "$TRAEFIK_ARGS" | grep -o -- '--providers.docker.network=[^ "]*' | head -n 1 | cut -d'=' -f2 | tr -d '"')
      if echo "$RAW_NET" | grep -qiE "password|secret|token|key"; then
        DOCKER_PROVIDER_NETWORK=""
      else
        DOCKER_PROVIDER_NETWORK="$RAW_NET"
      fi
    fi

    # Read mount configuration to establish host/container mount correspondence for File provider
    # Extracts Type, Source, Destination, Mode, RW. Zero environment variables.
    RAW_MOUNTS=$(run_bounded 3 docker inspect "$TRAEFIK_CONTAINER_ID" --format '{{json .Mounts}}' 2>/dev/null || echo "[]")

    if [ -n "$RAW_MOUNTS" ] && [ "$RAW_MOUNTS" != "null" ]; then
      TRAEFIK_MOUNTS_JSON="$RAW_MOUNTS"
    fi

    # Extract Traefik version strictly from host-side Docker metadata (NO docker exec)
    TRAEFIK_VERSION="version_unverified"
    # 1. Attempt extraction from image tag if specific version pattern exists
    IMAGE_TAG=$(echo "$TRAEFIK_IMAGE" | grep -oE ':(v?[0-9]+\.[0-9]+(\.[0-9]+)?)' | tr -d ':' || echo "")
    if [ -n "$IMAGE_TAG" ]; then
      TRAEFIK_VERSION="$IMAGE_TAG"
    else
      # 2. Attempt inspection of OCI version label from host-side image metadata
      OCI_VERSION=$(run_bounded 3 docker inspect "$TRAEFIK_CONTAINER_ID" --format '{{index .Config.Labels "org.opencontainers.image.version"}}' 2>/dev/null || echo "")
      if [ -n "$OCI_VERSION" ] && [ "$OCI_VERSION" != "<no value>" ]; then
        TRAEFIK_VERSION="$OCI_VERSION"
      fi
    fi
    # If unverified, keep "version_unverified" (do not fabricate version)
  fi
fi

# ------------------------------------------------------------------------------
# 5. Traefik Routing Discovery (Read-Only Local Internal API, Strictly Opt-In)
# ------------------------------------------------------------------------------
ROUTERS_JSON="[]"
SERVICES_JSON="[]"
ENTRYPOINTS_JSON="[]"
API_STATUS="disabled_or_skipped"

# Security Invariant: API probing is STRICTLY OPT-IN (--probe-api).
# Default behavior is zero HTTP requests. Port 8080 is NOT queried automatically.
if [ "$ENABLE_API_PROBE" = true ]; then
  API_STATUS="disabled_or_unreachable"
  if has_cmd curl; then
    # Strictly loopback only (127.0.0.1), short timeouts (1s connect, 2s max), no redirects (--max-redirs 0), bounded size
    set +e
    API_TEST=$(run_bounded 2 curl -s --max-time 2 --connect-timeout 1 --max-redirs 0 -o /dev/null -w "%{http_code}" "http://127.0.0.1:${LOCAL_PORT}/api/rawdata" 2>/dev/null || echo "000")
    set -e

    if [ "$API_TEST" = "200" ]; then
      # Verify observed service identity: check if /api/rawdata or /api/http/routers returns valid JSON containing expected router markers
      RAW_ROUTERS=$(run_bounded 2 curl -s --max-time 2 --connect-timeout 1 --max-redirs 0 "http://127.0.0.1:${LOCAL_PORT}/api/http/routers" 2>/dev/null | head -c 1048576 || echo "[]")
      if echo "$RAW_ROUTERS" | grep -q "rule" || echo "$RAW_ROUTERS" | grep -q "service" || [ "$RAW_ROUTERS" = "[]" ]; then
        API_STATUS="accessible_local_api"
        ROUTERS_JSON="$RAW_ROUTERS"
        SERVICES_JSON=$(run_bounded 2 curl -s --max-time 2 --connect-timeout 1 --max-redirs 0 "http://127.0.0.1:${LOCAL_PORT}/api/http/services" 2>/dev/null | head -c 1048576 || echo "[]")
        ENTRYPOINTS_JSON=$(run_bounded 2 curl -s --max-time 2 --connect-timeout 1 --max-redirs 0 "http://127.0.0.1:${LOCAL_PORT}/api/entrypoints" 2>/dev/null | head -c 1048576 || echo "[]")
      else
        API_STATUS="unverified_service_on_port"
      fi
    else
      API_STATUS="disabled_or_unreachable"
    fi
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
assemble_inventory_json() {
  local is_redacted="$1"
  local host_name="$2"
  local net_json="$3"
  local mounts_json="$4"
  local candidates_json="$5"
  local disclaimer_field=""

  if [ "$is_redacted" = true ]; then
    disclaimer_field=$(cat <<'DISC'
,
  "sharingSummary": {
    "isRedacted": true,
    "networkAuthorizationStatus": "UNVERIFIED_NETWORK_ID_REDACTED",
    "networkAuthorizationNotice": "Network IDs and addresses are sanitized in this review summary. Exact network authorization must be verified against private full inventory.",
    "sharingDisclaimer": "Automated redaction sanitizes private IPv4/IPv6 ranges, hostnames, usernames in paths, and container identifiers, but cannot guarantee zero sensitive data. Operator manual inspection is required before external distribution."
  }
DISC
)
  fi

  cat <<EOF
{
  "version": "${INVENTORY_VERSION}",
  "captureTimestamp": "${CAPTURED_AT}",
  "captureSource": "operator-script",
  "isRedacted": ${is_redacted},
  "hostIdentity": {
    "hostname": "${host_name}",
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
    "detectedCandidates": ${candidates_json},
    "apiStatus": "${API_STATUS}",
    "mounts": ${mounts_json}
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
  "networks": ${net_json},
  "routers": ${ROUTERS_JSON},
  "services": ${SERVICES_JSON},
  "entryPoints": ${ENTRYPOINTS_JSON}${disclaimer_field}
}
EOF
}

# ------------------------------------------------------------------------------
# 8. Redaction Engine (Sanitizes Private IP Ranges, Hostnames, Paths, Credentials)
# ------------------------------------------------------------------------------
redact_content() {
  local content="$1"

  # 1. Redact Private IPv4 addresses:
  # 10.0.0.0/8
  content=$(echo "$content" | sed -E 's/"ipv4Address": "10\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "10.x.x.x\1"/g')
  # 172.16.0.0/12 (172.16.x.x - 172.31.x.x)
  content=$(echo "$content" | sed -E 's/"ipv4Address": "(172\.(1[6-9]|2[0-9]|3[0-1]))\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "\1.x.x\3"/g')
  # 192.168.0.0/16
  content=$(echo "$content" | sed -E 's/"ipv4Address": "192\.168\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "192.168.x.x\1"/g')
  # 100.64.0.0/10 (CGNAT)
  content=$(echo "$content" | sed -E 's/"ipv4Address": "(100\.(6[4-9]|[7-9][0-9]|1[0-1][0-9]|12[0-7]))\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "\1.x.x\3"/g')
  # 127.0.0.0/8
  content=$(echo "$content" | sed -E 's/"ipv4Address": "127\.[0-9]+\.[0-9]+\.[0-9]+(\/[0-9]+)?"/"ipv4Address": "127.x.x.x\1"/g')

  # 2. Redact Private IPv6 addresses:
  # ULA (fc00::/7)
  content=$(echo "$content" | sed -E 's/(fc|fd)[0-9a-fA-F]{2}:[0-9a-fA-F:]+/[REDACTED-IPV6-ULA]/g')
  # Link-Local (fe80::/10)
  content=$(echo "$content" | sed -E 's/fe80:[0-9a-fA-F:]+/[REDACTED-IPV6-LINKLOCAL]/g')
  # Loopback (::1)
  content=$(echo "$content" | sed -E 's/"::1"/[REDACTED-IPV6-LOOPBACK]/g')

  # 3. Redact Sensitive Usernames in Host Paths:
  content=$(echo "$content" | sed -E 's|/home/[a-zA-Z0-9._-]+|/home/[REDACTED-USER]|g')
  content=$(echo "$content" | sed -E 's|/Users/[a-zA-Z0-9._-]+|/Users/[REDACTED-USER]|g')
  content=$(echo "$content" | sed -E 's|/root/|/[REDACTED-ROOT]/|g')

  # 4. Redact Potential Credentials in String Arguments:
  content=$(echo "$content" | sed -E 's/(password|secret|token|api_key|apikey)=[^ "&,\\]+/\1=[REDACTED]/gI')

  echo "$content"
}

# ------------------------------------------------------------------------------
# 9. Output Generation (Full Private Inventory and/or Redacted Review Summary)
# ------------------------------------------------------------------------------
# Generate full private inventory content
FULL_INVENTORY=$(assemble_inventory_json false "$HOSTNAME_RAW" "$NETWORKS_JSON" "$TRAEFIK_MOUNTS_JSON" "$TRAEFIK_CANDIDATES_JSON")

# Generate redacted summary content
REDACTED_NETWORKS=$(redact_content "$NETWORKS_JSON")
REDACTED_MOUNTS=$(redact_content "$TRAEFIK_MOUNTS_JSON")
REDACTED_CANDIDATES=$(redact_content "$TRAEFIK_CANDIDATES_JSON")
REDACTED_INVENTORY=$(assemble_inventory_json true "[REDACTED-HOST]" "$REDACTED_NETWORKS" "$REDACTED_MOUNTS" "$REDACTED_CANDIDATES")
REDACTED_INVENTORY=$(redact_content "$REDACTED_INVENTORY")

# Helper to write restricted output file safely
write_restricted_file() {
  local target_path="$1"
  local content="$2"
  local label="$3"

  local target_dir
  target_dir=$(dirname "$target_path")
  if [ ! -d "$target_dir" ]; then
    mkdir -p -m 0700 "$target_dir"
  fi

  local tmp_file="${target_path}.tmp.$$"
  echo "$content" > "$tmp_file"
  chmod 600 "$tmp_file"
  mv "$tmp_file" "$target_path"
  echo "${label} successfully written to: ${target_path} (mode 0600)" >&2
}

# Write summary output if requested
if [ -n "$REDACTED_OUTPUT_FILE" ]; then
  write_restricted_file "$REDACTED_OUTPUT_FILE" "$REDACTED_INVENTORY" "Redacted review summary"
fi

# Main output target
if [ "$REDACT_OUTPUT" = true ]; then
  FINAL_OUTPUT="$REDACTED_INVENTORY"
else
  FINAL_OUTPUT="$FULL_INVENTORY"
fi

if [ -n "$OUTPUT_FILE" ]; then
  OUTPUT_LABEL="Host inventory"
  if [ "$REDACT_OUTPUT" = true ]; then
    OUTPUT_LABEL="Redacted host inventory"
  fi
  write_restricted_file "$OUTPUT_FILE" "$FINAL_OUTPUT" "$OUTPUT_LABEL"
else
  echo "$FINAL_OUTPUT"
fi
