import { mergePolicy, evaluatePolicy, type Identity, type OrgConfig, type Policy } from "@app/core";
import type { ChatMessage, Conversation, StartRoomInput, Transport } from "./types";

// A fully local, offline transport. It persists so the app is immediately viewable
// and clickable with no wallet, no network, no keys. It implements the exact same
// Transport interface the real XMTP transport will, so swapping it in later does
// not touch any UI code.
//
// Persistence model (matches the production intent):
//   • DMs + Saved Messages  → keyed by WALLET only, so your chats persist across
//     ALL orgs and personally (one identity = one DM history).
//   • Rooms                 → keyed by wallet + org namespace, since gated rooms
//     belong to the org that defines them.

const store = {
  get(key: string): string | null {
    try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; }
  },
  set(key: string, val: string) {
    try { globalThis.localStorage?.setItem(key, val); } catch { /* ignore */ }
  },
};

const uid = (p: string): string => {
  try { if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${p}_${crypto.randomUUID()}`; } catch { /* */ }
  return `${p}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
};

const randAddr = (): string => {
  const hex = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < 40; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
};

interface Slice { conversations: Conversation[]; messages: Record<string, ChatMessage[]>; }
interface Snapshot { conversations: Conversation[]; messages: Record<string, ChatMessage[]>; }

const DEMO_BOTS = [
  { handle: "ada.eth", address: randAddr() },
  { handle: "satoshi.eth", address: randAddr() },
  { handle: "lovelace.eth", address: randAddr() },
];

export class MockTransport implements Transport {
  readonly id = "mock" as const;
  private dmKey: string;     // wallet-global DM store
  private roomKey: string;   // per-org room store
  private identity: Identity;
  private snap: Snapshot = { conversations: [], messages: {} };
  private listeners = new Set<() => void>();

  constructor(private org: OrgConfig, identity: Identity) {
    this.identity = identity;
    this.dmKey = `chat:mock:dms:${identity.address}`;
    this.roomKey = `chat:mock:rooms:${identity.address}:${org.namespace}`;
  }

  me(): Identity { return this.identity; }
  async enable(): Promise<void> {}

  private loadSlice(key: string): Slice | null {
    const raw = store.get(key);
    if (!raw) return null;
    try { return JSON.parse(raw) as Slice; } catch { return null; }
  }

  async init(): Promise<void> {
    this.snap = { conversations: [], messages: {} };

    // --- DMs (wallet-global) ---
    const dms = this.loadSlice(this.dmKey);
    if (dms) {
      this.snap.conversations.push(...dms.conversations);
      Object.assign(this.snap.messages, dms.messages);
    } else {
      this.seedDms();
    }

    // --- Rooms (per-org) ---
    const rooms = this.loadSlice(this.roomKey);
    if (rooms) {
      this.snap.conversations.push(...rooms.conversations);
      Object.assign(this.snap.messages, rooms.messages);
    }
    this.ensureOrgRooms();

    this.persist();
  }

  private seedDms() {
    const now = Date.now();
    // Saved messages self-DM.
    const savedId = uid("dm");
    this.snap.conversations.push({ id: savedId, kind: "dm", title: "Saved Messages", peers: [this.identity.address], unread: 0 });
    this.snap.messages[savedId] = [{ id: uid("m"), conversationId: savedId, sender: this.identity.address, body: "Notes to self live here — visible in every org.", sentAt: now - 1000 * 60 * 60 }];

    // A couple of demo DMs so the list isn't empty.
    DEMO_BOTS.slice(0, 2).forEach((bot, i) => {
      const id = uid("dm");
      const msgs: ChatMessage[] = [
        { id: uid("m"), conversationId: id, sender: bot.address, body: i === 0 ? "gm — your DMs follow you across every org 👋" : "ping me anytime.", sentAt: now - 1000 * 60 * (30 - i * 10) },
      ];
      this.snap.conversations.push({ id, kind: "dm", title: bot.handle, peers: [this.identity.address, bot.address], unread: 1, lastMessage: msgs[0] });
      this.snap.messages[id] = msgs;
    });
  }

  /** Ensure this org's seed rooms exist; if an org defines none and the user has no
   *  rooms here yet, seed a single open "general" room. */
  private ensureOrgRooms() {
    const now = Date.now();
    const have = new Set(this.snap.conversations.filter((c) => c.kind === "room").map((c) => c.id));
    const seeds = this.org.defaultRooms.length
      ? this.org.defaultRooms
      : (this.snap.conversations.some((c) => c.kind === "room")
          ? []
          : [{ id: uid("room"), title: "general", description: "Open room", gate: { combine: "any" as const, rules: [] } }]);
    for (const r of seeds) {
      const id = r.id || uid("room");
      if (have.has(id)) continue;
      const seed: ChatMessage = { id: uid("m"), conversationId: id, sender: DEMO_BOTS[2].address, body: `#${r.title} created.`, sentAt: now - 1000 * 60 * 90 };
      this.snap.conversations.push({ id, kind: "room", title: r.title, description: r.description, peers: [this.identity.address, DEMO_BOTS[2].address], gate: r.gate, policy: mergePolicy(this.org.policy, r.policy), unread: 0, lastMessage: seed });
      this.snap.messages[id] = [seed];
    }
  }

  /** Split the snapshot back into its DM (global) and room (per-org) slices. */
  private persist() {
    const dm: Slice = { conversations: [], messages: {} };
    const room: Slice = { conversations: [], messages: {} };
    for (const c of this.snap.conversations) {
      const target = c.kind === "room" ? room : dm;
      target.conversations.push(c);
      target.messages[c.id] = this.snap.messages[c.id] || [];
    }
    store.set(this.dmKey, JSON.stringify(dm));
    store.set(this.roomKey, JSON.stringify(room));
  }

  private emit() { this.listeners.forEach((l) => l()); }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async listConversations(): Promise<Conversation[]> {
    return [...this.snap.conversations].sort(
      (a, b) => (b.lastMessage?.sentAt ?? 0) - (a.lastMessage?.sentAt ?? 0),
    );
  }

  async listMessages(conversationId: string): Promise<ChatMessage[]> {
    return [...(this.snap.messages[conversationId] || [])].sort((a, b) => a.sentAt - b.sentAt);
  }

  async send(conversationId: string, body: string, opts?: { replyTo?: string }): Promise<ChatMessage> {
    // Enforce the room's action policy (read-only freeze). DMs are unaffected.
    const target = this.snap.conversations.find((c) => c.id === conversationId);
    if (target?.kind === "room" && target.policy) {
      const decision = evaluatePolicy(target.policy, { type: "send" });
      if (!decision.allowed) throw new Error(decision.reason || "Blocked by room policy.");
    }
    const msg: ChatMessage = {
      id: uid("m"), conversationId, sender: this.identity.address,
      body: body.trim(), sentAt: Date.now(), replyTo: opts?.replyTo,
    };
    (this.snap.messages[conversationId] ||= []).push(msg);
    const conv = this.snap.conversations.find((c) => c.id === conversationId);
    if (conv) { conv.lastMessage = msg; conv.unread = 0; }
    this.persist(); this.emit();
    // Demo: a peer echoes back in DMs so the thread feels alive.
    const c = this.snap.conversations.find((x) => x.id === conversationId);
    if (c && c.kind === "dm" && c.peers.length === 2) {
      const peer = c.peers.find((p) => p !== this.identity.address);
      if (peer) setTimeout(() => this.autoReply(conversationId, peer), 700);
    }
    return msg;
  }

  private autoReply(conversationId: string, peer: string) {
    const replies = ["got it 👍", "interesting — say more?", "agreed.", "ha, nice.", "let's do it."];
    const msg: ChatMessage = {
      id: uid("m"), conversationId, sender: peer,
      body: replies[Math.floor(Math.random() * replies.length)], sentAt: Date.now(),
    };
    (this.snap.messages[conversationId] ||= []).push(msg);
    const conv = this.snap.conversations.find((x) => x.id === conversationId);
    if (conv) { conv.lastMessage = msg; conv.unread += 1; }
    this.persist(); this.emit();
  }

  async react(conversationId: string, messageId: string, emoji: string): Promise<void> {
    const msg = (this.snap.messages[conversationId] || []).find((m) => m.id === messageId);
    if (!msg) return;
    msg.reactions ||= {};
    const who = msg.reactions[emoji] ||= [];
    const me = this.identity.address;
    msg.reactions[emoji] = who.includes(me) ? who.filter((a) => a !== me) : [...who, me];
    if (msg.reactions[emoji].length === 0) delete msg.reactions[emoji];
    this.persist(); this.emit();
  }

  async markRead(conversationId: string): Promise<void> {
    const conv = this.snap.conversations.find((c) => c.id === conversationId);
    if (conv && conv.unread !== 0) { conv.unread = 0; this.persist(); this.emit(); }
  }

  async startDm(address: string, handle?: string): Promise<Conversation> {
    const existing = this.snap.conversations.find(
      (c) => c.kind === "dm" && c.peers.includes(address),
    );
    if (existing) return existing;
    const conv: Conversation = {
      id: uid("dm"), kind: "dm", title: handle || address,
      peers: [this.identity.address, address], unread: 0,
    };
    this.snap.conversations.push(conv);
    this.snap.messages[conv.id] = [];
    this.persist(); this.emit();
    return conv;
  }

  async createRoom(input: StartRoomInput): Promise<Conversation> {
    const conv: Conversation = {
      id: uid("room"), kind: "room", title: input.title, description: input.description,
      peers: [this.identity.address], gate: input.gate,
      policy: mergePolicy(this.org.policy, input.policy), unread: 0,
    };
    this.snap.conversations.push(conv);
    this.snap.messages[conv.id] = [{
      id: uid("m"), conversationId: conv.id, sender: this.identity.address,
      body: `#${input.title} created.`, sentAt: Date.now(),
    }];
    conv.lastMessage = this.snap.messages[conv.id][0];
    this.persist(); this.emit();
    return conv;
  }

  async requestRoomJoin(): Promise<void> {
    throw new Error("Self-serve gated joins are only available with XMTP transport.");
  }

  async setRoomPolicy(conversationId: string, policy: Policy): Promise<void> {
    const conv = this.snap.conversations.find((c) => c.id === conversationId && c.kind === "room");
    if (!conv) return;
    conv.policy = policy;
    this.persist(); this.emit();
  }
}
