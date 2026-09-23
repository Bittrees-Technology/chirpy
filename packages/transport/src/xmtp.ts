import { InboxIdentities, inboxWallets, messageInboxIds } from "./inboxIdentities.js";
import { INVALID_ROOM_METADATA, MAX_ROOM_DESCRIPTION_LENGTH, ROOM_META_VERSION, parseRoomMeta, type RoomMeta } from "./roomMetadata.js";
import { readMessagePage } from "./messagePage.js";
import { mapConversations } from "./mapConversations.js";
import {
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


export interface ConversationClassificationMeta {
  metadata?: { conversationType?: unknown };
  name?: unknown;
}

let SDK: Sdk | null = null;
let sharedXmtp: { address: string; client: XmtpClient } | null = null;
const roomIdentityResolvers = new WeakMap<XmtpClient, InboxIdentities>();

const READY_PREFIX = "chirpy.xmtp.ready.";
const PEER_KEY = "chirpy.xmtp.peers";
const ETH_ADDRESS = /^0x[a-fA-F0-9]{40}$/;
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

const MAX_PEER_CACHE = 2500;
function loadPeerCache(scope: string): Map<string, string> {
  try {
    const raw = localStorage.getItem(`${PEER_KEY}.${scope}`);
    if (!raw || raw.length > 1_000_000) return new Map();
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();
    const peers = new Map<string, string>();
    for (const [id, address] of Object.entries(value)) {
      if (!id || id.length > 256 || typeof address !== 'string' || !ETH_ADDRESS.test(address)) continue;
      peers.set(id, address.toLowerCase());
      if (peers.size > MAX_PEER_CACHE) peers.delete(peers.keys().next().value!);
    }
    return peers;
  } catch { return new Map(); }
}

function savePeerCache(scope: string, peers: Map<string, string>) {
  while (peers.size > MAX_PEER_CACHE) peers.delete(peers.keys().next().value!);
  try { localStorage.setItem(`${PEER_KEY}.${scope}`, JSON.stringify(Object.fromEntries(peers))); } catch { /* A cache write must not prevent messaging. */ }
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
  let replyPreview: string | undefined;

  if (sdk.isText(message)) {
    body = String((message as DecodedMessage<string>).content ?? "");
  } else if (sdk.isTextReply(message)) {
    const reply = message.content as EnrichedReply<string> | undefined;
    body = reply?.content ?? null;
    replyTo = reply?.inReplyTo?.id ?? reply?.referenceId;
    if (typeof reply?.inReplyTo?.content === "string") replyPreview = reply.inReplyTo.content.slice(0, 200);
  }
  if (body === null && sdk.isReply(message)) body = "This reply contains content Chat cannot display yet.";
  if (body === null) return null;

  rememberSender(message.id, message.senderInboxId);
  return {
    id: message.id,
    conversationId,
    sender: inboxToAddress(message.senderInboxId),
    body,
    sentAt: nsToMs(message.sentAtNs),
    reactions: aggregateReactions(sdk, message.reactions ?? [], inboxToAddress),
    replyTo, replyPreview,
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
  private readonly peerCacheScope: string;
  private peerByConversation: Map<string, string>;
  private peerInboxByConversation = new Map<string, string>();
  private senderInboxByMessage = new Map<string, string>();
  private reader: ChainReader | null = null;
  private stream: StreamHandle | null = null;
  private streamStopped = false;
  private streamRunning = false;
  private streamHealthy = false;
  private fullRefreshRequired = true;
  private fullRefreshCompletedAt: number | null = null;
  private dirtyConversations = new Set<string>();
  private mappedConversations = new Map<string, Conversation>();
  private conversationRefresh: Promise<Conversation[]> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastReceiptAt = new Map<string, number>();
  private changeCallback: (() => void) | null = null;
  private readonly myAddress: string;
  private readonly readState: ReadState;
  private messageCursors = new Map<string, { conversationId: string; at: bigint }>();
  private historyRequest: Promise<void> | null = null;
  private historyRequestedAt: number | null = null;
  private leaveRequests = new Set<string>();

  constructor(
    private org: OrgConfig,
    private identity: Identity,
    private provider: Eip1193Provider | null,
  ) {
    this.myAddress = identity.address.toLowerCase();
    this.peerCacheScope = `${xmtpEnv()}:${this.myAddress}`;
    // The legacy unscoped cache cannot establish which wallet a peer belongs to.
    this.peerByConversation = loadPeerCache(this.peerCacheScope);
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

  async requestHistorySync(): Promise<void> {
    const client = this.requireClient();
    if (!this.provider) throw new Error('Connect a wallet to request message history.');
    if (this.historyRequest) return this.historyRequest;
    const request = (async () => {
      const accounts = await this.provider!.request({ method: 'eth_accounts' });
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== this.myAddress
        || this.client !== client || this.status !== 'ready') throw new Error('Wallet changed. Request history for the current wallet.');
      // SDK 7 does not automatically request an archive on new installations.
      // The default archive includes messages and consent. Never claim it has arrived yet.
      await client.sendSyncRequest();
      if (this.client !== client || this.status !== 'ready') throw new Error('Wallet changed. Request history for the current wallet.');
      this.historyRequestedAt = Date.now();
    })();
    this.historyRequest = request;
    try { await request; } finally { if (this.historyRequest === request) this.historyRequest = null; }
  }

  private async adopt(client: XmtpClient) {
    this.client = client;
    this.status = "ready";
    await this.listConversations();
    if (this.changeCallback) {
      void this.runStream(this.changeCallback);
      this.startConsentStream(this.changeCallback);
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
      const sdk = await this.loadSdk();
      // Missing local identity state can throw after history recovery. Resolve the
      // explicitly requested inbox from network state instead of guessing by position.
      const states = await client.preferences.getInboxStates([peerInboxId]).catch(() => []);
      let address = inboxWallets(states, [peerInboxId], sdk.IdentifierKind.Ethereum).get(peerInboxId);
      if (!address) address = (await this.roomAddresses([peerInboxId])).get(peerInboxId);
      if (this.client !== client || this.status !== 'ready') return undefined;
      if (address) {
        this.peerByConversation.set(id, address);
        savePeerCache(this.peerCacheScope, this.peerByConversation);
      }
      return address;
    } catch {
      return undefined;
    }
  }

  private addressForInbox(conversationId: string, inboxId: string, roomAddresses?: ReadonlyMap<string, string>) {
    const client = this.client;
    if (client && inboxId === client.inboxId) return this.myAddress;
    if (roomAddresses) return roomAddresses.get(inboxId) ?? inboxId;
    if (this.peerInboxByConversation.get(conversationId) === inboxId) {
      return this.peerByConversation.get(conversationId) ?? inboxId;
    }
    return this.peerByConversation.get(conversationId) ?? inboxId;
  }

  private isRoomConversation(sdk: Sdk, conversation: XmtpConversation) {
    return classifyConversation(conversation, sdk.ConversationType.Group) === "room";
  }

  private async roomAddresses(inboxIds: string[]) {
    const client = this.requireClient(); const sdk = await this.loadSdk();
    let resolver = roomIdentityResolvers.get(client);
    if (!resolver) {
      resolver = new InboxIdentities(ids => client.preferences.fetchInboxStates(ids), sdk.IdentifierKind.Ethereum);
      roomIdentityResolvers.set(client, resolver);
    }
    const addresses = await resolver.resolve(inboxIds.filter(id => id !== client.inboxId));
    if (this.client !== client || this.status !== 'ready') throw new Error("Wallet changed. Reload the conversation.");
    if (client.inboxId) addresses.set(client.inboxId, this.myAddress);
    return addresses;
  }

  private async addressesForMembers(conversation: XmtpConversation) {
    const members = await conversation.members();
    const inboxIds = [...new Set(members.map(member => member.inboxId).filter(Boolean))];
    const addresses = await this.roomAddresses(inboxIds);
    return [...new Set(inboxIds.map(id => addresses.get(id) ?? id))];
  }

  private async isCurrentUserAdmin(conversation: XmtpConversation) {
    const myInboxId = this.requireInboxId();
    const group = conversation as XmtpConversation & { isAdmin?: (inboxId: string) => Promise<boolean>; isSuperAdmin?: (inboxId: string) => Promise<boolean> };
    return (await group.isSuperAdmin?.(myInboxId).catch(() => false) ?? false) ||
      (await group.isAdmin?.(myInboxId).catch(() => false) ?? false);
  }

  private async roomLeaveState(conversation: XmtpConversation, deviceAccess: Conversation['deviceAccess']): Promise<NonNullable<Conversation['leaveState']>> {
    try {
      if (!('isPendingRemoval' in conversation)) return 'unavailable';
      const members = await conversation.members();
      const self = this.requireInboxId();
      if (!members.some(member => member.inboxId === self)) return deviceAccess === 'inactive' ? 'removed' : 'unavailable';
      if (deviceAccess !== 'active') return 'unavailable';
      const pending = await conversation.isPendingRemoval();
      if (pending === true) return 'pending';
      if (pending !== false) return 'unavailable';
      const owner = await conversation.isSuperAdmin(self);
      if (owner === true) return 'owner';
      if (owner !== false) return 'unavailable';
      return members.length > 1 ? 'available' : 'alone';
    } catch { return 'unavailable'; }
  }

  private async assertGateAllows(meta: RoomMeta) {
    if (meta.invalid) throw new Error(INVALID_ROOM_METADATA);
    if ((meta.gate.rules?.length ?? 0) === 0) return;
    if (this.org.chain.chainId !== 1 || !validateProductionGate(meta.gate)) throw new Error("This room uses an unsupported production gate.");
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
    const current = this.conversationSession();
    const sdk = await this.loadSdk();
    const initialConsent = await conversation.consentState();
    current();
    this.conversations.set(conversation.id, conversation);

    const group = conversation as XmtpConversation & { name?: string; description?: string };
    const meta = parseRoomMeta(group.description, this.org.policy);
    this.roomMeta.set(conversation.id, meta);

    const peers = initialConsent === sdk.ConsentState.Denied ? [] : await this.addressesForMembers(conversation).catch(() => []);
    let lastMessage: ChatMessage | undefined;
    try {
      if (initialConsent === sdk.ConsentState.Denied) throw new Error("Blocked conversation");
      const [last] = await conversation.messages({ contentTypes: [sdk.ContentType.Text, sdk.ContentType.Reply], direction: sdk.SortDirection.Descending, limit: 1n });
      if (last) {
        const addresses = await this.roomAddresses(messageInboxIds([last]));
        lastMessage = toChatMessage(
          sdk,
          last,
          conversation.id,
          (inboxId) => this.addressForInbox(conversation.id, inboxId, addresses),
          (messageId, senderInboxId) => this.senderInboxByMessage.set(messageId, senderInboxId),
        ) ?? undefined;
      }
    } catch {
      lastMessage = undefined;
    }

    const deviceAccess = await this.groupDeviceAccess(conversation);
    const leaveState = initialConsent === sdk.ConsentState.Denied ? undefined : await this.roomLeaveState(conversation, deviceAccess);
    const isAdmin = await this.isCurrentUserAdmin(conversation).catch(() => false);
    const unread = initialConsent === sdk.ConsentState.Denied ? 0 : await this.unreadCount(conversation);
    const consent = await conversation.consentState();
    current();
    const blocked = consent === sdk.ConsentState.Denied;
    const pending = !blocked && consent !== sdk.ConsentState.Allowed;
    return {
      id: conversation.id,
      kind: "room",
      title: group.name || "Room",
      description: meta.description,
      peers: blocked ? [] : peers,
      consentSupported: true,
      deviceAccess,
      leaveState,
      pending,
      blocked,
      namespace: meta.namespace,
      gate: meta.gate,
      policy: meta.policy,
      isAdmin,
      canAddMembers: deviceAccess === "active" && leaveState !== 'pending' && !pending && !blocked && isAdmin && !meta.invalid && !hasGate(meta.gate) && meta.namespace === this.org.namespace,
      configurationError: meta.invalid === true,
      lastMessage: blocked ? undefined : lastMessage,
      unread: blocked ? 0 : unread,
    };
  }

  private catalogCache: { at: number; rooms: Conversation[] } | null = null;

  private async publishedRooms(refresh = false): Promise<Conversation[]> {
    if (!this.org.gateUrl) return [];
    if (!refresh && this.catalogCache && Date.now() - this.catalogCache.at < 60_000) return this.catalogCache.rooms;
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

  private async peerReceiptTime(conversation: XmtpConversation): Promise<number | undefined> {
    try {
      const sdk = await this.loadSdk();
      if (this.isRoomConversation(sdk, conversation) || await conversation.consentState() !== sdk.ConsentState.Allowed) return;
      const client = this.requireClient();
      const peerInbox = await (conversation as XmtpConversation & { peerInboxId: () => Promise<string> }).peerInboxId();
      if (!client.inboxId || !peerInbox || peerInbox === client.inboxId) return;
      // Enriched message queries omit receipts. The SDK indexes them by inbox.
      const times = await conversation.lastReadTimes();
      const timestamp = times.get(peerInbox);
      if (typeof timestamp !== "bigint") return;
      const at = nsToMs(timestamp);
      if (!Number.isSafeInteger(at) || at <= 0 || at > Date.now() + 60_000) return;
      return at;
    } catch { return undefined; } // Missing receipt evidence must never imply a read.
  }

  private async mapConversation(conversation: XmtpConversation): Promise<Conversation> {
    const sdk = await this.loadSdk();
    if (this.isRoomConversation(sdk, conversation)) return this.mapRoomConversation(conversation);

    this.conversations.set(conversation.id, conversation);
    const peer = await this.resolvePeer(conversation);
    let lastMessage: ChatMessage | undefined;

    try {
      const sdk = await this.loadSdk();
      const [last] = await conversation.messages({ contentTypes: [sdk.ContentType.Text, sdk.ContentType.Reply], direction: sdk.SortDirection.Descending, limit: 1n });
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
      // An unresolved peer is not evidence of a self-conversation.
      peers: peer ? [this.myAddress, peer] : [],
      lastMessage: blocked ? undefined : lastMessage,
      lastReadReceiptAt: pending || blocked ? undefined : await this.peerReceiptTime(conversation),
      unread: blocked ? 0 : await this.unreadCount(conversation),
      pending,
      blocked,
    };
  }

  private invalidateConversation(id: string) {
    this.dirtyConversations.add(id);
    this.changeCallback?.();
  }

  listConversations(): Promise<Conversation[]> {
    if (!this.conversationRefresh) {
      const refresh = (async () => {
        // A consent change can complete while a directory request holds an older
        // inbox snapshot. Drain the invalidation before publishing that snapshot.
        for (;;) {
          const revision = this.consentRevision;
          const result = await this.refreshConversations();
          if (revision === this.consentRevision) return result;
        }
      })();
      this.conversationRefresh = refresh;
      void refresh.finally(() => {
        if (this.conversationRefresh === refresh) this.conversationRefresh = null;
      }).catch(() => {});
    }
    return this.conversationRefresh;
  }

  private async refreshConversations(): Promise<Conversation[]> {
    const client = this.client;
    if (!client || this.status !== "ready") return [];
    const full = this.fullRefreshRequired || !this.streamHealthy;
    this.fullRefreshRequired = false;
    const dirty = this.dirtyConversations;
    this.dirtyConversations = new Set();
    try {
      if (full) {
        await client.conversations.sync();
        await client.conversations.syncAll();
      }
      // Streams persist updates in the SDK. Read fresh wrappers for a bounded
      // set of changed IDs rather than serializing the complete local inbox.
      // Fresh wrappers matter: group metadata on a cached wrapper can be stale.
      // Unknown IDs must use list() to preserve SDK inbox/duplicate-DM filtering.
      let changed: XmtpConversation[] | undefined;
      if (!full && dirty.size > 0 && dirty.size <= 100 && [...dirty].every(id => this.conversations.has(id))) {
        const found = await mapConversations([...dirty], async id => {
          const conversation = await client.conversations.getConversationById(id);
          if (conversation && conversation.id !== id) throw new Error("Conversation lookup returned a different conversation.");
          return conversation;
        });
        if (found.every((conversation): conversation is XmtpConversation => Boolean(conversation))) {
          changed = found;
          for (const conversation of changed) this.conversations.set(conversation.id, conversation);
        }
        // A missing lookup is not proof of deletion. Reconcile the local list.
      }
      if (!changed) {
        const sdk = await this.loadSdk();
        const list = await client.conversations.list({ consentStates: [sdk.ConsentState.Unknown, sdk.ConsentState.Allowed, sdk.ConsentState.Denied] });
        this.conversations = new Map(list.map((conversation) => [conversation.id, conversation]));
        changed = full ? list : list.filter(conversation => dirty.has(conversation.id) || !this.mappedConversations.has(conversation.id));
      }
      // Keep known restrictions available while asynchronous mapping is in flight.
      const updates = await mapConversations(changed, (conversation) => this.mapConversation(conversation));
      const next = full ? new Map<string, Conversation>() : new Map(this.mappedConversations);
      for (const conversation of updates) next.set(conversation.id, conversation);
      for (const id of next.keys()) if (!this.conversations.has(id)) next.delete(id);
      this.mappedConversations = next;
      const scoped = [...next.values()].filter((c) => c.kind === "dm" || c.namespace === this.org.namespace ||
        (!c.namespace && this.org.namespace === "personal"));
      let directory: Conversation[] = [];
      try { directory = await this.publishedRooms(); this.warning = undefined; }
      catch { this.fullRefreshRequired = true; this.warning = "Published rooms are unavailable. Existing chats still work; room joins may need to be retried."; directory = this.catalogCache?.rooms ?? []; }
      for (const room of directory) {
        let existing = scoped.find((c) => c.id === room.id);
        if (!existing) {
          const received = next.get(room.id);
          // A directory may supply the namespace, but cannot erase local consent.
          existing = received ? { ...room, ...received, namespace: room.namespace, gate: room.gate } : { ...room };
          scoped.push(existing);
        } else existing.gate = room.gate;
        existing.canAddMembers = false;
        // The directory supplies admission rules, not the joined group's current
        // posting policy. Preserve a pause and other group policy overrides.
        this.roomMeta.set(room.id, { ...this.roomMeta.get(room.id), namespace: room.namespace,
          gate: room.gate!, policy: existing?.policy ?? room.policy! });
      }
      const directoryIds = new Set(directory.map(room => room.id));
      for (const id of this.roomMeta.keys()) {
        if (!this.conversations.has(id) && !directoryIds.has(id)) this.roomMeta.delete(id);
      }
      if (full) this.fullRefreshCompletedAt = Date.now();
      return scoped.sort((a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0));
    } catch (error) {
      this.fullRefreshRequired = true;
      for (const id of dirty) this.dirtyConversations.add(id);
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
    return (await this.listMessagePage(conversationId)).messages;
  }

  async listMessagePage(conversationId: string, before?: string) {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || this.status !== "ready") return { messages: [], olderCursor: undefined };
    const current = this.conversationSession();
    try {
      const sdk = await this.loadSdk();
      if (await conversation.consentState() === sdk.ConsentState.Denied) return { messages: [], olderCursor: undefined };
      current();
      const room = this.isRoomConversation(sdk, conversation);
      // Imported local history can be valid even before this installation is
      // active. Unblocking does not itself restore MLS access.
      if (!room || await this.groupDeviceAccess(conversation) === 'active') {
        try { await conversation.sync(); }
        catch (error) {
          if (!room || await this.groupDeviceAccess(conversation) !== 'inactive') throw error;
        }
      }
      if (await conversation.consentState() === sdk.ConsentState.Denied) return { messages: [], olderCursor: undefined };
      current();
      const page = await readMessagePage((query) => conversation.messages({
        ...query, direction: sdk.SortDirection.Descending,
        contentTypes: [sdk.ContentType.Text, sdk.ContentType.Reply],
      }), before);
      const raw = page.messages;
      const addresses = this.isRoomConversation(sdk, conversation) ? await this.roomAddresses(messageInboxIds(raw)) : undefined;
      const consent = await conversation.consentState();
      current();
      if (consent === sdk.ConsentState.Denied) return { messages: [], olderCursor: undefined };
      for (const message of raw) { this.messageCursors.delete(message.id); this.senderInboxByMessage.delete(message.id); }
      for (const message of raw) {
        if (sdk.isText(message) || sdk.isReply(message)) this.messageCursors.set(message.id, { conversationId, at: message.sentAtNs });
      }
      const messages = raw
        .map((message) => toChatMessage(
          sdk,
          message,
          conversationId,
          (inboxId) => this.addressForInbox(conversationId, inboxId, addresses),
          (messageId, senderInboxId) => this.senderInboxByMessage.set(messageId, senderInboxId),
        ))
        .filter((message): message is ChatMessage => Boolean(message))
        .sort((a, b) => {
          const left = this.messageCursors.get(a.id)?.at ?? 0n;
          const right = this.messageCursors.get(b.id)?.at ?? 0n;
          return left < right ? -1 : left > right ? 1 : a.id.localeCompare(b.id);
        });
      // Bound metadata retained for replies, reactions and local read cursors.
      for (const cache of [this.messageCursors, this.senderInboxByMessage]) {
        while (cache.size > 2500) cache.delete(cache.keys().next().value!);
      }
      return { messages, olderCursor: page.olderCursor };
    } catch (error) {
      throw new Error(humanError(error));
    }
  }

  async send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const current = this.conversationSession();
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
      const content = await sdk.encodeText(text);
      await this.assertConversationAccepted(conversation); current();
      messageId = await conversation.sendReply({
        content,
        reference: opts.replyTo,
        referenceInboxId,
      });
    } else {
      await this.assertConversationAccepted(conversation); current();
      messageId = await conversation.sendText(text);
    }

    this.invalidateConversation(conversationId);
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
    const currentSession = this.conversationSession();
    await this.assertConversationAccepted(conversation);
    const room = this.roomMeta.get(conversationId);
    if (room) {
      await this.assertGateAllows(room);
      const decision = evaluatePolicy(room.policy, { type: "send" }, { isAdmin: await this.isCurrentUserAdmin(conversation) });
      if (!decision.allowed) throw new Error(decision.reason || "Blocked by room policy.");
    }
    const referenceInboxId = this.senderInboxByMessage.get(messageId);
    if (!referenceInboxId) throw new Error("Reaction target is not loaded yet.");

    const sdk = await this.loadSdk();
    const current = await this.client?.conversations.getMessageById(messageId);
    if (!current || current.conversationId !== conversationId) throw new Error("Reaction target is no longer available.");
    const reactions = aggregateReactions(sdk, current.reactions ?? [], (inbox) => this.addressForInbox(conversationId, inbox));
    const had = reactions?.[emoji]?.some((address) => address.toLowerCase() === this.myAddress) ?? false;
    await this.assertConversationAccepted(conversation); currentSession();
    await conversation.sendReaction({
      reference: messageId,
      referenceInboxId,
      action: had ? sdk.ReactionAction.Removed : sdk.ReactionAction.Added,
      content: emoji,
      schema: sdk.ReactionSchema.Unicode,
    });
    this.invalidateConversation(conversationId);
  }

  async markRead(conversationId: string, options?: { sendReceipt: boolean; throughMessageId?: string }): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    const cursor = options?.throughMessageId ? this.messageCursors.get(options.throughMessageId) : undefined;
    if (!conversation || !cursor || cursor.conversationId !== conversationId) return;
    const current = this.conversationSession();
    const sdk = await this.loadSdk();
    const room = this.isRoomConversation(sdk, conversation);
    if (await conversation.consentState() !== sdk.ConsentState.Allowed || this.consentUpdates.has(conversationId)) return;
    current();
    if (!this.readState.advance(conversationId, cursor.at)) return;
    this.invalidateConversation(conversationId);
    if (room || options?.sendReceipt !== true) return;
    const now = Date.now();
    if (now - (this.lastReceiptAt.get(conversationId) ?? 0) < 3000) return;
    try { await conversation.sendReadReceipt(); this.lastReceiptAt.set(conversationId, now); } catch { /* Local read state is independent of best-effort receipts. */ }
  }

  private async groupDeviceAccess(conversation: XmtpConversation): Promise<NonNullable<Conversation['deviceAccess']>> {
    try { return await conversation.isActive() ? 'active' : 'inactive'; }
    catch { return 'unavailable'; }
  }

  private async assertConversationAccepted(conversation: XmtpConversation): Promise<void> {
    const sdk = await this.loadSdk();
    if (await conversation.consentState() !== sdk.ConsentState.Allowed || this.consentUpdates.has(conversation.id)) {
      throw new Error("Accept or unblock this conversation before sending messages or reactions.");
    }
    if (this.isRoomConversation(sdk, conversation) && await this.groupDeviceAccess(conversation) !== 'active') {
      throw new Error("Active access from this device is required. You can still read restored messages.");
    }
    if (this.isRoomConversation(sdk, conversation) && (this.leaveRequests.has(conversation.id) ||
      !('isPendingRemoval' in conversation) || await conversation.isPendingRemoval() !== false)) {
      throw new Error("Room removal is pending or could not be checked. Sending and room changes are unavailable.");
    }
  }

  async requestRoomLeave(conversationId: string, isCurrent: () => boolean = () => true): Promise<void> {
    const client = this.requireClient();
    const known = this.conversations.get(conversationId);
    const sdk = await this.loadSdk();
    const session = this.conversationSession();
    const check = () => { session(); if (!isCurrent() || this.client !== client) throw new Error('Wallet or room changed. Check members before retrying.'); };
    check();
    if (!known || !this.isRoomConversation(sdk, known) || !('requestRemoval' in known)) throw new Error('Native room leaving is unavailable.');
    if (this.leaveRequests.has(conversationId)) throw new Error('A leave request is already in progress.');
    this.leaveRequests.add(conversationId);
    const checkWallet = async () => {
      if (!this.provider) throw new Error('Connect a wallet to request room removal.');
      const accounts = await this.provider.request({ method: 'eth_accounts' });
      check();
      if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== this.myAddress) throw new Error('Wallet or room changed. Check members before retrying.');
    };
    try {
      await checkWallet();
      const access = await this.groupDeviceAccess(known); check();
      if (access !== 'active') throw new Error('Active access from this device is required. You can still read restored messages.');
      await known.sync(); check();
      const group = await client.conversations.getConversationById(conversationId); check();
      if (!group || group.id !== conversationId || !this.isRoomConversation(sdk, group) || !('requestRemoval' in group)) throw new Error('Native room leaving is unavailable.');
      const meta = parseRoomMeta(group.description, this.org.policy);
      if (meta.namespace !== this.org.namespace) throw new Error('Room not found in this organization.');
      const state = await this.roomLeaveState(group, await this.groupDeviceAccess(group)); check();
      if (state === 'pending') return;
      if (state === 'owner') throw new Error('An owner must appoint another owner and step down before leaving.');
      if (state === 'alone') throw new Error('The last member cannot leave this room.');
      if (state !== 'available') throw new Error('Active room membership could not be confirmed.');
      await checkWallet();
      // The SDK broadcasts a leave request as a message. Never implicitly accept
      // a blocked/incoming room, and preserve SDK authority as the final guard.
      if (await group.consentState() !== sdk.ConsentState.Allowed || this.consentUpdates.has(conversationId)) throw new Error('Accept or unblock this conversation before sending messages or reactions.');
      check();
      await group.requestRemoval();
      this.consentRevision++; // Drain any inbox snapshot taken before the leave request.
      check();
    } finally { this.leaveRequests.delete(conversationId); this.invalidateConversation(conversationId); }
  }

  private consentUpdates = new Set<string>();

  private conversationSession() {
    const client = this.client;
    return () => {
      if (this.client !== client || this.status !== "ready") throw new Error("Wallet changed. Reload the conversation.");
    };
  }

  async setConversationConsent(conversationId: string, state: "allowed" | "denied", isCurrent: () => boolean = () => true): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation) throw new Error("Conversation not found.");
    const current = this.conversationSession();
    const check = () => { current(); if (!isCurrent()) throw new Error("Wallet changed. Reload the conversation."); };
    check();
    if (this.consentUpdates.has(conversationId)) throw new Error("Consent update already in progress.");
    this.consentUpdates.add(conversationId);
    try {
      const sdk = await this.loadSdk();
      if (this.provider) {
        const accounts = await this.provider.request({ method: "eth_accounts" });
        if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== this.myAddress) throw new Error("Wallet changed. Reload the conversation.");
      }
      check();
      await conversation.updateConsentState(state === "allowed" ? sdk.ConsentState.Allowed : sdk.ConsentState.Denied);
      this.consentRevision++;
      check();
    } finally {
      this.consentUpdates.delete(conversationId);
      this.invalidateConversation(conversationId);
    }
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
    savePeerCache(this.peerCacheScope, this.peerByConversation);
    const mapped = await this.mapConversation(conversation);
    this.invalidateConversation(conversation.id);
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
    if (typeof input.description === "string" && input.description.length > MAX_ROOM_DESCRIPTION_LENGTH) {
      throw new Error("Room descriptions must be 10,000 characters or fewer.");
    }
    const encodedMeta = roomMetaDescription(meta);
    if (parseRoomMeta(encodedMeta, this.org.policy).invalid) throw new Error(INVALID_ROOM_METADATA);
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
      group.updateDescription(encodedMeta),
      group.addSuperAdmin(this.requireInboxId()).catch(() => undefined),
    ];
    if (gatekeeperInboxId) updates.push(group.addSuperAdmin(gatekeeperInboxId));
    await Promise.all(updates);
    this.conversations.set(group.id, group);
    this.roomMeta.set(group.id, meta);

    // Creating a room is explicit acceptance, unlike merely discovering an invitation.
    if (await group.consentState() === sdk.ConsentState.Unknown) await group.updateConsentState(sdk.ConsentState.Allowed);
    await this.assertConversationAccepted(group);
    if (this.client !== client || this.status !== 'ready') throw new Error("Wallet changed. Reload the conversation.");
    const seedId = await group.sendText(`#${input.title} created.`);
    const mapped = await this.mapRoomConversation(group);
    this.invalidateConversation(group.id);
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

  private memberAdditions = new Set<string>();

  async addRoomMember(conversationId: string, address: string, isCurrent: () => boolean = () => true): Promise<void> {
    const client = this.requireClient();
    const target = normalizeAddress(address);
    if (target === this.myAddress) throw new Error("You are already a member of this room.");
    if (!this.provider) throw new Error("Connect a wallet to add a room member.");
    if (this.memberAdditions.has(conversationId)) throw new Error("A member addition is already in progress.");
    const assertCurrent = () => {
      if (!isCurrent() || this.client !== client || this.status !== 'ready') throw new Error("Wallet or room changed. Check members before retrying.");
    };
    const checkWallet = async () => {
      assertCurrent();
      const accounts = await this.provider!.request({ method: 'eth_accounts' });
      assertCurrent();
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== this.myAddress) {
        throw new Error("Wallet or room changed. Check members before retrying.");
      }
    };
    this.memberAdditions.add(conversationId);
    try {
      await checkWallet();
      const sdk = await this.loadSdk();
      const readOpenRoom = async () => {
        // SDK metadata properties on cached wrappers can be stale.
        const cached = await client.conversations.getConversationById(conversationId);
        if (!cached || cached.id !== conversationId || !this.isRoomConversation(sdk, cached)) throw new Error("Room not found in this organization.");
        await cached.sync();
        assertCurrent();
        const group = await client.conversations.getConversationById(conversationId);
        if (!group || group.id !== conversationId || !this.isRoomConversation(sdk, group) || !('addMembers' in group)) throw new Error("Room not found in this organization.");
        const meta = parseRoomMeta(group.description, this.org.policy);
        if (meta.invalid) throw new Error(INVALID_ROOM_METADATA);
        if (meta.namespace !== this.org.namespace) throw new Error("Room not found in this organization.");
        if (hasGate(meta.gate)) throw new Error("Gated rooms require admission through the gate service.");
        if (!await this.isCurrentUserAdmin(group)) throw new Error("Admins only.");
        assertCurrent();
        return group;
      };
      await readOpenRoom();
      const inboxId = await client.fetchInboxIdByIdentifier(await this.identifier(target));
      assertCurrent();
      if (!inboxId) throw new Error("That address hasn't activated XMTP messaging yet.");
      // A published directory can impose a gate independently of the SDK description.
      // Refresh configured directories and fail closed if they cannot be read.
      const published = await this.publishedRooms(true);
      if (published.some(room => room.id === conversationId) || hasGate(this.roomMeta.get(conversationId)?.gate ?? OPEN_GATE)) {
        throw new Error("Gated rooms require admission through the gate service.");
      }
      // Recipient lookup may be slow; recheck current metadata and role afterward.
      const group = await readOpenRoom();
      const members = await group.members();
      if (inboxId === client.inboxId || members.some(member => member.inboxId === inboxId)) throw new Error("That wallet is already a room member.");
      // Membership and SDK permission checks fail closed; never reuse a cached UI role.
      if (!members.some(member => member.inboxId === client.inboxId) || !await this.isCurrentUserAdmin(group)) throw new Error("Admins only.");
      await checkWallet();
      await this.assertConversationAccepted(group); assertCurrent();
      await group.addMembers([inboxId]);
      this.invalidateConversation(conversationId);
      assertCurrent();
    } finally { this.memberAdditions.delete(conversationId); }
  }

  async requestRoomJoin(conversationId: string): Promise<void> {
    const meta = this.roomMeta.get(conversationId);
    if (!meta || meta.namespace !== this.org.namespace) throw new Error("Room not found in this organization.");
    if (meta.invalid) throw new Error(INVALID_ROOM_METADATA);
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
    this.fullRefreshRequired = true;
    this.changeCallback?.();
  }

  async setRoomPolicy(conversationId: string, policy: Policy): Promise<void> {
    const conversation = this.conversations.get(conversationId);
    if (!conversation || !this.roomMeta.has(conversationId)) return;
    const currentSession = this.conversationSession();
    if (this.roomMeta.get(conversationId)?.invalid) throw new Error(INVALID_ROOM_METADATA);
    if (!await this.isCurrentUserAdmin(conversation)) throw new Error("Admins only.");

    const current = this.roomMeta.get(conversationId) ?? {
      gate: OPEN_GATE,
      policy: mergePolicy(this.org.policy, policy),
    };
    const next: RoomMeta = { ...current, policy };
    const group = conversation as XmtpConversation & { updateDescription?: (description: string) => Promise<void> };
    if (!group.updateDescription) throw new Error("Room policy updates are unavailable.");
    const encodedMeta = roomMetaDescription(next);
    if (parseRoomMeta(encodedMeta, this.org.policy).invalid) throw new Error(INVALID_ROOM_METADATA);
    await this.assertConversationAccepted(conversation); currentSession();
    await group.updateDescription(encodedMeta);
    this.roomMeta.set(conversationId, next);
    this.invalidateConversation(conversationId);
  }

  subscribe(cb: () => void): () => void {
    this.changeCallback = cb;
    this.streamStopped = false;
    void this.runStream(cb);
    this.startConsentStream(cb);
    this.startPoll(cb);
    return () => {
      if (this.changeCallback === cb) this.changeCallback = null;
      this.streamStopped = true;
      this.consentStreamHealthy = false;
      const consentTask = this.consentTask;
      this.consentTask = null;
      if (consentTask) { consentTask.stopped = true; void consentTask.stream?.return?.().catch(() => {}); }
      this.streamHealthy = false;
      this.fullRefreshRequired = true;
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
      this.fullRefreshRequired = true;
      if (!this.streamRunning) void this.runStream(cb);
      this.startConsentStream(cb);
      cb(); // The subscriber owns refresh; polling must not duplicate it.
    };
    this.pollTimer = setInterval(() => {
      const now = Date.now();
      // Archive transfer needs a request, another installation's response, and
      // an import. Do not make each stage wait a full minute after an explicit
      // request. This bounded recovery window never resends the request itself.
      const recoveringHistory = this.historyRequestedAt !== null && now >= this.historyRequestedAt && now - this.historyRequestedAt < 120_000;
      // Healthy streams deliver immediate changes. Reconcile periodically for
      // silently missed updates, including device history requests while this
      // installation is in a background tab. Errors and explicit invalidation retain
      // the ten-second fallback. Clock rollback must not defer recovery.
      if (!recoveringHistory && this.streamHealthy && this.consentStreamHealthy && !this.fullRefreshRequired && this.fullRefreshCompletedAt !== null &&
          now >= this.fullRefreshCompletedAt && now - this.fullRefreshCompletedAt < 60_000) return;
      sync();
    }, 10_000);
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

  private consentRevision = 0;
  private consentStreamHealthy = true;
  private consentTask: { client: XmtpClient; stopped: boolean; stream?: Awaited<ReturnType<XmtpClient["preferences"]["streamConsent"]>> } | null = null;

  private startConsentStream(cb: () => void) {
    if (!this.client || this.streamStopped || this.status !== "ready") return;
    const previous = this.consentTask;
    if (previous?.client === this.client && !previous.stopped) return;
    if (previous) { previous.stopped = true; void previous.stream?.return?.().catch(() => {}); }
    const task: NonNullable<XmtpTransport["consentTask"]> = { client: this.client, stopped: false };
    this.consentTask = task;
    this.consentStreamHealthy = false;
    const current = () => this.consentTask === task && this.changeCallback === cb && !task.stopped && !this.streamStopped && this.client === task.client && this.status === "ready";
    const changed = () => {
      if (!current()) return;
      this.consentRevision++;
      this.fullRefreshRequired = true;
      cb();
    };
    const recover = () => { if (current()) { this.consentStreamHealthy = false; changed(); } };
    void (async () => {
      while (current()) {
        try {
          const stream = await task.client.preferences.streamConsent({
            onError: recover, onFail: recover, onRetry: recover, onEnd: recover,
            onRestart: () => { if (current()) { this.consentStreamHealthy = true; changed(); } },
          });
          if (!current()) { await stream.return?.(); break; }
          task.stream = stream;
          this.consentStreamHealthy = true;
          // Consume the iterator rather than leaving an unbounded callback queue.
          for await (const _updates of stream) {
            if (!current()) break;
            this.consentStreamHealthy = true;
            changed();
          }
        } catch { /* Network/SDK failures retain full reconciliation as fallback. */ }
        if (!current()) break;
        recover();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    })().finally(() => {
      if (this.consentTask === task) { this.consentTask = null; this.consentStreamHealthy = false; }
    });
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
          const recover = () => {
            this.streamHealthy = false;
            this.fullRefreshRequired = true;
            if (!this.streamStopped) cb();
          };
          this.stream = await client.conversations.streamAllMessages({
            onError: recover, onFail: recover, onRetry: recover, onEnd: recover,
            onRestart: () => { recover(); this.streamHealthy = !this.streamStopped; },
          }) as StreamHandle;
          this.streamHealthy = true;
          for await (const message of this.stream) {
            if (this.streamStopped) break;
            this.streamHealthy = true;
            if (message.conversationId) this.dirtyConversations.add(message.conversationId);
            else this.fullRefreshRequired = true;
            cb();
          }
        } catch {
          /* reconnect below */
        }
        this.streamHealthy = false;
        this.fullRefreshRequired = true;
        if (this.streamStopped) break;
        cb();
        await new Promise((resolve) => setTimeout(resolve, 2000));
      }
    } finally {
      this.streamHealthy = false;
      this.streamRunning = false;
    }
  }
}
