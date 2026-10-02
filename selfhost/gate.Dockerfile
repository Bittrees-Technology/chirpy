# Build dependencies separately; package managers and shell tools do not ship.
FROM node:22-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS dependencies
WORKDIR /app
COPY selfhost/gate.package.json ./package.json
COPY selfhost/gate.package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-fund && npm audit --omit=dev --audit-level=moderate
RUN mkdir -p /data && chown 65532:65532 /data

# Debian 13 supplies the glibc and CA bundle required by the native XMTP SDK.
# Node 24 runs the shared erasable TypeScript directly, without a runtime compiler.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:9eeb7f5887d0e239e78264b06f7f11d2e14be534050481803a9e4728fcdd278e
WORKDIR /app
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies --chown=65532:65532 /data /data
COPY packages/core ./packages/core
COPY server/room-join.js server/server-utils.js server/ops-utils.js server/gate-client.js server/gate-config.js server/gate-queue.js server/gate-membership.js server/gate-membership-worker.js server/native-origins.js server/gate-health.js server/gate-role-authority.js ./server/
COPY selfhost/gate-server.mjs selfhost/gate-snapshot.mjs ./selfhost/
ENV GATE_PORT=8788 GATE_BIND_HOST=0.0.0.0 GATE_DATA_DIR=/data NODE_ENV=production PATH=/nodejs/bin
EXPOSE 8788
VOLUME ["/data"]
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATE_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["selfhost/gate-server.mjs"]
