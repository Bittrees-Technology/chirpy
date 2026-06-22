import type { Identity, OrgConfig, Policy } from "@app/core";
import type { DecodedMessage, EnrichedReply, Reaction } from "@xmtp/browser-sdk";
import type {
  ChatMessage,
  Conversation,
  StartRoomInput,
  Transport,
  TransportStatus,
} from "./types";
import { makeInjectedSigner } from "./xmtpSigner";

type Sdk = typeof import("@xmtp/browser-sdk");
type XmtpClient = Awaited<ReturnType<Sdk["Client"]["create"]>>;
type XmtpConversation = Awaited<ReturnType<XmtpClient["conversations"]["createDmWithIdentifier"]>>;
type StreamHandle = AsyncIterable<DecodedMessage> & { return?: () => void };

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface PeerState {
  accountIdentifiers?: { identifier?: string }[];
}

let SDK: Sdk | null = null;
let sharedXmtp: { address: string; client: XmtpClient } | null = null;

const READY_PREFIX = "chirpy.xmtp.ready.";
const PEER_KEY = "chirpy.xmtp.peers";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

const readyKey = (address: string) => `${READY_PREFIX}${address.toLowerCase()}`;
const normalizeAddress = (address: string) => {
  const next = address.trim().toLowerCase();
  if (!ETH_ADDRESS.test(next)) throw new Error("Enter a valid 0x address.");
  return next;
};

const nsToMs = (ns: bigint | undefined) => Number((ns ?? 0n) / 1_000_000n);
const xmtpOptions = (sdk: Sdk) => ({
  env: "production",
  loggingLevel: sdk.LogLevel.Off,
}) as unknown;

function wasEnabled(address: string) {
  try { return localStorage.getItem(readyKey(address)) === "1"; } catch { return false; }
}

function markEnabled(address: string) {
  try { localStorage.setItem(readyKey(address), "1"); } catch { /* ignore */ }
}

function forgetEnabled(address: string) {
  if (sharedXmtp?.address.toLowerCase() === address.toLowerCase()) sharedXmtp = null;
  try { localStorage.removeItem(readyKey(address)); } catch { /* ignore */ }
}

function isUnregisteredIdentity(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /register_identity|uninitialized identity|identity error/i.test(message);
}

function humanError(error: unknown) {
  const message = error instanceof Error && error.message ? error.message : String(error ?? "Something went wrong.");
  if (/lock|already.*open|opfs|another connection/i.test(message)) {
    return "Messaging is already open in another tab. Close other tabs of this site and try again.";
  }
  return message;
}

function loadPeerCache(): Map<string, string> {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(PEER_KEY) || "{}")));
  } catch {
    return new Map();
  }
}

function savePeerCache(peers: Map<string, string>) {
  try { localStorage.setItem(PEER_KEY, JSON.stringify(Object.fromEntries(peers))); } catch { /* ignore */ }
}

function previewOf(sdk: Sdk, message: DecodedMessage) {
  if (sdk.isText(message)) return String((message as DecodedMessage<string>).content ?? "");
  if (sdk.isTextReply(message)) {
    return String((message.content as EnrichedReply<string> | undefined)?.content ?? "");
  }
  return "Message";
}

function aggregateReactions(
  sdk: Sdk,
  raw: DecodedMessage<Reaction>[],
  inboxToAddress: (inboxId: string) => string,
): Record<string, string[]> | undefined {
  const latest = new Map<string, { emoji: string; sender: string; added: boolean; at: bigint }>();
  for (const reaction of raw) {
    const content = reaction.content;
    if (!content?.content) continue;
    const key = `${reaction.senderInboxId}\0${content.content}`;
    const at = reaction.sentAtNs ?? 0n;
    const prev = latest.get(key);
    if (!prev || at >= prev.at) {
      latest.set(key, {
        emoji: content.content,
        sender: reaction.senderInboxId,
        added: content.action === sdk.ReactionAction.Added,
        at,
      });
    }
  }

  const byEmoji: Record<string, string[]> = {};
  for (const entry of latest.values()) {
    if (!entry.added) continue;
    const address = inboxToAddress(entry.sender);
    byEmoji[entry.emoji] = [...(byEmoji[entry.emoji] ?? []), address];
  }
  return Object.keys(byEmoji).length ? byEmoji : undefined;
}

function toChatMessage(
  sdk: Sdk,
  message: DecodedMessage,
  conversationId: string,
  inboxToAddress: (inboxId: string) => string,
  rememberSender: (messageId: string, senderInboxId: string) => void,
): ChatMessage | null {
  let body: string | null = null;
  let replyTo: string | undefined;

  if (sdk.isText(message)) {
    body = String((message as DecodedMessage<string>).content ?? "");
  } else if (sdk.isTextReply(message)) {
    const reply = message.content as EnrichedReply<string> | undefined;
    body = reply?.content ?? null;
    replyTo = reply?.inReplyTo?.id ?? reply?.referenceId;
  }
  if (body === null) return null;

  rememberSender(message.id, message.senderInboxId);
  return {
    id: message.id,
    conversationId,
    sender: inboxToAddress(message.senderInboxId),
    body,
    sentAt: nsToMs(message.sentAtNs),
    reactions: aggregateReactions(sdk, message.reactions ?? [], inboxToAddress),
    replyTo,
  };
}

export class XmtpTransport implements Transport {
  readonly id = "xmtp" as const;
  status: TransportStatus = "idle";

  private sdk: Sdk | null = null;
  private client: XmtpClient | null = null;
  private conversations = new Map<string, XmtpConversation>();
  private peerByConversation = loadPeerCache();
  private peerInboxByConversation = new Map<string, string>();
  private senderInboxByMessage = new Map<string, string>();
  private stream: StreamHandle | null = null;
  private streamStopped = false;
  private streamRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceiptAt = new Map<string, number>();
  private changeCallback: (() => void) | null = null;
  private readonly myAddress: string;

  constructor(
    private org: OrgConfig,
    private identity: Identity,
    private provider: Eip1193Provider | null,
  ) {
    this.myAddress = identity.address.toLowerCase();
    void this.org;
  }

  me(): Identity { return this.identity; }

  private async loadSdk() {
    return (this.sdk ??= SDK ??= await import("@xmtp/browser-sdk"));
  }

  private async identifier(address = this.myAddress) {
    const sdk = await this.loadSdk();
    return { identifier: address.toLowerCase(), identifierKind: sdk.IdentifierKind.Ethereum };
  }

  private requireClient() {
    if (!this.client || this.status !== "ready") {
      throw new Error("XMTP messaging is not enabled yet.");
    }
    return this.client;
  }

  private async adopt(client: XmtpClient) {
    this.client = client;
    this.status = "ready";
    await this.listConversations();
    if (this.changeCallback) {
      void this.runStream(this.changeCallback);
      this.startPoll(this.changeCallback);
    }
  }

  async init(): Promise<void> {
    if (!this.provider || !ETH_ADDRESS.test(this.myAddress)) {
      this.status = "idle";
      return;
    }
    if (sharedXmtp?.address.toLowerCase() === this.myAddress) {
      try {
        await this.adopt(sharedXmtp.client);
        return;
      } catch {
        sharedXmtp = null;
      }
    }
    if (!wasEnabled(this.myAddress)) {
      this.status = "idle";
      return;
    }

    try {
      const sdk = await this.loadSdk();
      const client = await sdk.Client.build(
        await this.identifier(),
        xmtpOptions(sdk) as Parameters<typeof sdk.Client.build>[1],
      );
      sharedXmtp = { address: this.myAddress, client };
      await this.adopt(client);
    } catch {
      this.client = null;
      this.status = "idle";
    }
  }

  async enable(): Promise<void> {
    if (!this.provider) throw new Error("Connect a wallet to enable XMTP.");
    const sdk = await this.loadSdk();
    this.status = "enabling";
    try {
      const client = await sdk.Client.create(
        makeInjectedSigner(this.provider, this.myAddress, sdk.IdentifierKind.Ethereum),
        xmtpOptions(sdk) as Parameters<typeof sdk.Client.create>[1],
      );
      sharedXmtp = { address: this.myAddress, client };
      markEnabled(this.myAddress);
      await this.adopt(client);
    } catch (error) {
      this.status = "error";
      throw new Error(humanError(error));
    }
  }

  private async resolvePeer(conversation: XmtpConversation) {
    const id = conversation.id;
    const cached = this.peerByConversation.get(id);
    if (cached) return cached;

    try {
      const peerInboxId = await conversation.peerInboxId();
      this.peerInboxByConversation.set(id, peerInboxId);
      const client = this.requireClient();
      let states: PeerState[] = await client.preferences.getInboxStates([peerInboxId]) as PeerState[];
      if (!states?.[0]?.accountIdentifiers?.length) {
        states = await client.preferences.fetchInboxStates([peerInboxId]) as PeerState[];
      }
      const identifiers = states?.[0]?.accountIdentifiers ?? [];
      const eth = identifiers.find((entry) => entry.identifier && ETH_ADDRESS.test(entry.identifier)) ?? identifiers[0];
      const address = eth?.identifier?.toLowerCase();
      if (address) {
        this.peerByConversation.set(id, address);
        savePeerCache(this.peerByConversation);
      }
      return address;
    } catch {
      return undefined;
    }
  }

  private addressForInbox(conversationId: string, inboxId: string) {
    const client = this.client;
    if (client && inboxId === client.inboxId) return this.myAddress;
    if (this.peerInboxByConversation.get(conversationId) === inboxId) {
      return this.peerByConversation.get(conversationId) ?? inboxId;
    }
    return this.peerByConversation.get(conversationId) ?? inboxId;
  }

  private async mapConversation(conversation: XmtpConversation): Promise<Conversation> {
    this.conversations.set(conversation.id, conversation);
    const peer = await this.resolvePeer(conversation);
    let lastMessage: ChatMessage | undefined;

    try {
      const sdk = await this.loadSdk();
      const last = await conversation.lastMessage();
      if (last) {
        lastMessage = toChatMessage(
          sdk,
          last,
          conversation.id,
          (inboxId) => this.addressForInbox(conversation.id, inboxId),
          (messageId, senderInboxId) => this.senderInboxByMessage.set(messageId, senderInboxId),
        ) ?? undefined;
      }
    } catch {
      lastMessage = undefined;
    }

    let pending = false;
    try {
      const sdk = await this.loadSdk();
      pending = await conversation.consentState() === sdk.ConsentState.Unknown;
    } catch {
      pending = false;
    }

    const title = peer ?? "Direct message";
    return {
      id: conversation.id,
      kind: "dm",
      title,
      peers: peer ? [this.myAddress, peer] : [this.myAddress],
      lastMessage,
      unread: 0,
      pending,
    };
  }

  async listConversations(): Promise<Conversation[]> {
    const client = this.client;
    if (!client || this.status !== "ready") return [];
    try {
      await client.conversations.sync();
      await client.conversations.syncAll();
      const list = await client.conversations.listDms();
      this.conversations = new Map(list.map((conversation) => [conversation.id, conversation]));
      const mapped = await Promise.all(list.map((conversation) => this.mapConversation(conversation)));
      return mapped.sort((a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0));
    } catch (error) {
      if (isUnregisteredIdentity(error)) {
        forgetEnabled(this.myAddress);
        this.client = null;
        this.status = "idle";
        return [];
      }
      throw new Error(humanError(error));
    }
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || this.status !== "ready") return [];
    try {
      await conversation.sync();
      const sdk = await this.loadSdk();
      const raw = await conversation.messages({ limit: 100000n });
      const messages = raw
        .map((message) => toChatMessage(
          sdk,
          message,
          conversationId,
          (inboxId) => this.addressForInbox(conversationId, inboxId),
          (messageId, senderInboxId) => this.senderInboxByMessage.set(messageId, senderInboxId),
        ))
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((a, b) => a.sentAt - b.sentAt);
      return messages;
    } catch (error) {
      throw new Error(humanError(error));
    }
  }

  async send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const text = body.trim();
    if (!text) throw new Error("Message cannot be empty.");
    const sdk = await this.loadSdk();

    let messageId: string;
    if (opts?.replyTo) {
      const referenceInboxId = this.senderInboxByMessage.get(opts.replyTo);
      if (!referenceInboxId) throw new Error("Reply target is not loaded yet.");
      messageId = await conversation.sendReply({
        content: await sdk.encodeText(text),
        reference: opts.replyTo,
        referenceInboxId,
      });
    } else {
      messageId = await conversation.sendText(text);
    }

    return {
      id: messageId,
      conversationId,
      sender: this.myAddress,
      body: text,
      sentAt: Date.now(),
      replyTo: opts?.replyTo,
    };
  }

  async react(conversationId: string, messageId: string, emoji: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const referenceInboxId = this.senderInboxByMessage.get(messageId);
    if (!referenceInboxId) throw new Error("Reaction target is not loaded yet.");

    const sdk = await this.loadSdk();
    const current = (await this.listMessages(conversationId)).find((message) => message.id === messageId);
    const had = current?.reactions?.[emoji]?.some((address) => address.toLowerCase() === this.myAddress) ?? false;
    await conversation.sendReaction({
      reference: messageId,
      referenceInboxId,
      action: had ? sdk.ReactionAction.Removed : sdk.ReactionAction.Added,
      content: emoji,
      schema: sdk.ReactionSchema.Unicode,
    });
  }

  async markRead(conversationId: string): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) return;
    const now = Date.now();
    if (now - (this.lastReceiptAt.get(conversationId) ?? 0) < 3000) return;
    this.lastReceiptAt.set(conversationId, now);
    try { await conversation.sendReadReceipt(); } catch { /* best effort */ }
  }

  async startDm(address: string, handle?: string): Promise<Conversation> {
    const client = this.requireClient();
    const target = normalizeAddress(address);
    const identifier = await this.identifier(target);
    const reachable = await client.canMessage([identifier]);
    const ok = reachable instanceof Map ? reachable.get(target) : Array.isArray(reachable) ? reachable[0] : reachable;
    if (!ok) throw new Error("That address hasn't activated XMTP messaging yet.");
    const conversation = await client.conversations.createDmWithIdentifier(identifier);
    this.peerByConversation.set(conversation.id, target);
    savePeerCache(this.peerByConversation);
    const mapped = await this.mapConversation(conversation);
    return { ...mapped, title: handle || mapped.title };
  }

  async createRoom(_input: StartRoomInput): Promise<Conversation> {
    throw new Error("Rooms need Push Protocol (coming soon).");
  }

  async setRoomPolicy(_conversationId: string, _policy: Policy): Promise<void> {}

  subscribe(cb: () => void): () => void {
    this.changeCallback = cb;
    this.streamStopped = false;
    void this.runStream(cb);
    this.startPoll(cb);
    return () => {
      if (this.changeCallback === cb) this.changeCallback = null;
      this.streamStopped = true;
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      this.cleanupEvents?.();
      this.cleanupEvents = null;
      try { this.stream?.return?.(); } catch { /* ignore */ }
      this.stream = null;
    };
  }

  private startPoll(cb: () => void) {
    if (this.pollTimer) clearInterval(this.pollTimer);
    const sync = () => {
      if (this.status !== "ready") return;
      if (!this.streamRunning) void this.runStream(cb);
      void this.listConversations().then(cb).catch((error) => {
        if (isUnregisteredIdentity(error)) {
          forgetEnabled(this.myAddress);
          this.status = "idle";
        }
      });
    };
    this.pollTimer = setInterval(sync, 10_000);
    if (typeof window !== "undefined") {
      const visible = () => { if (document.visibilityState === "visible") sync(); };
      window.addEventListener("focus", sync);
      window.addEventListener("online", sync);
      document.addEventListener("visibilitychange", visible);
      this.cleanupEvents?.();
      this.cleanupEvents = () => {
        window.removeEventListener("focus", sync);
        window.removeEventListener("online", sync);
        document.removeEventListener("visibilitychange", visible);
      };
    }
  }

  private cleanupEvents: (() => void) | null = null;

  private async runStream(cb: () => void) {
    if (this.streamRunning) return;
    const client = this.client;
    if (!client) return;
    this.streamRunning = true;
    try {
      while (!this.streamStopped && this.status === "ready") {
        try {
          this.stream = await client.conversations.streamAllMessages() as StreamHandle;
          for await (const message of this.stream) {
            if (this.streamStopped) break;
            if (message.conversationId) {
              const conversation = await client.conversations.getConversationById(message.conversationId);
              if (conversation) this.conversations.set(message.conversationId, conversation as XmtpConversation);
            }
            cb();
          }
        } catch {
          /* reconnect below */
        }
        if (this.streamStopped) break;
        try { await this.listConversations(); cb(); } catch { /* ignore */ }
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      this.streamRunning = false;
    }
  }
}
