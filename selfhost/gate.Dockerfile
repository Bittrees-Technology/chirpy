# Self-hosted Chirpy gate — runs the XMTP gatekeeper room-join service.
# Build context is the monorepo root (see selfhost/docker-compose.yml).
#
# Base image: Debian 13 "trixie" (glibc 2.41). @xmtp/node-bindings's native addon requires
# GLIBC_2.38+, so a bookworm (2.36) / Vercel-serverless (older) runtime can't load it — that's
# why /api/room-join 500s on Vercel. Keep a glibc base ≥ 2.38; do NOT downgrade to bookworm
# or switch to alpine/musl (the gnu binding won't load).
FROM node:22-trixie-slim
WORKDIR /app

# ca-certificates: the XMTP Rust binding opens its own gRPC/TLS connection using the SYSTEM
# CA bundle (Node's fetch bundles its own, but the native client doesn't), and -slim images
# omit it — without this, Client.create fails with "GrpcBuilder transport error".
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Runtime deps installed at /app so bare imports (@xmtp/node-sdk, viem) resolve for both
# api/room-join.js and packages/core/src/*. Copied first for layer caching.
COPY selfhost/gate.package.json ./package.json
RUN npm install --omit=dev --no-audit --no-fund

# Only the source the gate actually needs: the shared room-join handler, the core gate
# evaluator (TS), and the HTTP server.
COPY packages/core ./packages/core
COPY api/room-join.js ./api/room-join.js
COPY selfhost/gate-server.mjs ./selfhost/gate-server.mjs

ENV GATE_PORT=8788
EXPOSE 8788

# /health needs no XMTP/secret, so it's a safe liveness probe.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.GATE_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# tsx lets the .js handler import the .ts core files (../packages/core/src/*.ts) at runtime.
# Call the binary directly — `npx tsx` can block on a prompt when stdin is closed (detached).
CMD ["node_modules/.bin/tsx", "selfhost/gate-server.mjs"]
