# Bittrees production organization configuration

This guide is the production handoff for running **Bittrees, Inc.** and
**Bittrees Research** from the shared Chirpy codebase. It covers the data that
belongs in each `OrgConfig`, the runtime values that must be provisioned
separately, and the required gate topology.

`OrgConfig` is imported client-side data, not a secret store. It may contain
public contract addresses, room names, admin *addresses*, and a gate endpoint,
but never private keys, RPC credentials, KV tokens, or service credentials.

The checked-in presets in [`examples/`](../examples/) are reference templates.
They are not production-ready until the Research placeholder address is
replaced and a production gate is deployed.

## Production decision: self-host the gate

Use an always-on, self-hosted Chirpy gate (the supplied `selfhost/` container
or an equivalent VM/container) for every production gated room. Set each
org's `gateUrl` to its HTTPS `POST /api/room-join` endpoint.

Leaving `gateUrl` blank makes the browser call the web deployment's
same-origin `/api/room-join`. That is suitable only for non-production paths:
the XMTP Node SDK used by the gatekeeper has native bindings and cannot run in
Vercel serverless. A blank production `gateUrl` will therefore not provide a
working self-service gate.

Two deployment shapes are valid:

- **Shared gate service (recommended for the current shared web build):** run
  one hardened gatekeeper service/EOA and use its same HTTPS endpoint in both
  org configs. This matches the one build-time `VITE_GATEKEEPER_ADDRESS` value
  used when Chirpy creates a gated room.
- **Dedicated service per org:** use separate gate URLs and separate gatekeeper
  EOAs only when the web deployment that creates rooms is configured with the
  matching `VITE_GATEKEEPER_ADDRESS`, or when the correct bot is explicitly
  added as a room super-admin during room setup. See
  [Known configuration gap](#known-configuration-gap) before selecting this
  topology.

In either case, configure `GATE_ALLOW_ORIGIN` with the exact Chirpy web origin
(not `*`) and place the gate behind TLS. See
[`selfhost/DEPLOY.md`](../selfhost/DEPLOY.md) for the deployment procedure.

## `OrgConfig` contract

Production configs should specify every non-optional field in the TypeScript
`OrgConfig` model, even where the import parser accepts old partial configs for
backward compatibility. `gateUrl` is the only optional model field, but it is
operationally required for a production gated organization under the decision
above.

| Field | Production requirement |
| --- | --- |
| `id` | A stable, unique identifier. Keep `org_bittrees_inc` and `org_bittrees_research`; do not recycle either for another org. |
| `version` | Literal `1`. |
| `branding` | Supply `name` and a unique `slug`; set the approved accent/home URL and optional logo/theme values. |
| `chain` | Supply `chainId` (both profiles currently use Ethereum mainnet, `1`). `rpcUrl` is optional and must be a public/browser-safe endpoint if used. |
| `namespace` | A stable unique namespace. Keep `bittrees:inc` and `bittrees:research`; changing it changes the org's scoped room/storage identity. |
| `entryGate` | The intended org-membership rules. Use `[]` only for an intentionally open org; see the known enforcement gap before treating this field as an access boundary. |
| `gating` | Set all three rule flags, `roleCascade`, and `powerTier` (`null` when not used). The room gate evaluator relies on the cascade and power-tier data. |
| `policy` | Set `mode` (`active` or `read-only`) and `attachments` (`allow` or `block`); add `maxUploadBytes` when there is a limit. |
| `defaultRooms` | An explicit list of rooms, each with a stable `id`, title, and `{ combine, rules }` gate. An empty rules array is an open room. |
| `roles` | The declared role labels and optional colors used by this org's role gates. |
| `admins` | Lowercased bootstrap admin wallet addresses. `[]` is only appropriate when no bootstrap admins are intended. Addresses are public identifiers, not secrets. |
| `gateUrl` | The absolute HTTPS endpoint of the selected self-hosted gate: `https://<gate-host>/api/room-join`. |

The import validator currently checks the minimal compatibility set (`version`,
`branding.name`, `namespace`, `chain.chainId`, `entryGate`, and `gating`). That
is not a reason to omit the other production fields: the full shape above is
the supported configuration contract.

## Bittrees, Inc. profile

Start with [`examples/bittrees-inc.org.json`](../examples/bittrees-inc.org.json)
or the `bittreesIncPreset` in
[`apps/web/src/presets.ts`](../apps/web/src/presets.ts), then make these
production settings explicit:

| Setting | Required Inc value / action |
| --- | --- |
| Identity | `id: "org_bittrees_inc"`, `branding.slug: "inc"`, `namespace: "bittrees:inc"`, `chain.chainId: 1`. |
| Entry | `entryGate: []`: the Inc org entry is deliberately open. The individual governance rooms remain gated. |
| Gating | Enable token/Safe/ENS rule types; use `roleCascade: {}` and the BGOV Snapshot power tier: label `BGOV`, resolver `snapshot`, tiers `[1, 69, 210, 420]`, space `gov.bittrees.eth`. |
| Rooms | Preserve the shareholders, associates, partners, and board room rules at power tiers 1, 69, 210, and 420 respectively, unless governance approves a policy change. |
| Roles/admins | The reference profile declares `Operations` and has no bootstrap admin. Populate approved, lowercased admin addresses before an admin-managed rollout. |
| Gate | Add `gateUrl: "https://<selected-inc-or-shared-gate>/api/room-join"`. The host must run the gatekeeper EOA described below. |
| Policy | Set the intended explicit org policy, e.g. `{ "mode": "active", "attachments": "allow" }`, rather than relying on a legacy default. |

## Bittrees Research profile

Start with
[`examples/bittrees-research.org.json`](../examples/bittrees-research.org.json)
or `bittreesResearchPreset`, then make these production settings explicit:

| Setting | Required Research value / action |
| --- | --- |
| Identity | `id: "org_bittrees_research"`, `branding.slug: "research"`, `namespace: "bittrees:research"`, `chain.chainId: 1`. |
| Entry | Configure the real Research membership ERC-1155 contract in `entryGate`, with the intended token ID if membership is token-ID-specific. Keep `min: "1"` only if one token is the correct threshold. See the entry-gate enforcement gap below before treating this field as a live membership boundary. |
| Gating | Enable token/Safe/ENS rule types; keep the role cascade `{ "partner": 3, "junior partner": 2, "associate": 1 }`; set `powerTier: null`. |
| Rooms | Preserve the lobby plus the associate and researcher role-gated rooms, unless Research approves a rule change. The lobby is only members-only once its membership rule is enforced as described in the known gap. |
| Roles/admins | Define Partner, Junior Partner, Associate, and Researcher roles; add approved, lowercased bootstrap-admin addresses before rollout. |
| Gate | Add `gateUrl: "https://<selected-research-or-shared-gate>/api/room-join"`. The endpoint must use the matching gatekeeper configuration. |
| Policy | Set the intended explicit org policy, e.g. `{ "mode": "active", "attachments": "allow" }`. |

### Mandatory placeholder-address warning

The Research example's membership token,
`0x000000000000000000000000000000000000dEaD`, is an illustrative burn address.
It is **not** a production membership contract. Do not deploy or import that
config for real gating: replace it with the verified ERC-1155 contract address
(and `tokenId` where required), then test a qualifying and a non-qualifying
wallet against the deployed gate. The placeholder is neither a real membership
credential nor a protection for Research rooms.

Treat every new token, Safe, and RPC address as production change-control
data: verify chain, ownership, and intended access policy before merging it.

## Runtime configuration and secrets

These values are deployed to the web host and selected self-host gate; they do
not go into either `OrgConfig` JSON file. Store the secret values in the
environment/secrets manager for the applicable production service and never
commit them.

| Scope | Variable | Secret? | Required use |
| --- | --- | --- | --- |
| Web build shared by both orgs | `VITE_TRANSPORT=xmtp` | No | Selects the real XMTP transport for the production build. |
| Web build shared by both orgs | `VITE_GATEKEEPER_ADDRESS` | No (public EOA address) | Must equal the EOA derived from the gate's `XMTP_GATEKEEPER_PRIVATE_KEY`; newly created gated rooms add this bot as super-admin. |
| Web build shared by both orgs | `VITE_MAINNET_RPC_URL` | No, but use a browser/domain-allowlisted key | Browser ENS and public chain reads. Never reuse it for the server gate. |
| Web build shared by both orgs | `VITE_WALLETCONNECT_PROJECT_ID` | Public build value | Needed for WalletConnect login; injected wallets work without it. |
| Each selected gate service (shared once, or one per org) | `XMTP_GATEKEEPER_PRIVATE_KEY` | **Yes** | Gatekeeper bot EOA. Generate/store it only on the gate host; add its address as a super-admin to every gated room it serves. |
| Each selected gate service (shared once, or one per org) | `MAINNET_RPC_URL` | **Yes** | Unrestricted server RPC for token, Safe, and ENS reads. A browser-allowlisted key fails from a server. |
| Each selected gate service | `GATE_ALLOW_ORIGIN` | No | Exact Chirpy web origin permitted by CORS. |
| Each selected gate service | `CHIRPY_RATE_LIMIT_MAX`, `CHIRPY_RATE_LIMIT_WINDOW_MS` | No | Optional gate request-limit tuning; defaults are 60 requests per 60 seconds per process/client. |
| Shared web sync service, if cross-device sync is enabled | `KV_REST_API_URL`, `KV_REST_API_TOKEN` (or Upstash equivalents) | **Yes** | Encrypted cross-device sync storage; separate from the gate. |

For a dedicated-gate topology, maintain distinct secret records, for example
`chirpy/inc-gate` and `chirpy/research-gate`. Never share a private key merely
by copying it into both records. For the recommended shared-gate topology,
maintain one record such as `chirpy/shared-gate` and point both configs at that
gate; this is the intentional, auditable exception to per-org secret isolation.

## Room and gatekeeper rollout checklist

1. Create final Inc and Research config artifacts with the stable IDs and
   namespaces above, explicit policies, real admin addresses, and real
   `gateUrl` values.
2. Replace the Research burn address with the verified membership contract and
   perform both allow and deny tests.
3. Generate the gatekeeper EOA, retain only its address for
   `VITE_GATEKEEPER_ADDRESS`, and save its private key only in the selected
   gate service's secrets manager.
4. Deploy the self-host gate, set its exact CORS origin, and verify
   `GET /health` returns `{ "ok": true, "gatekeeper": true }`.
5. Add the gatekeeper as a super-admin to every existing gated room. New gated
   rooms only receive the EOA set by `VITE_GATEKEEPER_ADDRESS` at build time.
6. Redeploy the web build, create or seed a gated room, and verify a qualifying
   wallet can join while a non-qualifying wallet is denied.

## Known configuration gap

`OrgConfig` currently contains `gateUrl` but not a per-org gatekeeper address;
the web build has one global `VITE_GATEKEEPER_ADDRESS`. Consequently, a single
shared web build cannot automatically assign different gatekeeper EOAs when it
creates gated rooms for Inc and Research. The safe current production choice is
therefore one shared self-hosted gatekeeper/EOA, or explicit room setup with
the correct bot for a dedicated-gate topology.

If Bittrees requires automatically provisioned, distinct Inc and Research
gatekeepers from one web build, add **per-org `gatekeeperAddress` support** as a
backlog candidate. Do not work around this by placing a private key in an
`OrgConfig` or changing the current runtime behavior during configuration
rollout.

`OrgConfig.entryGate` is also not combined into the current
`requestRoomJoin` server request: that request evaluates the target room's
encoded gate. Until org-entry enforcement is implemented, do not represent the
Research `entryGate` alone as a live access boundary. If Research needs an
enforced membership check before that backlog item lands, include the verified
membership token rule in every protected room's gate and validate it against
the deployed gate.

## Verification

Before merging configuration or deployment documentation changes, run:

```bash
pnpm typecheck
```

For the runtime deployment verification, follow the gate health and qualifying
/ non-qualifying wallet checks in the checklist above. Refer to
[`docs/PRODUCTION.md`](PRODUCTION.md) for the broader production checklist and
[`selfhost/DEPLOY.md`](../selfhost/DEPLOY.md) for gate deployment details.
