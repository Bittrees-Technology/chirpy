#!/usr/bin/env bash
# Interactive installer for the self-hosted gate. Prompts for config, writes
# gate.env, and brings the stack up with Docker Compose. Modeled on the
# Parley-Chat relay installer UX (prompt -> write config -> run as a service).
set -euo pipefail
cd "$(dirname "$0")"

echo "== Self-hosted gate installer =="
echo

ask() { # ask "Prompt" "default" -> echoes answer
  local prompt="$1" def="${2:-}" ans
  if [ -n "$def" ]; then read -rp "$prompt [$def]: " ans; echo "${ans:-$def}";
  else read -rp "$prompt: " ans; echo "$ans"; fi
}

DOMAIN=$(ask "Public domain" "gate.example.org")
PORT=$(ask "Gate port" "8788")
RPC=$(ask "Unrestricted mainnet RPC URL")
NS=$(ask "Org namespace (matches OrgConfig.namespace)" "acme")
KV_TOKEN=$(ask "KV/Redis auth token (blank for local redis)" "")

cat > gate.env <<EOF
GATE_DOMAIN=$DOMAIN
GATE_PORT=$PORT
MAINNET_RPC_URL=$RPC
KV_REST_API_URL=http://redis:6379
KV_REST_API_TOKEN=$KV_TOKEN
GATE_NAMESPACE=$NS
EOF
echo
echo "Wrote gate.env."

if [ ! -f gate.Dockerfile ]; then
  echo
  echo "NOTE: the gate service (gate.Dockerfile) ships in the XMTP/gate phase."
  echo "Config is ready; re-run this script to launch once it lands."
  exit 0
fi

read -rp "Bring the stack up now with Docker Compose? [y/N]: " GO
if [[ "${GO:-N}" =~ ^[Yy]$ ]]; then
  docker compose up -d
  echo "Gate up. Point OrgConfig.gateUrl at https://$DOMAIN/api/gate"
else
  echo "Skipped. Run 'docker compose up -d' when ready."
fi
