# Self-host the gate

An org can run its own **gate service** (the serverless token/action gate) instead of
deploying it to Vercel — on-brand for a decentralized product. This directory is the
ops bundle for that: an interactive installer (prompt → write config → run as a
service).

> **Status:** scaffold. The gate *logic* already exists, framework-agnostic, in
> `@app/core` (`evalGate` + the `ChainReader` interface). The thin HTTP wrapper that
> turns it into a deployable service lands in the **XMTP/gate phase** (see
> `docs/PRODUCTION.md`). This bundle is ready to wrap it when it does.

## What's here

- `install.sh` — interactive installer: prompts for domain, RPC, KV, port → writes
  `gate.env` → brings the stack up with Docker Compose.
- `docker-compose.yml` — the `gate` service (+ a Redis for the KV registry).
- `gate.env.example` — environment template.

## Usage (once the gate service ships)

```bash
cd selfhost
./install.sh            # prompts, writes gate.env, runs `docker compose up -d`
```

Then point an org's `OrgConfig.gateUrl` at `https://<your-domain>/api/gate`.

## Why self-host

- **No Vercel dependency** — run the gate on your own box, behind your own nginx/SSL.
- **Data locality** — the roles/rooms KV registry stays on infrastructure you control.
- **Censorship-resistance** — optionally front it with a reverse-proxy relay for
  path/method policy + proxying.
