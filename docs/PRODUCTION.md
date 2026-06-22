# Production go-live spec

Requirements captured for the live release. Today the app runs on the offline
`MockTransport`; this doc is the contract for the XMTP/Push + wallet phase.

## 1. Alchemy key, uploaded through Vercel

- The serverless **token-gate** (`/api/gate`) and any server-side ENS/Safe reads use an
  **unrestricted** Alchemy RPC, set as `MAINNET_RPC_URL` in the Vercel project
  (Dashboard → Settings → Environment Variables, or `vercel env add MAINNET_RPC_URL`).
- The **browser** uses a **separate, domain-allowlisted** key as `VITE_MAINNET_RPC_URL`
  (and/or `VITE_ALCHEMY_API_KEY`) for ENS name/avatar lookups.
- ⚠️ Never reuse the browser (domain-restricted) key on the server: a serverless function
  has no browser origin and Alchemy will 403 it — this is a known Bittrees footgun, see
  the comment at the top of Bittrees `api/gate.js`.
- All keys live only in Vercel env / local `.env.local`; never committed. See `.env.example`.

## 2. WalletConnect login + ENS sync (like the Bittrees Inc app)

- **Login:** RainbowKit + wagmi v2 with WalletConnect v2 (`VITE_WALLETCONNECT_PROJECT_ID`),
  matching `Bittrees-Inc/src/lib/wagmi.ts`. Injected wallets (MetaMask) work without the id.
- **ENS sync:** on connect, resolve the address → primary ENS name + avatar via the browser
  Alchemy RPC, mirroring `Bittrees-Inc/src/lib/ens.ts`. This populates `Identity.handle`
  app-wide (sidebar, DM titles, member lists) and is used by the `ens` gate rule.
- **Where it plugs in:** the `IdentityProvider` (`apps/web/src/state.tsx`) swaps its local
  stub for the wagmi account + an `ens.ts` resolver. No other UI changes — components already
  read `identity.handle`.
- **Mobile (iOS):** WalletConnect deep-links back to Parley; register the app URL scheme so
  the wallet round-trip returns to the app (see `docs/NATIVE.md`).

## 3. Chats persist across all orgs and personally

**Model:** identity is the wallet, so a user's **DMs follow the wallet everywhere**; **rooms
are scoped to the org** that defines them (they are token-gated communities).

| Surface | Scope | Why |
|---|---|---|
| **Chats (1:1 DMs) + Saved Messages** | **wallet-global** — same in every org and personal | one XMTP inbox per wallet; chats shouldn't silo by org |
| **Rooms (gated)** | per-org | Push groups gated by that org's rules |

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

1. Wire `XmtpTransport` (XMTP DMs + Push rooms) behind the existing `Transport` interface;
   flip `DEFAULT_TRANSPORT` / per-build flag from `mock` to `xmtp`. **No UI changes.**
2. Add wagmi/RainbowKit + ENS resolver to `IdentityProvider`.
3. Deploy `/api/gate` (+ community/rooms/usersync) as Vercel functions; the gate evaluator is
   already in `@app/core` — provide a viem-backed `ChainReader` using `MAINNET_RPC_URL`.
4. Set Vercel env: `MAINNET_RPC_URL`, `VITE_MAINNET_RPC_URL`/`VITE_ALCHEMY_API_KEY`,
   `VITE_WALLETCONNECT_PROJECT_ID`, `KV_REST_API_URL`, `KV_REST_API_TOKEN`.
5. Verify ENS resolves on connect; verify a gated room admits/denies correctly; verify DMs
   appear unchanged after switching orgs and on a second device.
