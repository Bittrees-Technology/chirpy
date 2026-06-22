import type { Identity, OrgConfig } from "@app/core";
import { MockTransport } from "./mock";
import { XmtpTransport } from "./xmtp";
import type { Transport } from "./types";

export * from "./types";
export { MockTransport } from "./mock";
export { XmtpTransport } from "./xmtp";

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
): Transport {
  return mode === "xmtp" ? new XmtpTransport(org, identity, provider ?? null) : new MockTransport(org, identity);
}
