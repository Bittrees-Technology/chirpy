import type { TransportMode } from "@app/transport";

// Product-level config. The app ships org-agnostic: no organization is baked in.
// `APP_NAME` is the only brand string; change it in one place to rebrand.
export const APP_NAME = "Parley";
export const APP_TAGLINE = "Wallet-native chat for any community";

// "mock" = fully offline local transport (default, no wallet needed).
// "xmtp" = real XMTP DMs + Push gated rooms (scaffolded; wiring is the next phase).
export const DEFAULT_TRANSPORT: TransportMode = "mock";
