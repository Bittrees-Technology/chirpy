# Bittrees login interface

`LoginPanel.jsx`, its declaration and `login.css` are the source of truth for combined email + Ethereum sign-in. Each app keeps its own page, modal, backend, account linking and authorization. The interface uses the same email-first order, labels, controls, typography, spacing and focus states.

Consumers: Roles, Insights, Workflows, CRM, AutoNote, News, Mercado and Wallet. Gov, Research and Capital are deliberately excluded. Wallet creation/unlocking, account recovery, MFA, and wallet selection are separate operations and retain their existing behavior.

From this repository, `node scripts/sync-login.mjs` updates the independently deployable copies in sibling app checkouts. `node scripts/sync-login.mjs --check` detects drift. The sibling layout follows the Bittrees project workspace (`wallet/app` is nested). Adding a new combined login requires a new target plus a local adapter, rather than copying a custom design.

Presentation tokens: canvas `#f3f7f5`, surface `#ffffff`, ink `#172a26`, muted `#53655d`, border `#d9e3dd`, action `#157a50`, dark action `#075137`. Arial/Helvetica provides consistent rendering without third-party font requests. Each product’s existing favicon appears beside its title. EmailSignIn and EthereumSignIn own the common controls; adapters supply only local handlers and state. First-screen cards are 440px wide with 32px padding and 48px controls; below 480px they use a 12px page inset and 24px card padding. Product-specific footer text sits outside the card. Wallet account sign-in precedes key unlocking, passkeys and any required account MFA. No new brand theme is applied to Gov, Research or Capital.

AI’s Workflows & permissions page, Bounties, and Mail reuse this same panel and Ethereum control. They currently require wallet identity and omit the email form; do not render an email option without a supported backend and linked-identity policy. Product-specific help, mailbox requests, and workflow/escrow explanations belong outside the common card. All three also participate in shared wallet sign-in; their adapters retain local authorization and additional security steps. See ../../docs/shared-wallet-sign-in.md.

TLD also uses the wallet-only panel and shared wallet session. TLD access still requires current Safe membership or assigned administration. Root controller sign-in uses a separate native Safe signature flow below the common card. Shared proof never refreshes the original authentication time for MCP credential issuance.
