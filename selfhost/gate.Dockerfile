# Build dependencies separately; package managers and shell tools do not ship.
FROM node:22-trixie-slim@sha256:7b8a0c89c54499bee567618f96578e1a12a800f062fbdbfd1fb6a443fa6f6284 AS dependencies
WORKDIR /app
COPY selfhost/gate.package.json ./package.json
COPY selfhost/gate.package-lock.json ./package-lock.json
RUN npm ci --omit=dev --no-fund && npm audit --omit=dev --audit-level=moderate
RUN mkdir -p /data && chown 65532:65532 /data

# Debian 13 supplies the glibc and CA bundle required by the native XMTP SDK.
# Node 24 runs the shared erasable TypeScript directly, without a runtime compiler.
FROM gcr.io/distroless/nodejs24-debian13:nonroot@sha256:774b7d020b24214835769e24c3544835526cd0288f0b094eae48e8b2c2429a79
WORKDIR /app
COPY --from=dependencies /app/package.json /app/package-lock.json ./
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies --chown=65532:65532 /data /data
COPY packages/core ./packages/core
COPY server/room-join.js server/server-utils.js server/ops-utils.js server/gate-client.js server/gate-config.js server/gate-queue.js server/gate-membership.js server/gate-membership-worker.js ./server/
COPY selfhost/gate-server.mjs ./selfhost/gate-server.mjs
ENV GATE_PORT=8788 GATE_DATA_DIR=/data NODE_ENV=production PATH=/nodejs/bin
EXPOSE 8788
VOLUME ["/data"]
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["/nodejs/bin/node", "-e", "fetch('http://127.0.0.1:'+(process.env.GATE_PORT||8788)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["selfhost/gate-server.mjs"]
