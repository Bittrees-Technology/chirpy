import type { DisplayWalletReader } from './displayWalletChoices.js';
import type { Identity, OrgConfig } from "@app/core";
import { MockTransport } from "./mock.js";
import { XmtpTransport } from "./xmtp.js";
import type { Transport } from "./types.js";

export * from "./types.js";
export * from "./pushRegistry.js";
export { PushRooms } from "./pushRooms.js";
export type { PushRoomsSnapshot, PushRoomDetails, PushMember, PushMemberPage } from "./pushRooms.js";
export { PushRoomSession, PushSessionChangedError } from "./pushSession.js";
export type { PushRoomClient, PushSessionSnapshot, PushWalletProvider } from "./pushSession.js";
export { MockTransport } from "./mock.js";
export { XmtpTransport } from "./xmtp.js";

export type TransportMode = "mock" | "xmtp";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

/** Build the transport for an org. Defaults to the offline mock transport. */
export function createTransport(
  mode: TransportMode,
  org: OrgConfig,
  identity: Identity,
  provider?: Eip1193Provider | null,
  displayReader?: DisplayWalletReader,
): Transport {
  return mode === "xmtp" ? new XmtpTransport(org, identity, provider ?? null, displayReader) : new MockTransport(org, identity);
}

export { PUSH_FILE_BYTES, PUSH_MAX_FILES, preparePushFile } from "./pushMedia.js";
export type { PushAttachment } from "./pushMedia.js";
export { PUSH_REACTIONS } from "./pushReactions.js";
