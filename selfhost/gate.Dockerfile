# Self-hosted Chirpy gate — runs the XMTP gatekeeper room-join service.
# Build context is the monorepo root (see selfhost/docker-compose.yml).
#
# Debian (glibc) base on purpose: @xmtp/node-sdk ships glibc-linked native bindings, so do
# NOT switch this to an alpine/musl image.
FROM node:22-bookworm-slim
WORKDIR /app

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
CMD ["npx", "tsx", "selfhost/gate-server.mjs"]
