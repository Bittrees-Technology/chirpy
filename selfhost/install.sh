#!/usr/bin/env bash
# Configure a new installation without replacing existing identity material.
set -euo pipefail
umask 077
cd "$(dirname "$0")"
if [ -e gate.env ] || [ -L gate.env ] || [ -e rooms.json ] || [ -L rooms.json ]; then
  echo 'Existing gate.env or rooms.json found. Preserve its keys and edit it deliberately; the installer will not overwrite it.' >&2
  exit 1
fi
command -v node >/dev/null || { echo 'Node 24 or newer is required.' >&2; exit 1; }
ask() { local answer; read -rp "$1: " answer; printf '%s' "$answer"; }
DOMAIN=$(ask 'Public gate domain (TLS must already be configured)')
ORIGIN=$(ask 'Exact Chirpy HTTPS web origin')
RPC=$(ask 'Mainnet HTTPS RPC URL')
REGISTRY=$(ask 'Path to the reviewed room registry JSON')
KEY=${XMTP_GATEKEEPER_PRIVATE_KEY:-}
if [ -z "$KEY" ]; then
  read -rsp 'Gatekeeper private key (blank to generate): ' KEY
  printf '\n'
fi
GATE_SETUP_DOMAIN="$DOMAIN" GATE_SETUP_ORIGIN="$ORIGIN" GATE_SETUP_RPC="$RPC" GATE_SETUP_REGISTRY="$REGISTRY" XMTP_GATEKEEPER_PRIVATE_KEY="$KEY" node configure-gate.mjs
unset KEY
printf '\nBack up both keys separately from the database before starting.\n'
read -rp 'Start the configured gate with Docker Compose? [y/N]: ' GO
if [[ "${GO:-N}" =~ ^[Yy]$ ]]; then
  docker compose --env-file gate.env up -d --build
  echo 'Container started. Verify /health, bot room permissions, and controlled admission before routing users.'
fi
