import type { TransportMode } from "@app/transport";

// Product-level config. The app ships org-agnostic: no organization is baked in.
// Visible product name. Static/native assets have matching display labels.
// Legacy storage and signing identifiers deliberately keep their original names.
export const APP_NAME = "Chat";
export const APP_TAGLINE = "Wallet-native community chat";
// Keep in sync with apps/web/src-tauri/tauri.conf.json `version`.
export const APP_VERSION = "0.1.0";

// "mock" = fully offline local transport (default, no wallet needed).
// "xmtp" = real XMTP DMs and XMTP MLS rooms.
export const DEFAULT_TRANSPORT: TransportMode =
  import.meta.env.VITE_TRANSPORT === "xmtp" ? "xmtp" : "mock";
