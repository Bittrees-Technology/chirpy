import type { Identity, OrgConfig } from "@app/core";
import type { ChatMessage, Conversation, StartRoomInput, Transport } from "./types";

/**
 * Scaffold for the real transport. The production app uses XMTP (V3/MLS) for DMs
 * and Push Protocol for token-gated rooms — the exact stack already shipping in the
 * Bittrees apps (`src/lib/xmtp.ts`, `src/lib/push.ts`). Each method below maps 1:1
 * onto that existing code; wiring it is the next phase (needs a connected wallet +
 * WalletConnect project id + the @xmtp/browser-sdk and @pushprotocol/restapi deps).
 *
 * It implements the same Transport interface as MockTransport, so activating it is
 * a single line in the app's transport factory — no UI changes.
 */
export class XmtpTransport implements Transport {
  readonly id = "xmtp" as const;
  constructor(private org: OrgConfig, private identity: Identity) {}

  me(): Identity { return this.identity; }

  private notWired(): never {
    throw new Error(
      "XmtpTransport is not wired yet. Port src/lib/xmtp.ts (DMs) and src/lib/push.ts " +
      "(gated rooms) from the Bittrees apps and provide a connected wallet signer.",
    );
  }

  async init(): Promise<void> { this.notWired(); }
  async listConversations(): Promise<Conversation[]> { this.notWired(); }
  async listMessages(_id: string): Promise<ChatMessage[]> { this.notWired(); }
  async send(_id: string, _body: string): Promise<ChatMessage> { this.notWired(); }
  async react(): Promise<void> { this.notWired(); }
  async markRead(): Promise<void> { this.notWired(); }
  async startDm(): Promise<Conversation> { this.notWired(); }
  async createRoom(_input: StartRoomInput): Promise<Conversation> { this.notWired(); }
  async setRoomPolicy(): Promise<void> { this.notWired(); }
  subscribe(_cb: () => void): () => void { return () => {}; }
}
