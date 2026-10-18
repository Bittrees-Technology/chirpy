# Chat shared sign-in rollout

The server handoff is a disabled foundation. It does not yet replace Chat's wallet connection UI or enable automatic shared sign-in.

Use the canonical Roles shared SSO implementation. Chat consumes wallet identities only; email identities cannot establish a wallet session. The original authentication timestamp is retained and bounded to seven days. A resumed identity starts with no mailbox connection. Mail must separately authorize access, including any durable consent. Existing Mail sessions are preserved rather than replaced by a late callback. XMTP installation, signing, room membership and staff authority remain separate.

## Configuration and acceptance still required

- Register client `chat` with exact origin `https://chat.bittrees.org` and callback `https://chat.bittrees.org/api/sso/callback` in Roles.
- Provision a separate sending-app SSO client secret as `BITTREES_SSO_CLIENT_SECRET`; never reuse `BITTREES_ADMIN_SSO_CLIENT_SECRET`.
- Integrate the canonical shared login/session presentation with explicit local fallback, without clearing a valid Mail connection or causing redirect loops.
- Verify wallet mismatch, issuer outage, expired proof, logout suppression and returning-browser behavior before setting `BITTREES_SSO_ENABLED=1`.
- Connected Mail configuration must also be enabled. Preview deployments remain disabled.
- Verify the live handoff and existing Mail consent reuse before calling shared sign-in complete.

Administration remains client `chat-admin`, callback `/api/project-admin/sso/callback`, with separate cookies and secret. Ordinary Chat handoffs use the `bt-sso-chat` cookie prefix. The copied canonical SSO client preserves the default cookie behavior used by administration.

Rollback: leave or set `BITTREES_SSO_ENABLED=0`. This disables the new handoff without revoking existing Mail grants. It does not change Mail's separately deployed durable-consent behavior.
