import type { Gate, Identity, Policy } from "@app/core";

export interface ChatMessage {
  id: string;
  conversationId: string;
  sender: string;          // address
  body: string;
  sentAt: number;          // epoch ms
  /** Bounded inline Push content; download only, never interpreted as HTML. */
  pushAttachment?: import('./pushMedia.js').PushAttachment;
  pushMediaUrl?: string;
  /** Original order of bounded, non-nested Push composite parts. */
  pushParts?: PushMessagePart[];
  reactions?: Record<string, string[]>; // emoji -> addresses
  replyTo?: string;        // message id
  replyPreview?: string;   // bounded text excerpt, including parents outside this page
}

export type PushMessagePart = Pick<ChatMessage, 'body' | 'pushAttachment' | 'pushMediaUrl'>;

export interface MessagePage {
  messages: ChatMessage[];
  olderCursor?: string;
}

export type ConversationKind = "dm" | "room";

export interface Conversation {
  /** Original Push room capabilities, never interpreted as native Chat gate policy. */
  push?: import("./pushRooms.js").PushRoomDetails;
  id: string;
  kind: ConversationKind;
  title: string;
  namespace?: string;
  /** Member addresses (DMs: 2; rooms: N). */
  peers: string[];
  description?: string;
  /** Room gate (rooms only). */
  gate?: Gate;
  /** Effective action policy (rooms only) — org default merged with room override. */
  policy?: Policy;
  /** Current identity's room role, derived from the transport; actions recheck it. */
  isAdmin?: boolean;
  /** Invalid or unsupported received room metadata; room actions must be blocked. */
  configurationError?: boolean;
  lastMessage?: ChatMessage;
  /** Latest peer receipt time; XMTP receipts do not identify an exact message. */
  lastReadReceiptAt?: number;
  unread: number;
  /** A DM that the peer has not yet accepted (request state). */
  pending?: boolean;
  /** A denied DM stays discoverable in the blocked list without message previews. */
  blocked?: boolean;
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
  readonly warning?: string;
  /** Identity this transport is acting as. */
  me(): Identity;
  init(): Promise<void>;
  /** Create the encrypted inbox. `revokeStale` first revokes the inbox's existing
   *  installations (used to recover from XMTP's 10-installation-per-inbox limit). */
  enable?(opts?: { revokeStale?: boolean }): Promise<void>;
  /** Ask an existing online installation for history; resolution only confirms the request. */
  requestHistorySync?(): Promise<void>;
  listConversations(): Promise<Conversation[]>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  listMessagePage(conversationId: string, before?: string): Promise<MessagePage>;
  send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage>;
  react(conversationId: string, messageId: string, emoji: string): Promise<void>;
  markRead(conversationId: string, options?: { sendReceipt: boolean; throughMessageId?: string }): Promise<void>;
  setConversationConsent(conversationId: string, state: "allowed" | "denied"): Promise<void>;
  startDm(address: string, handle?: string): Promise<Conversation>;
  createRoom(input: StartRoomInput): Promise<Conversation>;
  /** Ask the configured gatekeeper bot to add this wallet/inbox to a gated room. */
  requestRoomJoin?(conversationId: string): Promise<void>;
  /** Update a room's effective policy (admin action — e.g. freeze posting). */
  setRoomPolicy(conversationId: string, policy: Policy): Promise<void>;
  /** Subscribe to any change (new message, new conversation, read state). */
  subscribe(cb: () => void): () => void;
}
