#!/usr/bin/env bash
# ==============================================================================
# K-PANEL READ-ONLY VPS HOST & TRAEFIK INVENTORY COLLECTION SCRIPT
# ==============================================================================
# PURPOSE:
#   Collects non-sensitive, read-only host infrastructure, Docker network, and
#   Traefik configuration observations for operator review and staging integration planning.
#
# SAFETY & SECURITY GUARANTEES:
#   - STRICTLY READ-ONLY. Zero container lifecycle actions (no start/stop/create/kill).
#   - ZERO network mutations (no connect/disconnect/create/remove).
#   - ZERO configuration mutations.
#   - ZERO secret, private key, certificate, database password, or .env file reads.
#   - ZERO environment variable dumps (unfiltered docker inspect is strictly prohibited).
#   - NO automatic Traefik API exposure or dashboard enabling.
#   - Output is printed as structured JSON to stdout or redirected to a file.
#
# OPERATOR REVIEW INSTRUCTIONS:
#   1. Review the script contents before executing.
#   2. Run: bash scripts/collect-kpanel-host-inventory.sh > inventory.json
#   3. Inspect inventory.json before providing it to K-Panel or third parties.
#   4. Note on sensitive fields: IP addresses, container names, and domain names
#      are included to assess network routing and domain conflicts. If any domain
#      or hostname is confidential, redact before sharing.
# ==============================================================================

set -euo pipefail

# Ensure non-interactive and fail-safe execution
export LC_ALL=C

CAPTURED_AT=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
INVENTORY_VERSION="1.0"
OUTPUT_FILE="${1:-}"

# Helper to check command availability
has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

# ------------------------------------------------------------------------------
# 1. System & Docker Engine Identity (Read-Only)
# ------------------------------------------------------------------------------
HOSTNAME=$(hostname 2>/dev/null || echo "unknown-host")
OS_INFO=$(uname -s 2>/dev/null || echo "unknown-os")
ARCH_INFO=$(uname -m 2>/dev/null || echo "unknown-arch")
KERNEL_INFO=$(uname -r 2>/dev/null || echo "unknown-kernel")

DOCKER_AVAILABLE=false
DOCKER_VERSION="unavailable"
DOCKER_SERVER_VERSION="unavailable"

if has_cmd docker && docker info >/dev/null 2>&1; then
  DOCKER_AVAILABLE=true
  DOCKER_VERSION=$(docker version --format '{{.Client.Version}}' 2>/dev/null || echo "unknown")
  DOCKER_SERVER_VERSION=$(docker version --format '{{.Server.Version}}' 2>/dev/null || echo "unknown")
fi

# ------------------------------------------------------------------------------
# 2. Docker Networks Inspection (Filtered, Safe Fields Only)
# ------------------------------------------------------------------------------
NETWORKS_JSON="[]"

if [ "$DOCKER_AVAILABLE" = true ]; then
  # Collect network IDs and inspect selected non-sensitive metadata only
  # We extract ID, Name, Driver, Scope, Internal, and attached container names/IPv4
  NETWORKS_RAW=$(docker network inspect $(docker network ls -q) --format '
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
        "id": "{{slice $k 0 12}}",
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

# ------------------------------------------------------------------------------
# 3. Traefik Container & Provider Discovery (Read-Only)
# ------------------------------------------------------------------------------
TRAEFIK_CONTAINER_ID="null"
TRAEFIK_VERSION="unavailable"
TRAEFIK_CONTAINER_NAME="null"
TRAEFIK_STATUS="not-found"
FILE_PROVIDER_ENABLED=false
FILE_PROVIDER_DIR="null"
FILE_PROVIDER_WATCH=false
DOCKER_PROVIDER_ENABLED=false
DOCKER_PROVIDER_NETWORK="null"

if [ "$DOCKER_AVAILABLE" = true ]; then
  # Discover candidate Traefik container by image name or container name
  # Strictly read ID, Names, Image, Status, and Command/Args - NEVER Env!
  TRAEFIK_CANDIDATE=$(docker ps --filter "name=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' | head -n 1)

  if [ -z "$TRAEFIK_CANDIDATE" ]; then
    TRAEFIK_CANDIDATE=$(docker ps --filter "ancestor=traefik" --format '{{.ID}}|{{.Names}}|{{.Image}}|{{.Status}}' | head -n 1)
  fi

  if [ -n "$TRAEFIK_CANDIDATE" ]; then
    TRAEFIK_CONTAINER_ID=$(echo "$TRAEFIK_CANDIDATE" | cut -d'|' -f1)
    TRAEFIK_CONTAINER_NAME=$(echo "$TRAEFIK_CANDIDATE" | cut -d'|' -f2)
    TRAEFIK_IMAGE=$(echo "$TRAEFIK_CANDIDATE" | cut -d'|' -f3)
    TRAEFIK_STATUS=$(echo "$TRAEFIK_CANDIDATE" | cut -d'|' -f4)

    # Inspect container command / arguments to detect configured providers
    # DO NOT inspect .Config.Env or full container state
    TRAEFIK_ARGS=$(docker inspect "$TRAEFIK_CONTAINER_ID" --format '{{json .Config.Cmd}}' 2>/dev/null || echo "[]")

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

    # Check Traefik binary version safely
    TRAEFIK_VERSION=$(docker exec "$TRAEFIK_CONTAINER_ID" traefik version 2>/dev/null | grep -i "version:" | head -n 1 | awk '{print $2}' || echo "unknown")
  fi
fi

# ------------------------------------------------------------------------------
# 4. Traefik Routing Discovery (Read-Only Internal API, If Enabled & Safe)
# ------------------------------------------------------------------------------
ROUTERS_JSON="[]"
SERVICES_JSON="[]"
ENTRYPOINTS_JSON="[]"
API_STATUS="disabled_or_unreachable"

# Note: We test strictly local internal localhost:8080. We DO NOT expose or modify Traefik.
if has_cmd curl; then
  # Bounded timeout, no redirects, loopback only
  API_TEST=$(curl -s --max-time 2 --connect-timeout 1 -o /dev/null -w "%{http_code}" http://127.0.0.1:8080/api/rawdata 2>/dev/null || echo "000")
  if [ "$API_TEST" = "200" ]; then
    API_STATUS="accessible_local_api"
    ROUTERS_JSON=$(curl -s --max-time 2 http://127.0.0.1:8080/api/http/routers 2>/dev/null || echo "[]")
    SERVICES_JSON=$(curl -s --max-time 2 http://127.0.0.1:8080/api/http/services 2>/dev/null || echo "[]")
    ENTRYPOINTS_JSON=$(curl -s --max-time 2 http://127.0.0.1:8080/api/entrypoints 2>/dev/null || echo "[]")
  fi
fi

# ------------------------------------------------------------------------------
# 5. Assemble Structured JSON Inventory Report
# ------------------------------------------------------------------------------
cat <<EOF
{
  "version": "${INVENTORY_VERSION}",
  "captureTimestamp": "${CAPTURED_AT}",
  "captureSource": "operator-script",
  "hostIdentity": {
    "hostname": "${HOSTNAME}",
    "os": "${OS_INFO}",
    "arch": "${ARCH_INFO}",
    "kernel": "${KERNEL_INFO}",
    "dockerVersion": "${DOCKER_SERVER_VERSION}"
  },
  "traefik": {
    "instanceId": "${TRAEFIK_CONTAINER_ID}",
    "containerName": "${TRAEFIK_CONTAINER_NAME}",
    "version": "${TRAEFIK_VERSION}",
    "status": "${TRAEFIK_STATUS}",
    "apiStatus": "${API_STATUS}"
  },
  "providers": {
    "file": {
      "enabled": ${FILE_PROVIDER_ENABLED},
      "directory": ${FILE_PROVIDER_DIR:-null},
      "watch": ${FILE_PROVIDER_WATCH}
    },
    "docker": {
      "enabled": ${DOCKER_PROVIDER_ENABLED},
      "network": ${DOCKER_PROVIDER_NETWORK:-null}
    }
  },
  "networks": ${NETWORKS_JSON},
  "routers": ${ROUTERS_JSON},
  "services": ${SERVICES_JSON},
  "entryPoints": ${ENTRYPOINTS_JSON}
}
EOF
