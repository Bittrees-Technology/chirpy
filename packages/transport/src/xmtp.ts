import {
  decodeGate,
  encodeGate,
  evalGate,
  validateProductionGate,
  evaluatePolicy,
  makeViemChainReader,
  mergePolicy,
  type ChainReader,
  type Gate,
  type Identity,
  type OrgConfig,
  type Policy,
  type RoomSeed,
} from "@app/core";
import type { DecodedMessage, EnrichedReply, Reaction } from "@xmtp/browser-sdk";
import type {
  ChatMessage,
  Conversation,
  StartRoomInput,
  Transport,
  TransportStatus,
} from "./types.js";
import { ReadState } from "./readState.js";
import { makeInjectedSigner } from "./xmtpSigner.js";

type Sdk = typeof import("@xmtp/browser-sdk");
type XmtpClient = Awaited<ReturnType<Sdk["Client"]["create"]>>;
type XmtpConversation = Awaited<ReturnType<XmtpClient["conversations"]["list"]>>[number];
type StreamHandle = AsyncIterable<DecodedMessage> & { return?: () => void };

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

interface PeerState {
  accountIdentifiers?: { identifier?: string }[];
}

interface RoomMeta {
  gate: Gate;
  policy: Policy;
  description?: string;
  namespace?: string;
}

export interface ConversationClassificationMeta {
  metadata?: { conversationType?: unknown };
  name?: unknown;
}

let SDK: Sdk | null = null;
let sharedXmtp: { address: string; client: XmtpClient } | null = null;

const READY_PREFIX = "chirpy.xmtp.ready.";
const PEER_KEY = "chirpy.xmtp.peers";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
const ROOM_META_VERSION = 1;
const OPEN_GATE: Gate = { combine: "any", rules: [] };


const readyKey = (address: string) => `${READY_PREFIX}${address.toLowerCase()}`;
const normalizeAddress = (address: string) => {
  const next = address.trim().toLowerCase();
  if (!ETH_ADDRESS.test(next)) throw new Error("Enter a valid 0x address.");
  return next;
};

const nsToMs = (ns: bigint | undefined) => Number((ns ?? 0n) / 1_000_000n);
const xmtpEnv = () => getImportMetaEnv().VITE_XMTP_ENV === "dev" ? "dev" : "production";
const xmtpOptions = (sdk: Sdk) => ({
  env: xmtpEnv(),
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

/** XMTP caps each inbox at 10 registered installations (devices/browsers). */
function isInstallationLimit(error: unknown) {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /already registered\s+\d+\s*\/\s*\d+\s+installations|revoke\s+(your\s+)?existing\s+installations|installation\s+limit|maximum number of installations|too many installations/i.test(message);
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

function roomMetaDescription(input: RoomMeta) {
  return JSON.stringify({
    chirpyRoom: ROOM_META_VERSION,
    namespace: input.namespace,
    description: input.description,
    gate: encodeGate(input.gate),
    policy: input.policy,
  });
}

function hasGate(gate: Gate) {
  return (gate.rules?.length ?? 0) > 0;
}

const textEncoder = new TextEncoder();
const bytesToHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

function parseRoomMeta(description: string | undefined, orgPolicy: Policy): RoomMeta {
  const fallback: RoomMeta = {
    gate: OPEN_GATE,
    policy: mergePolicy(orgPolicy),
    description: description || undefined,
  };
  if (!description) return fallback;
  try {
    const parsed = JSON.parse(description) as {
      chirpyRoom?: number;
      namespace?: string;
      description?: string;
      gate?: string | Gate;
      policy?: Policy;
    };
    if (parsed.chirpyRoom !== ROOM_META_VERSION) return fallback;
    const gate = typeof parsed.gate === "string"
      ? decodeGate(parsed.gate)
      : parsed.gate ?? OPEN_GATE;
    return {
      gate,
      policy: mergePolicy(orgPolicy, parsed.policy),
      description: parsed.description,
      namespace: parsed.namespace,
    };
  } catch {
    return fallback;
  }
}

function getImportMetaEnv(): Record<string, string | undefined> {
  return (import.meta as unknown as { env?: Record<string, string | undefined> }).env ?? {};
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

export function classifyConversation(
  conversation: ConversationClassificationMeta,
  groupType?: unknown,
): "dm" | "room" {
  return conversation.metadata?.conversationType === groupType || "name" in conversation
    ? "room"
    : "dm";
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
  if (body === null && sdk.isReply(message)) body = "This reply contains content Chirpy cannot display yet.";
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
  warning: string | undefined;

  private sdk: Sdk | null = null;
  private client: XmtpClient | null = null;
  private conversations = new Map<string, XmtpConversation>();
  private roomMeta = new Map<string, RoomMeta>();
  private peerByConversation = loadPeerCache();
  private peerInboxByConversation = new Map<string, string>();
  private senderInboxByMessage = new Map<string, string>();
  private reader: ChainReader | null = null;
  private stream: StreamHandle | null = null;
  private streamStopped = false;
  private streamRunning = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceiptAt = new Map<string, number>();
  private changeCallback: (() => void) | null = null;
  private readonly myAddress: string;
  private readonly readState: ReadState;
  private messageCursors = new Map<string, { conversationId: string; at: bigint }>();

  constructor(
    private org: OrgConfig,
    private identity: Identity,
    private provider: Eip1193Provider | null,
  ) {
    this.myAddress = identity.address.toLowerCase();
    this.readState = new ReadState(`${xmtpEnv()}:${this.myAddress}`);
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

  private gatekeeperAddress() {
    const value = getImportMetaEnv().VITE_GATEKEEPER_ADDRESS?.trim();
    if (!value) return null;
    return normalizeAddress(value);
  }

  /** Where gated-room joins are sent. An org can run its own gate service and point
   *  `OrgConfig.gateUrl` at it (e.g. a self-hosted container, since the XMTP gatekeeper
   *  bot needs a runtime that supports @xmtp/node-sdk's native bindings); otherwise we
   *  use this deployment's own same-origin `/api/room-join`. */
  private gateEndpoint() {
    return this.org.gateUrl?.trim() || "/api/room-join";
  }

  private chainReader() {
    return (this.reader ??= makeViemChainReader(
      this.org.chain.rpcUrl || getImportMetaEnv().VITE_MAINNET_RPC_URL,
    ));
  }

  private requireClient() {
    if (!this.client || this.status !== "ready") {
      throw new Error("XMTP messaging is not enabled yet.");
    }
    return this.client;
  }

  private requireInboxId() {
    const inboxId = this.requireClient().inboxId;
    if (!inboxId) throw new Error("XMTP inbox is not ready yet.");
    return inboxId;
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

  async enable(opts?: { revokeStale?: boolean }): Promise<void> {
    if (!this.provider) throw new Error("Connect a wallet to enable XMTP.");
    const sdk = await this.loadSdk();
    this.status = "enabling";
    try {
      // Recovery path: if the inbox is at XMTP's 10-installation limit, revoke the
      // existing installations (one wallet signature) so a fresh one can register.
      if (opts?.revokeStale) await this.revokeStaleInstallations(sdk);
      const client = await sdk.Client.create(
        makeInjectedSigner(this.provider, this.myAddress, sdk.IdentifierKind.Ethereum),
        xmtpOptions(sdk) as Parameters<typeof sdk.Client.create>[1],
      );
      sharedXmtp = { address: this.myAddress, client };
      markEnabled(this.myAddress);
      await this.adopt(client);
    } catch (error) {
      this.status = "error";
      // Surface the 10/10 case as a typed, actionable error so the UI can keep offering
      // a one-click "revoke old sessions & enable" instead of dead-ending. We must keep the
      // code on the revokeStale retry too: if the revoke cleared nothing (or hasn't
      // propagated yet) and Client.create still hits the cap, a code-less error would make
      // the recovery button vanish — stranding the exact flow this path exists to rescue.
      if (isInstallationLimit(error)) {
        const friendly = new Error(
          opts?.revokeStale
            ? "We revoked the old sessions, but XMTP still reports this inbox at its 10-device limit. Revocations can take a few seconds to propagate — wait a moment and try again."
            : "Your messaging inbox already has the maximum 10 devices/sessions registered. Revoke the old ones to enable messaging on this device.",
        ) as Error & { code?: string };
        friendly.code = "installation_limit";
        throw friendly;
      }
      throw new Error(humanError(error));
    }
  }

  /** Revoke every installation currently registered on this inbox (no client needed —
   *  uses the static revoke path, which works even at the 10/10 limit). */
  private async revokeStaleInstallations(sdk: Sdk): Promise<number> {
    if (!this.provider) throw new Error("Connect a wallet to revoke installations.");
    const identifier = await this.identifier();
    // Resolve the inbox the network actually associates with this wallet — the same lookup
    // Client.create performs via getInboxIdForIdentifier. generateInboxId() only yields the
    // deterministic nonce-0 inbox, which is wrong for wallets registered at a non-zero nonce
    // or with a reassigned recovery address: we'd fetch/revoke the wrong inbox, find nothing,
    // and strand the user on a red error. Fall back to the nonce-0 id only when the wallet has
    // no on-network inbox yet (nothing to revoke either way).
    const helpers = sdk as unknown as {
      createBackend: (options?: { env?: string }) => Promise<unknown>;
      getInboxIdForIdentifier: (backend: unknown, id: typeof identifier) => Promise<string | undefined>;
      generateInboxId: (id: typeof identifier, nonce?: bigint) => Promise<string>;
    };
    let inboxId: string | undefined;
    try {
      const backend = await helpers.createBackend({ env: xmtpEnv() });
      inboxId = await helpers.getInboxIdForIdentifier(backend, identifier);
    } catch {
      inboxId = undefined;
    }
    if (!inboxId) inboxId = await helpers.generateInboxId(identifier);
    const ClientStatic = sdk.Client as unknown as {
      fetchInboxStates: (inboxIds: string[], env?: unknown) => Promise<Array<{ installations?: Array<{ bytes: Uint8Array }> }>>;
      revokeInstallations: (signer: unknown, inboxId: string, ids: Uint8Array[], env?: unknown) => Promise<void>;
    };
    const states = await ClientStatic.fetchInboxStates([inboxId], xmtpEnv());
    const ids = (states?.[0]?.installations ?? []).map((i) => i.bytes).filter(Boolean);
    if (!ids.length) return 0;
    await ClientStatic.revokeInstallations(
      makeInjectedSigner(this.provider, this.myAddress, sdk.IdentifierKind.Ethereum),
      inboxId,
      ids,
      xmtpEnv(),
    );
    return ids.length;
  }

  private async resolvePeer(conversation: XmtpConversation) {
    const id = conversation.id;
    const cached = this.peerByConversation.get(id);
    if (cached) return cached;

    try {
      const dm = conversation as XmtpConversation & { peerInboxId: () => Promise<string> };
      const peerInboxId = await dm.peerInboxId();
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

  private isRoomConversation(sdk: Sdk, conversation: XmtpConversation) {
    return classifyConversation(conversation, sdk.ConversationType.Group) === "room";
  }

  private async addressesForMembers(conversation: XmtpConversation) {
    const client = this.requireClient();
    const myInboxId = this.requireInboxId();
    const members = await conversation.members().catch(() => []);
    const inboxIds = [...new Set(members
      .map((member) => {
        const value = member as { inboxId?: string; inbox_id?: string };
        return value.inboxId ?? value.inbox_id;
      })
      .filter((inboxId): inboxId is string => Boolean(inboxId)))];

    if (!inboxIds.length) return [];

    let states: PeerState[] = await client.preferences.getInboxStates(inboxIds) as PeerState[];
    if (states.some((state) => !state?.accountIdentifiers?.length)) {
      states = await client.preferences.fetchInboxStates(inboxIds) as PeerState[];
    }

    const peers = inboxIds.map((inboxId, index) => {
      if (inboxId === myInboxId) return this.myAddress;
      const identifiers = states[index]?.accountIdentifiers ?? [];
      const eth = identifiers.find((entry) => entry.identifier && ETH_ADDRESS.test(entry.identifier)) ?? identifiers[0];
      return eth?.identifier?.toLowerCase() ?? inboxId;
    });
    return [...new Set(peers)];
  }

  private async isCurrentUserAdmin(conversation: XmtpConversation) {
    const myInboxId = this.requireInboxId();
    const group = conversation as XmtpConversation & { isAdmin?: (inboxId: string) => Promise<boolean> };
    return await group.isAdmin?.(myInboxId).catch(() => false) ?? false;
  }

  private async assertGateAllows(meta: RoomMeta) {
    if ((meta.gate.rules?.length ?? 0) === 0) return;
    const passes = await evalGate(meta.gate, this.myAddress, this.chainReader(), this.org.gating);
    if (!passes) throw new Error("This wallet does not satisfy the room gate.");
  }

  private async unreadCount(conversation: XmtpConversation): Promise<number> {
    const sdk = await this.loadSdk();
    const count = await conversation.countMessages({
      contentTypes: [sdk.ContentType.Text, sdk.ContentType.Reply],
      excludeSenderInboxIds: [this.requireInboxId()],
      sentAfterNs: this.readState.get(conversation.id),
    });
    return Number(count > BigInt(Number.MAX_SAFE_INTEGER) ? BigInt(Number.MAX_SAFE_INTEGER) : count);
  }

  private async mapRoomConversation(conversation: XmtpConversation): Promise<Conversation> {
    this.conversations.set(conversation.id, conversation);
    await conversation.sync().catch(() => undefined);

    const group = conversation as XmtpConversation & { name?: string; description?: string };
    const meta = parseRoomMeta(group.description, this.org.policy);
    this.roomMeta.set(conversation.id, meta);

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

    return {
      id: conversation.id,
      kind: "room",
      title: group.name || "Room",
      description: meta.description,
      peers: await this.addressesForMembers(conversation).catch(() => []),
      namespace: meta.namespace,
      gate: meta.gate,
      policy: meta.policy,
      lastMessage,
      unread: await this.unreadCount(conversation),
    };
  }

  private catalogCache: { at: number; rooms: Conversation[] } | null = null;

  private async publishedRooms(): Promise<Conversation[]> {
    if (!this.org.gateUrl) return [];
    if (this.catalogCache && Date.now() - this.catalogCache.at < 60_000) return this.catalogCache.rooms;
    const response = await fetch(this.gateEndpoint(), {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "catalog", namespace: this.org.namespace }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("Published rooms are unavailable. Try again shortly.");
    const payload = await response.json();
    if (!Array.isArray(payload.rooms)) throw new Error("Invalid room directory.");
    const rooms: Conversation[] = payload.rooms.filter((r: any) =>
      r.namespace === this.org.namespace && typeof r.id === "string" && typeof r.title === "string" && validateProductionGate(r.gate)
    ).map((r: any) => ({ id: r.id, namespace: r.namespace, kind: "room", title: r.title,
      peers: [], gate: r.gate, policy: mergePolicy(this.org.policy), unread: 0 }));
    this.catalogCache = { at: Date.now(), rooms };
    return rooms;
  }

  private async mapConversation(conversation: XmtpConversation): Promise<Conversation> {
    const sdk = await this.loadSdk();
    if (this.isRoomConversation(sdk, conversation)) return this.mapRoomConversation(conversation);

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

    const consent = await conversation.consentState();
    const pending = consent !== sdk.ConsentState.Allowed && consent !== sdk.ConsentState.Denied;
    const blocked = consent === sdk.ConsentState.Denied;

    const title = peer ?? "Direct message";
    return {
      id: conversation.id,
      kind: "dm",
      title,
      peers: peer ? [this.myAddress, peer] : [this.myAddress],
      lastMessage: blocked ? undefined : lastMessage,
      unread: blocked ? 0 : await this.unreadCount(conversation),
      pending,
      blocked,
    };
  }

  async listConversations(): Promise<Conversation[]> {
    const client = this.client;
    if (!client || this.status !== "ready") return [];
    try {
      await client.conversations.sync();
      await client.conversations.syncAll();
      const list = await client.conversations.list();
      this.conversations = new Map(list.map((conversation) => [conversation.id, conversation]));
      this.roomMeta.clear();
      const mapped = await Promise.all(list.map((conversation) => this.mapConversation(conversation)));
      const scoped = mapped.filter((c) => c.kind === "dm" || c.namespace === this.org.namespace ||
        (!c.namespace && this.org.namespace === "personal"));
      let directory: Conversation[] = [];
      try { directory = await this.publishedRooms(); this.warning = undefined; }
      catch { this.warning = "Published rooms are unavailable. Existing chats still work; room joins may need to be retried."; directory = this.catalogCache?.rooms ?? []; }
      for (const room of directory) {
        const existing = scoped.find((c) => c.id === room.id);
        if (!existing) scoped.push(room);
        this.roomMeta.set(room.id, { namespace: room.namespace, gate: room.gate!, policy: room.policy! });
      }
      return scoped.sort((a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0));
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
      const sdk = await this.loadSdk();
      if (!this.isRoomConversation(sdk, conversation) && await conversation.consentState() === sdk.ConsentState.Denied) return [];
      await conversation.sync();
      const raw = await conversation.messages({ limit: 100000n });
      for (const message of raw) {
        if (sdk.isText(message) || sdk.isReply(message)) this.messageCursors.set(message.id, { conversationId, at: message.sentAtNs });
      }
      const messages = raw
        .map((message) => toChatMessage(
          sdk,
          message,
          conversationId,
          (inboxId) => this.addressForInbox(conversationId, inboxId),
          (messageId, senderInboxId) => this.senderInboxByMessage.set(messageId, senderInboxId),
        ))
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((a, b) => {
          const left = this.messageCursors.get(a.id)?.at ?? 0n;
          const right = this.messageCursors.get(b.id)?.at ?? 0n;
          return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
        });
      return messages;
    } catch (error) {
      throw new Error(humanError(error));
    }
  }

  async send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    await this.assertConversationAccepted(conversation);
    const text = body.trim();
    if (!text) throw new Error("Message cannot be empty.");
    const sdk = await this.loadSdk();
    const room = this.roomMeta.get(conversationId);

    if (room) {
      await this.assertGateAllows(room);
      const decision = evaluatePolicy(room.policy, { type: "send" }, {
        isAdmin: await this.isCurrentUserAdmin(conversation),
      });
      if (!decision.allowed) throw new Error(decision.reason || "Blocked by room policy.");
    }

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
    await this.assertConversationAccepted(conversation);
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

  async markRead(conversationId: string, options?: { sendReceipt: boolean; throughMessageId?: string }): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    const cursor = options?.throughMessageId ? this.messageCursors.get(options.throughMessageId) : undefined;
    if (!conversation || !cursor || cursor.conversationId !== conversationId) return;
    const sdk = await this.loadSdk();
    const room = this.isRoomConversation(sdk, conversation);
    if (!room && await conversation.consentState() !== sdk.ConsentState.Allowed) return;
    if (!this.readState.advance(conversationId, cursor.at)) return;
    this.changeCallback?.();
    if (room || options?.sendReceipt !== true) return;
    const now = Date.now();
    if (now - (this.lastReceiptAt.get(conversationId) ?? 0) < 3000) return;
    try { await conversation.sendReadReceipt(); this.lastReceiptAt.set(conversationId, now); } catch { /* Local read state is independent of best-effort receipts. */ }
  }

  private async assertConversationAccepted(conversation: XmtpConversation): Promise<void> {
    const sdk = await this.loadSdk();
    if (this.isRoomConversation(sdk, conversation)) return;
    if (await conversation.consentState() !== sdk.ConsentState.Allowed) {
      throw new Error("Accept or unblock this conversation before sending messages or reactions.");
    }
  }

  async setConversationConsent(conversationId: string, state: "allowed" | "denied"): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const sdk = await this.loadSdk();
    if (this.isRoomConversation(sdk, conversation)) throw new Error("Consent controls apply to direct messages.");
    await conversation.updateConsentState(state === "allowed" ? sdk.ConsentState.Allowed : sdk.ConsentState.Denied);
    this.changeCallback?.();
  }

  async startDm(address: string, handle?: string): Promise<Conversation> {
    const client = this.requireClient();
    const target = normalizeAddress(address);
    const identifier = await this.identifier(target);
    const reachable = await client.canMessage([identifier]);
    const ok = reachable instanceof Map ? reachable.get(target) : Array.isArray(reachable) ? reachable[0] : reachable;
    if (!ok) throw new Error("That address hasn't activated XMTP messaging yet.");
    const conversation = await client.conversations.createDmWithIdentifier(identifier);
    const sdk = await this.loadSdk();
    if (await conversation.consentState() === sdk.ConsentState.Unknown) await conversation.updateConsentState(sdk.ConsentState.Allowed);
    this.peerByConversation.set(conversation.id, target);
    savePeerCache(this.peerByConversation);
    const mapped = await this.mapConversation(conversation);
    return { ...mapped, title: handle || mapped.title };
  }

  async createRoom(input: StartRoomInput): Promise<Conversation> {
    const client = this.requireClient();
    const sdk = await this.loadSdk();
    const gate = input.gate ?? OPEN_GATE;
    const policy = mergePolicy(this.org.policy, input.policy);
    const meta: RoomMeta = {
      gate,
      policy,
      description: input.description,
      namespace: this.org.namespace,
    };
    if (hasGate(gate) && (!this.org.gateUrl || !this.gatekeeperAddress())) {
      throw new Error("Gated rooms need an external gate service and gatekeeper address. Ask your organization administrator to configure them first.");
    }
    if (hasGate(gate) && (this.org.chain.chainId !== 1 || !validateProductionGate(gate))) {
      throw new Error("Production gates currently support mainnet token rules (explicit ERC-1155 IDs), Safe owners, and ENS. Check the rule and a positive minimum.");
    }
    const gatekeeperAddress = hasGate(gate) ? this.gatekeeperAddress() : null;
    const gatekeeperInboxId = gatekeeperAddress
      ? await client.fetchInboxIdByIdentifier(await this.identifier(gatekeeperAddress))
      : null;
    if (gatekeeperAddress && !gatekeeperInboxId) {
      throw new Error("Gatekeeper wallet has not activated XMTP messaging yet.");
    }

    const group = await client.conversations.createGroup(gatekeeperInboxId ? [gatekeeperInboxId] : [], {
      permissions: hasGate(gate)
        ? sdk.GroupPermissionsOptions.AdminOnly
        : sdk.GroupPermissionsOptions.Default,
    });

    const updates = [
      group.updateName(input.title),
      group.updateDescription(roomMetaDescription(meta)),
      group.addSuperAdmin(this.requireInboxId()).catch(() => undefined),
    ];
    if (gatekeeperInboxId) updates.push(group.addSuperAdmin(gatekeeperInboxId));
    await Promise.all(updates);
    this.conversations.set(group.id, group);
    this.roomMeta.set(group.id, meta);

    const seedId = await group.sendText(`#${input.title} created.`);
    const mapped = await this.mapRoomConversation(group);
    return {
      ...mapped,
      lastMessage: {
        id: seedId,
        conversationId: group.id,
        sender: this.myAddress,
        body: `#${input.title} created.`,
        sentAt: Date.now(),
      },
    };
  }

  async requestRoomJoin(conversationId: string): Promise<void> {
    const meta = this.roomMeta.get(conversationId);
    if (!meta || meta.namespace !== this.org.namespace) throw new Error("Room not found in this organization.");
    if (!hasGate(meta.gate)) throw new Error("This room is open.");
    if (!this.provider || !this.org.gateUrl) throw new Error("Connect a wallet and configure the organization's external gate.");
    const endpoint = this.gateEndpoint();
    const challengeResponse = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "challenge", convId: conversationId, namespace: this.org.namespace,
        address: this.myAddress, inboxId: this.requireInboxId() }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!challengeResponse.ok) throw new Error("The gate could not authorize this room. Ask an administrator to publish it in the room registry.");
    const challenge = await challengeResponse.json();
    const expectedService = new URL(endpoint, window.location.href);
    if (challenge.convId !== conversationId || challenge.namespace !== this.org.namespace ||
        String(challenge.address).toLowerCase() !== this.myAddress || challenge.inboxId !== this.requireInboxId() ||
        challenge.service !== expectedService.origin + expectedService.pathname ||
        !/^[a-f0-9]{64}$/.test(challenge.nonce) || !Number.isSafeInteger(challenge.expiresAt) ||
        challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 300_000) throw new Error("Invalid join challenge.");
    // Construct the message locally; never sign arbitrary text returned by a gate URL.
    const message = `Chirpy room join (v2)\nService: ${challenge.service}\nRoom: ${conversationId}\nNamespace: ${this.org.namespace}\nWallet: ${challenge.address}\nInbox: ${challenge.inboxId}\nNonce: ${challenge.nonce}\nExpires: ${challenge.expiresAt}\nGas-free authorization for this room only.`;
    const signature = await this.provider.request({ method: "personal_sign", params: [bytesToHex(textEncoder.encode(message)), this.myAddress] });
    if (typeof signature !== "string") throw new Error("Wallet did not return a join signature.");
    const response = await fetch(endpoint, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ action: "join", nonce: challenge.nonce, signature }),
      signal: AbortSignal.timeout(30_000),
    });
    if (response.status === 503) {
      throw new Error("Self-serve joins are not configured. Ask a room admin to add you.");
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload?.error || "Join request failed.");
    }

    await this.requireClient().conversations.sync();
    await this.requireClient().conversations.syncAll();
    this.changeCallback?.();
  }

  async setRoomPolicy(conversationId: string, policy: Policy): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || !this.roomMeta.has(conversationId)) return;
    if (!await this.isCurrentUserAdmin(conversation)) throw new Error("Admins only.");

    const current = this.roomMeta.get(conversationId) ?? {
      gate: OPEN_GATE,
      policy: mergePolicy(this.org.policy, policy),
    };
    const next: RoomMeta = { ...current, policy };
    this.roomMeta.set(conversationId, next);
    const group = conversation as XmtpConversation & { updateDescription?: (description: string) => Promise<void> };
    await group.updateDescription?.(roomMetaDescription(next));
    this.changeCallback?.();
  }

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
