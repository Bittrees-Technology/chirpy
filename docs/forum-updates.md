# Governance forum updates

The Forum entry in Bittrees Chat opens a wallet-scoped, opt-in reader for new Governance discussions. Gov's follow link opens `/?forum=governance`. The user must explicitly follow; following sends no messages and grants no room membership. This release covers new topics, not replies or revisions.

Chat polls the public `https://gov.bittrees.org/api/forum-feed` once per minute while the page is visible, only for a connected wallet with an active local follow preference. The feed filters revoked, expired and moderated content on the server. All outbound links are validated against the exact Gov thread URL. Feed outages retain cached items with a visible error.

Follow/unfollow and read state are stored under a separate per-wallet local key. They survive reload and update across tabs on this device, but are not yet part of encrypted cross-device sync, backup or restore. Switching wallets cancels the old request and resets the view. Unfollowing clears displayed updates. Only the latest 100 feed entries are available; unread counts describe that available window. These are in-app updates, not XMTP/Push DMs or background notifications.

Email subscriptions are managed by Governance and use a separate confirmed-email consent flow. Chat does not receive email addresses, subscription tokens or sending credentials.

Validation includes parser/storage/account-switch unit tests and an end-to-end browser test using the existing synthetic wallet fixture. No real message was sent. The required audit also prompted compatible Axios updates to 0.34.0 (Push) and 1.20.0 (other dependencies); SDK versions and the reviewed XMTP artifacts remain unchanged.
