# Production go-live spec

Requirements for the live release. The XMTP transport, wallet/ENS, and the serverless gate
are **implemented**; what remains is provisioning the server env below and building with
`VITE_TRANSPORT=xmtp`. (The offline `MockTransport` stays the no-wallet default.)

## 1. Alchemy key, uploaded through Vercel

- The serverless **token-gate** (`api/room-join.js`) and any server-side ENS/Safe reads use an
  **unrestricted** Alchemy RPC, set as `MAINNET_RPC_URL` in the Vercel project
  (Dashboard → Settings → Environment Variables, or `vercel env add MAINNET_RPC_URL`).
- The **browser** uses a **separate, domain-allowlisted** key as `VITE_MAINNET_RPC_URL`
  (and/or `VITE_ALCHEMY_API_KEY`) for ENS name/avatar lookups.
- ⚠️ Never reuse the browser (domain-restricted) key on the server: a serverless function
  has no browser origin and Alchemy will 403 it — this is a known Bittrees footgun, see
  the comment at the top of Bittrees `api/gate.js`.
- All keys live only in Vercel env / local `.env.local`; never committed. See `.env.example`.

## 2. WalletConnect login + ENS sync (like the Bittrees Inc app)

- **Login (implemented):** injected EIP-1193 wallets (MetaMask) plus **WalletConnect v2** via
  `@walletconnect/ethereum-provider` (`VITE_WALLETCONNECT_PROJECT_ID`) — see
  `apps/web/src/walletProviders.ts`. Hand-rolled EIP-1193, **not** RainbowKit/wagmi. Injected
  wallets work without the project id.
- **ENS (implemented):** on connect the address resolves to its primary ENS name + avatar, with
  reverse lookup cached app-wide (sidebar, DM titles, thread header, message-bubble avatars) —
  `apps/web/src/ens.ts` + `useEns.ts`. Also feeds the `ens` gate rule.
- **Where it plugs in:** `IdentityProvider` (`apps/web/src/state.tsx`) holds the connected
  account; components read `identity.handle` and the ENS hook — no other UI changes.
- **Mobile (iOS):** WalletConnect deep-links back to Chirpy; register the app URL scheme so
  the wallet round-trip returns to the app (see `docs/NATIVE.md`).

## 3. Chats persist across all orgs and personally

**Model:** identity is the wallet, so a user's **DMs follow the wallet everywhere**; **rooms
are scoped to the org** that defines them (they are token-gated communities).

| Surface | Scope | Why |
|---|---|---|
| **Chats (1:1 DMs) + Saved Messages** | **wallet-global** — same in every org and personal | one XMTP inbox per wallet; chats shouldn't silo by org |
| **Rooms (gated)** | per-org | XMTP-MLS groups gated by that org's rules |

- **Already implemented in the mock** (`packages/transport/src/mock.ts`): DMs persist under
  `chat:mock:dms:<wallet>` (org-independent); rooms under `chat:mock:rooms:<wallet>:<namespace>`.
  Switch orgs in the app and your Chats list stays; rooms change with the org.
- **In production this is XMTP-native:** the XMTP client is keyed to the wallet, so DM
  conversations and history are inherently the same across every org and personal mode — no
  cross-org sync logic needed. Encrypted multi-device sync (à la Bittrees `userSync.ts`)
  carries the same history to a second device.
- **Org = a lens, not a silo:** an org changes branding, chain, gating vocabulary, and which
  rooms are offered — it does not partition your personal conversations.

## Rollout checklist

1. ✅ `XmtpTransport` (XMTP DMs + MLS rooms) behind the `Transport` interface — built; select it
   per-build with `VITE_TRANSPORT=xmtp`. **No UI changes vs mock.**
2. ✅ Injected + WalletConnect v2 login and ENS resolver wired into `IdentityProvider`.
3. ✅ Gate deployed as `api/room-join.js` (+ `api/usersync.js`) Vercel functions; the evaluator
   is `@app/core`'s `evalGate` with a viem `ChainReader` using `MAINNET_RPC_URL`.
4. ☐ Set Vercel env: **`XMTP_GATEKEEPER_PRIVATE_KEY`** (signs the gatekeeper bot's room adds —
   the linchpin), `MAINNET_RPC_URL`, `VITE_MAINNET_RPC_URL`/`VITE_ALCHEMY_API_KEY`,
   `VITE_WALLETCONNECT_PROJECT_ID`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`, and
   `VITE_TRANSPORT=xmtp`.
5. ☐ Verify ENS resolves on connect; a gated room admits/denies correctly; DMs persist across
   org switches and on a second device.
