# Chirpy rollout, rollback, and recovery runbook

This is the operator-facing release runbook for the current Chirpy production
surface:

- the web app plus `/api/health`, `/api/usersync`, and `/api/workflow-event`
  on the linked Vercel project `chirpy`
- the self-hosted gatekeeper service that serves `POST /api/room-join`
  from `selfhost/gate-server.mjs`

Use this runbook for rollout, health checks, rollback, and incident recovery.
Keep workflow YAML changes, tag automation, and release-routing changes out of
this document.

## Release topology

- **Web:** Vercel project `chirpy` (see `.vercel/project.json`).
- **Gatekeeper:** always-on self-hosted process or container. The checked-in
  Fly config is `selfhost/fly.toml`; the generic container path is documented
  in `selfhost/DEPLOY.md`.
- **Org routing:** every production gated org must set `OrgConfig.gateUrl` to
  the self-hosted gate URL, for example
  `https://gate.example.org/api/room-join`.

Do **not** rely on the web deployment's same-origin `/api/room-join` for a
production gated rollout. `@xmtp/node-sdk` requires native bindings that do not
run on Vercel serverless.

## Prerequisites

Run all commands from the repo root unless stated otherwise.

```bash
pnpm install
```

Required operator tooling:

- `pnpm`
- `curl`
- `jq`
- `vercel`
- `fly` if the gate runs on Fly.io

Export the environment you are operating on:

```bash
export CHIRPY_URL=https://chirpy.bittrees.org
export GATE_URL=https://gate.example.org
export FLY_APP=chirpy-gate                # only if the gate runs on Fly
```

## Migration note

This rollout has **no schema/data migration step**. The operator sequence covers deployment
config, web promotion, gate promotion, health checks, and rollback only.

## Equivalent local release proof

Use this when you need rollout acceptance evidence before a staging or
production promotion:

```bash
pnpm rollout:proof
```

The proof command:

- validates `/api/health` under the supported external-gate topology
- exercises `/api/workflow-event` with a release verification payload
- starts the self-hosted gate locally and requires `GET /health` to return
  `200 OK`

## Preflight

1. Confirm the repo is locally healthy.

```bash
pnpm typecheck
```

2. Capture the current production deployment and the gate release history
   before changing anything.

```bash
vercel list chirpy --environment production
fly releases --app "$FLY_APP" --image
```

3. Verify the current web runtime.

```bash
curl -fsS "$CHIRPY_URL/api/health" | jq
```

Expected minimum pass conditions:

- `.ok == true`
- `.runtime.transport == "xmtp"` for the live XMTP surface
- `.readiness.gateReady == true`
- `.readiness.releaseReady == true`
- the `usersync` check is not degraded
- no unexpected spike in `.blockingIssues`

Important nuance: `/api/health` reports the web runtime's view of routing and
release metadata. When `CHIRPY_EXTERNAL_GATE_URL` is set it will report
`runtime.gateMode == "external"` and treat the supported self-hosted topology as
ready. The external gate `/health` probe below is still the authoritative
liveness check for room-join service.

4. Verify the gatekeeper before touching the web deployment.

```bash
curl -fsS "$GATE_URL/health" | jq
```

Expected response:

```json
{"ok":true,"status":"ok"}
```

5. Check for active production errors before rollout.

```bash
vercel logs --environment production --status-code 5xx --since 30m
```

If production is already unhealthy, stop and recover first instead of stacking a
new deploy onto an incident.

## Rollout sequence

### 1. Record rollback targets

Keep the previous good targets visible in your terminal or incident note:

```bash
vercel list chirpy --environment production
fly releases --app "$FLY_APP" --image
```

- For Vercel, note the previous production deployment URL or `dpl_...` id.
- For Fly, note the previous good `registry.fly.io/<app>:...` image reference.

### 2. Roll out the gatekeeper first when the gate image or gate env changed

Fly.io:

```bash
fly deploy \
  --app "$FLY_APP" \
  --config selfhost/fly.toml \
  --dockerfile selfhost/gate.Dockerfile
curl -fsS "$GATE_URL/health" | jq
```

Generic container host:

```bash
docker build -f selfhost/gate.Dockerfile -t chirpy-gate .
docker run -d --name chirpy-gate \
  -p 8788:8788 \
  --env-file selfhost/gate.env \
  chirpy-gate
curl -fsS "$GATE_URL/health" | jq
```

If the gate image and gate secrets did not change, keep the existing gate
release in place and move to the web deployment.

### 3. Deploy the web app to production

```bash
vercel deploy --prod
```

If you are deploying a prebuilt output instead of building during deploy:

```bash
vercel build
vercel deploy --prebuilt --prod
```

### 4. Verify production immediately after promotion

Check the deployment summary or logs for the just-promoted web release:

```bash
vercel logs --environment production --status-code 5xx --since 5m
curl -fsS "$CHIRPY_URL/api/health" | jq
curl -fsS "$GATE_URL/health" | jq
```

Optional telemetry ping for release bookkeeping:

```bash
curl -fsS -X POST "$CHIRPY_URL/api/workflow-event" \
  -H 'content-type: application/json' \
  -d '{
    "event":"release.verify",
    "releasePhase":"postdeploy",
    "result":"ok",
    "environment":"production",
    "deployment":"'"$CHIRPY_URL"'",
    "check":"health"
  }'
```

### 5. Run the operator smoke tests

The release is not complete until all of the following are true:

- A qualifying wallet can join a gated room through the configured external
  `gateUrl`.
- A non-qualifying wallet is denied.
- Existing DMs still load after an org switch.
- `/api/usersync` does not fail because of missing KV configuration.

## Rollback

### Web rollback (Vercel)

Use this when the web deployment breaks the app or introduces a 5xx spike.

```bash
vercel logs --environment production --status-code 5xx --since 30m
vercel list chirpy --environment production
vercel rollback <previous-deployment-url-or-id>
vercel rollback status
curl -fsS "$CHIRPY_URL/api/health" | jq
vercel logs --environment production --status-code 5xx --since 5m
```

If you need to re-promote a deployment after rollback:

```bash
vercel promote <deployment-url-or-id>
vercel promote status
```

### Gate rollback (Fly)

Use this when the external gate health check fails or room joins regress after a
gate deploy.

```bash
fly releases --app "$FLY_APP" --image
fly deploy \
  --app "$FLY_APP" \
  --image <previous-image-ref> \
  --config selfhost/fly.toml
curl -fsS "$GATE_URL/health" | jq
```

Fly rollback redeploys the previous VM image. It does **not** roll back any
application data for you. For Chirpy that mainly means KV-backed sync state and
room membership are not time-traveled by the platform.

### Gate rollback (generic container host)

Re-run the previous known-good image or compose release for the gate host, then
re-check:

```bash
curl -fsS "$GATE_URL/health" | jq
```

## Recovery guide

### `/api/health` is down or production 5xx spikes after the web deploy

- Roll back the web release first with `vercel rollback`.
- Verify the recovery with `vercel rollback status`, `vercel logs`, and
  `curl "$CHIRPY_URL/api/health"`.

### `/api/usersync` writes return `503`

Likely cause: the web deployment is missing `KV_REST_API_URL` and
`KV_REST_API_TOKEN` or the Upstash equivalents.

Action:

1. Restore the missing KV environment values on the web deployment.
2. Redeploy the web app.
3. Re-check `curl "$CHIRPY_URL/api/health" | jq`.

Do not treat an XMTP rollout as healthy while usersync remains degraded.

### `"$GATE_URL/health"` fails or times out

Likely cause: the gate process is down, the host is unhealthy, or the gate
secrets were lost.

Action:

1. If the gate changed, roll it back with the Fly or container rollback steps
   above.
2. Re-apply `XMTP_GATEKEEPER_PRIVATE_KEY`, `MAINNET_RPC_URL`, and
   `GATE_ALLOW_ORIGIN` if a secrets change caused the outage.
3. Re-check `curl "$GATE_URL/health" | jq` before touching the web deploy.

### Room join returns `403 {"error":"gatekeeper is not a room super-admin"}`

Likely cause: the gatekeeper bot was not added to an older gated room.

Action:

1. Add the current `VITE_GATEKEEPER_ADDRESS` as a super-admin to the affected
   room.
2. Re-run the qualifying wallet join test.

This is usually a room-setup fix, not a code rollback.

### Room join returns `403 {"error":"gate check failed"}`

Likely cause: the wallet genuinely does not satisfy the room gate, or the room
gate / org config was changed incorrectly.

Action:

1. Validate the room's gate rules and the org's config.
2. Test both one qualifying and one non-qualifying wallet before escalating it
   as a service incident.

### Room join returns Vercel `FUNCTION_INVOCATION_FAILED` or other native-binding errors

Likely cause: traffic is still pointing at the same-origin Vercel
`/api/room-join` instead of the external self-hosted gate.

Action:

1. Restore the affected org's `gateUrl` to the external gate endpoint.
2. Verify `curl "$GATE_URL/health" | jq`.
3. Re-run the gated-room smoke test.

Do not hotfix this by trying to force the XMTP gatekeeper back into Vercel
serverless.

### `/api/health` warns about the gatekeeper while the external gate is healthy

This can happen if the web deployment intentionally omits gatekeeper secrets and
all production orgs use the external `gateUrl`.

Action:

1. Treat the external gate `/health` probe as authoritative for room-join
   readiness.
2. Keep the web release if usersync and the rest of the runtime are healthy.
3. Track any desire for a cleaner combined health signal as backlog work, not
   as an in-incident docs or workflow change.
