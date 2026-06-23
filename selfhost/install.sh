#!/usr/bin/env bash
# Interactive installer for the self-hosted Chirpy gate. Prompts for config, writes
# gate.env, and (optionally) brings the stack up with Docker Compose.
set -euo pipefail
cd "$(dirname "$0")"

echo "== Self-hosted Chirpy gate installer =="
echo "Runs the XMTP gatekeeper room-join service for your gated rooms."
echo

ask() { # ask "Prompt" "default" -> echoes answer
  local prompt="$1" def="${2:-}" ans
  if [ -n "$def" ]; then read -rp "$prompt [$def]: " ans; echo "${ans:-$def}";
  else read -rp "$prompt: " ans; echo "$ans"; fi
}

DOMAIN=$(ask "Public domain for the gate" "gate.example.org")
PORT=$(ask "Gate port" "8788")
ORIGIN=$(ask "Chirpy web app origin (CORS allow-origin)" "https://chirpy.example.org")
RPC=$(ask "Unrestricted mainnet RPC URL")

echo
if [ -n "${XMTP_GATEKEEPER_PRIVATE_KEY:-}" ]; then
  KEY="$XMTP_GATEKEEPER_PRIVATE_KEY"
  echo "Using XMTP_GATEKEEPER_PRIVATE_KEY from the environment."
else
  echo "Gatekeeper key: paste an existing 0x private key, or leave blank to generate one."
  KEY=$(ask "XMTP_GATEKEEPER_PRIVATE_KEY (0x…, blank to generate)" "")
  if [ -z "$KEY" ]; then
    if command -v node >/dev/null 2>&1; then
      KEY=$(node gen-gatekeeper-key.mjs --quiet)
      echo "Generated a new gatekeeper key (its address is printed below)."
      node -e "import('viem/accounts').then(m=>console.log('  gatekeeper address:', m.privateKeyToAccount(process.argv[1]).address))" "$KEY" 2>/dev/null || true
    else
      echo "node not found — cannot generate a key. Re-run with XMTP_GATEKEEPER_PRIVATE_KEY set." >&2
      exit 1
    fi
  fi
fi

cat > gate.env <<EOF
GATE_DOMAIN=$DOMAIN
GATE_PORT=$PORT
GATE_ALLOW_ORIGIN=$ORIGIN
MAINNET_RPC_URL=$RPC
XMTP_GATEKEEPER_PRIVATE_KEY=$KEY
EOF
chmod 600 gate.env
echo
echo "Wrote gate.env (chmod 600 — keep it secret; it holds the gatekeeper key)."

read -rp "Bring the gate up now with Docker Compose? [y/N]: " GO
if [[ "${GO:-N}" =~ ^[Yy]$ ]]; then
  docker compose up -d --build
  echo
  echo "Gate up. Add the gatekeeper address as a super-admin of each gated room, then point"
  echo "the org's OrgConfig.gateUrl at:  https://$DOMAIN/api/room-join"
else
  echo "Skipped. Run 'docker compose up -d --build' when ready."
fi
