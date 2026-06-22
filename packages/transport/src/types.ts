import type { Gate, Identity } from "@app/core";

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
  lastMessage?: ChatMessage;
  unread: number;
  /** A DM that the peer has not yet accepted (request state). */
  pending?: boolean;
}

export interface StartRoomInput {
  title: string;
  description?: string;
  gate: Gate;
}

/** The interface the UI talks to. Backed by MockTransport today, XmtpTransport later. */
export interface Transport {
  readonly id: "mock" | "xmtp";
  /** Identity this transport is acting as. */
  me(): Identity;
  init(): Promise<void>;
  listConversations(): Promise<Conversation[]>;
  listMessages(conversationId: string): Promise<ChatMessage[]>;
  send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage>;
  react(conversationId: string, messageId: string, emoji: string): Promise<void>;
  markRead(conversationId: string): Promise<void>;
  startDm(address: string, handle?: string): Promise<Conversation>;
  createRoom(input: StartRoomInput): Promise<Conversation>;
  /** Subscribe to any change (new message, new conversation, read state). */
  subscribe(cb: () => void): () => void;
}
