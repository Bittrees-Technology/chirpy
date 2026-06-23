import type { Gate, Identity, Policy } from "@app/core";

export interface ChatMessage {
  id: string;
  conversationId: string;
  sender: string;          // address
  body: string;
  sentAt: number;          // epoch ms
  reactions?: Record<string, string[]>; // emoji -> addresses
  replyTo?: string;        // message id
}

export type ConversationKind = "dm" | "room";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  title: string;
  /** Member addresses (DMs: 2; rooms: N). */
  peers: string[];
  description?: string;
  /** Room gate (rooms only). */
  gate?: Gate;
  /** Effective action policy (rooms only) — org default merged with room override. */
  policy?: Policy;
  lastMessage?: ChatMessage;
  unread: number;
  /** A DM that the peer has not yet accepted (request state). */
  pending?: boolean;
}

export interface StartRoomInput {
  title: string;
  description?: string;
  gate: Gate;
  policy?: Partial<Policy>;
}

export type TransportStatus = "idle" | "enabling" | "ready" | "error";

/** The interface the UI talks to. Backed by MockTransport today, XmtpTransport later. */
export interface Transport {
  readonly id: "mock" | "xmtp";
  readonly status?: TransportStatus;
  /** Identity this transport is acting as. */
  me(): Identity;
  init(): Promise<void>;
  /** Create the encrypted inbox. `revokeStale` first revokes the inbox's existing
   *  installations (used to recover from XMTP's 10-installation-per-inbox limit). */
  enable?(opts?: { revokeStale?: boolean }): Promise<void>;
  listConversations(): Promise<Conversation[]>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage>;
  react(conversationId: string, messageId: string, emoji: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  startDm(address: string, handle?: string): Promise<Conversation>;
  createRoom(input: StartRoomInput): Promise<Conversation>;
  /** Ask the configured gatekeeper bot to add this wallet/inbox to a gated room. */
  requestRoomJoin?(conversationId: string): Promise<void>;
  /** Update a room's effective policy (admin action — e.g. freeze posting). */
  setRoomPolicy(conversationId: string, policy: Policy): Promise<void>;
  /** Subscribe to any change (new message, new conversation, read state). */
  subscribe(cb: () => void): () => void;
}
