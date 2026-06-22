import type { Identity, OrgConfig } from "@app/core";
import { MockTransport } from "./mock";
import { XmtpTransport } from "./xmtp";
import type { Transport } from "./types";

export * from "./types";
export { MockTransport } from "./mock";
export { XmtpTransport } from "./xmtp";

export type TransportMode = "mock" | "xmtp";

/** Build the transport for an org. Defaults to the offline mock transport. */
export function createTransport(mode: TransportMode, org: OrgConfig, identity: Identity): Transport {
  return mode === "xmtp" ? new XmtpTransport(org, identity) : new MockTransport(org, identity);
}
