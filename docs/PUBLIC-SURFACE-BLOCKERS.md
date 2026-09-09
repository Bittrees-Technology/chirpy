# Public surface blockers

This file records public-product decisions that must not be hidden behind SPA fallbacks
or invented copy.

## Trust-path artifacts

The repository does not currently contain approved public artifacts for:

- `/support`
- `/security`
- `/privacy`
- `/terms`

Until the owning reviewer supplies approved content for those paths, the Vercel SPA rewrite
excludes them so they do not render the chat application as a misleading fallback page.

Do not add placeholder legal, privacy, security, or support claims. Add real static artifacts
or route handlers only after the content is approved.

## Bittrees positioning

Bittrees remains valid provenance and a preset source for Chirpy, but the public frame should
lead with wallet-native community chat for any organization. Bittrees-specific material belongs
in presets, examples, and operational handoff docs rather than the top-level product claim.
