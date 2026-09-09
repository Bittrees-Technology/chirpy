# Rollout, rollback and recovery

Use [PRODUCTION.md](PRODUCTION.md) for configuration and [PRODUCTION-READINESS.md](PRODUCTION-READINESS.md) for evidence. Commands run from the repository root; replace example hosts with reviewed deployment values.

## Preflight

1. Record the current web deployment, gate image digest, configuration version, registry hash, XMTP network and backup snapshot. Exclude secrets.
2. Require green CI and review the latest XMTP nightly. Local checks: `pnpm typecheck`, `pnpm typecheck:api`, `pnpm test`, `pnpm build`, `pnpm rollout:proof`. CI requires real Redis tests; local runs without the test container skip those cases.
3. Rollout proof tests local configuration/handlers. Its synthetic gate must return 503 because it lacks live authority/dependencies. It is not production acceptance.
4. Before changing the gate, stop its single writer and copy the complete data directory, including salt and sidecar files. Verify hashes and preserve original keys separately. Plaintext databases require reviewed offline migration; old sync clients must refresh to v2.
5. Record a compatible rollback target. Never revert sync to reusable signatures or non-atomic writes.

## Gate promotion

Follow [selfhost/DEPLOY.md](../selfhost/DEPLOY.md) for secrets, reviewed rooms, TLS and durable storage. For the supplied Compose deployment:

```sh
docker compose -f selfhost/docker-compose.yml --env-file selfhost/gate.env up -d --build
docker compose -f selfhost/docker-compose.yml --env-file selfhost/gate.env ps
curl -fsS https://gate.example.org/health
```

Keep one process per database and retain the runtime restrictions, volume and registry mount. The Fly configuration is a template, not evidence of a deployed service.

Require HTTP 200, `ok: true`, `network: production` and `dependencies.ready: true`. Startup stays 503 until RPC chain/freshness, XMTP synchronization and every room's super-admin authority pass. Results expire after two minutes; a changed or empty registry cannot reuse healthy evidence.

## Web promotion and acceptance

Merge validated changes to main through the linked GitHub/Vercel deployment, or use the reviewed operator deployment procedure. Record the promoted commit and deployment.

```sh
curl -fsS https://chirpy.bittrees.org/api/health
curl -fsS 'https://chirpy.bittrees.org/api/usersync?address=0x0000000000000000000000000000000000000001'
```

Require XMTP and `readiness.releaseReady: true`. The sync read must return v2 authorization, the canonical service and valid revision/epoch; it writes no record. Web health is configuration evidence, so check the external gate separately.

Exercise qualifying and denied wallets against the same registered room, challenge replay and inbox substitution rejection, restart continuity, accepted DM delivery, blocked/request behavior, organization switching and a second device. Use operator-controlled test identities and record cleanup. Verify native origins and wallet return on devices before approving native use.

## Rollback

Use the recorded compatible Vercel deployment through the provider's rollback flow. Deploy the previous immutable gate image with the existing keys, network, registry and volume. Never run two gate writers concurrently. Recheck readiness and admission.

Image rollback does not undo membership changes, sync revisions/revocations or database changes. For data recovery, stop the writer and restore into a fresh volume using the documented procedure. Preserve the failed volume; never delete the store or rotate keys to make startup pass.

## Incident response

| Signal | Action |
|---|---|
| Web 5xx after promotion | Inspect logs; roll back the implicated release and verify web/sync independently |
| Sync 503 | Check storage and canonical service configuration; restore existing credentials |
| Sync 401/409 | Refresh/re-authorize an expired grant or pull/merge/retry a stale revision; retain signature/revision checks |
| Gate 503 or stale dependencies | Inspect dependency logs, RPC freshness, storage permissions, registry and room authority |
| Admission 503 with Retry-After | Investigate queue latency; retry with a fresh challenge |
| Missing bot authority | Restore the reviewed role through an authorized room administrator, then wait for a fresh probe |
| Gate denial | Check actual wallet bindings and on-chain policy using qualifying and denied identities |
| Same-origin room-join 503 | Correct the organization's external gate URL; Vercel intentionally cannot admit members |
| Unexpected removal | Turn membership maintenance off, preserve evidence, investigate, and use authorized administration for reinstatement |

Configure alerts for repeated gate failures, failed nightly checks, sync outages and admission latency. Assign incident ownership, escalation contacts and recovery targets before launch. These operator decisions and alert destinations remain pending.
