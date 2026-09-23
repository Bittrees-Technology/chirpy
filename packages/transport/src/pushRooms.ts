import { writePushFile, type PushAttachment } from './pushMedia.js';
import type { Message as PushSdkMessage } from '@pushprotocol/restapi';
import { parsePushIdentity } from './pushIdentity.js';
import type { Conversation, MessagePage } from './types.js';
import { loadPushRegistry, type PushCatalog, type PushCatalogRoom, type PushSource } from './pushRegistry.js';
import { PushRoomSession, type PushRoomClient, type PushSessionStatus } from './pushSession.js';
import { PUSH_HISTORY_LIMIT, PushHistoryBudgetError, readPushHistory } from './pushMessages.js';

type Session = Pick<PushRoomSession, 'getSnapshot' | 'subscribe' | 'enable' | 'dispose'>;
export interface PushRoomDetails {
  source: PushSource;
  membership: 'unknown' | 'none' | 'pending' | 'member';
  publicRoom?: boolean;
  canSend: boolean;
  canJoin: boolean;
  canModerate: boolean;
}
export interface PushMember { address: string; role: 'ADMIN' | 'MEMBER' }
export interface PushMemberPage { members: PushMember[]; page: number; hasMore: boolean; pending: boolean }
export interface PushConversation extends Conversation { push: PushRoomDetails }
export interface PushRoomsSnapshot {
  rooms: PushConversation[];
  status: PushSessionStatus;
  revision: number;
  loading: boolean;
  error?: string;
}
// Cursors share compact traversal metadata, not message bodies or private keys.
// It grows only when the reader explicitly requests another bounded page, and
// is released when the last retained cursor expires or the session changes.
interface HistoryPath { positions: Map<string, number>; fingerprints: Map<number, string> }
interface HistoryCursor { room: string; reference: string; epoch: number; path: HistoryPath; depth: number }
interface RoomState { title: string; description: string; details: PushRoomDetails }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Push returned unsupported room details.');
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, multiline = false): string {
  if (typeof value !== 'string' || value.length > max || (multiline ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/).test(value)) throw new Error('Push returned unsupported room details.');
  return value;
}
/** A source-scoped room adapter, deliberately separate from XMTP consent, policies and receipts.
 * The owner disposes it on source/organization/wallet changes. Catalog reads grant no authority. */
export class PushRooms {
  #catalog: PushCatalog | null = null;
  #details = new Map<string, RoomState>();
  #listeners = new Set<() => void>();
  #snapshot: PushRoomsSnapshot = { rooms: [], status: 'idle', revision: 0, loading: false };
  #disposed = false;
  #epoch = 0;
  #registryRequest = 0;
  #catalogError: string | undefined;
  #roomRequests = new Map<string, number>();
  #abort: AbortController | null = null;
  #stop: () => void;
  #cursors = new Map<string, HistoryCursor>();
  constructor(readonly source: PushSource, private owner: string, private session: Session | null,
    private load: typeof loadPushRegistry = loadPushRegistry) {
    if (!/^0x[a-fA-F0-9]{40}$/.test(owner)) throw new Error('Invalid room wallet.');
    this.#stop = session?.subscribe(() => {
      if (session.getSnapshot().status !== 'ready') {
        this.#epoch++; this.#details.clear(); this.#cursors.clear(); this.#roomRequests.clear();
      }
      this.#publish();
    }) ?? (() => {});
  }
  getSnapshot = () => this.#snapshot;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(extra: Partial<Pick<PushRoomsSnapshot, 'loading' | 'error'>> = {}) {
    if (this.#disposed) return;
    if (Object.prototype.hasOwnProperty.call(extra, 'error')) this.#catalogError = extra.error;
    this.#snapshot = {
      ...this.#snapshot, ...extra,
      error: this.session?.getSnapshot().error ?? this.#catalogError, revision: this.#snapshot.revision + 1,
      status: this.session?.getSnapshot().status ?? 'idle',
      rooms: (this.#catalog?.rooms ?? []).map(room => {
        const state = this.#details.get(room.id);
        return { id: room.id, kind: 'room', title: state?.title ?? room.title, description: state?.description ?? room.description,
          // This is only this wallet's membership, never a complete member count.
          peers: state?.details.membership === 'member' ? [this.owner] : [], unread: 0,
          push: state?.details ?? { source: this.source, membership: 'unknown', canSend: false, canJoin: false, canModerate: false } };
      }),
    };
    this.#listeners.forEach(listener => listener());
  }
  #room(id: string): PushCatalogRoom {
    const room = this.#catalog?.rooms.find(room => room.id === id);
    if (this.#disposed || !room) throw new Error('This room is no longer in the selected source. Refresh rooms.');
    return room;
  }
  #ensure(epoch: number, id: string) {
    this.#room(id);
    if (epoch !== this.#epoch || this.session?.getSnapshot().status !== 'ready') throw new Error('Room connection changed. Enable rooms again.');
  }
  #ensureAccess(id: string, access: PushRoomDetails, epoch: number) {
    this.#ensure(epoch, id);
    if (this.#details.get(id)?.details !== access) throw new Error('Room permissions changed while this action was in progress. Refresh the room.');
  }
  async discover() {
    if (this.#disposed) throw new Error('Room source closed.');
    this.#abort?.abort(); const controller = new AbortController(); this.#abort = controller;
    const request = ++this.#registryRequest;
    this.#publish({ loading: true, error: undefined });
    try {
      const next = await this.load(this.source, { signal: controller.signal });
      if (this.#disposed || request !== this.#registryRequest) return;
      this.#catalog = next;
      for (const id of this.#details.keys()) if (!next.rooms.some(room => room.id === id)) this.#details.delete(id);
      this.#publish({ loading: false, error: undefined });
    } catch (error) {
      if (this.#disposed || request !== this.#registryRequest) return;
      this.#publish({ loading: false, error: 'Rooms could not be refreshed. The previous room list is preserved.' });
      throw error;
    }
  }
  async enable() {
    if (this.#disposed || !this.session) throw new Error('Connect a wallet before enabling Push rooms.');
    await this.session.enable();
    if (this.#disposed) throw new Error('Room source closed.');
    this.#publish({ error: undefined });
  }
  async #client(id: string): Promise<{ client: PushRoomClient; room: PushCatalogRoom; epoch: number }> {
    const room = this.#room(id); const epoch = this.#epoch;
    // Never prompt for signatures as a side effect of reading history or selecting a room.
    if (!this.session || this.session.getSnapshot().status !== 'ready') throw new Error('Enable Push rooms to open this conversation.');
    const client = await this.session.enable(); this.#ensure(epoch, id);
    return { room, client, epoch };
  }
  async refreshRoom(id: string): Promise<PushRoomDetails> {
    const { room, client, epoch } = await this.#client(id);
    const request = (this.#roomRequests.get(id) ?? 0) + 1; this.#roomRequests.set(id, request);
    try {
      const [rawInfo, rawStatus, rawPermissions] = await Promise.all([client.info(room.chatId), client.participantStatus(room.chatId), client.permissions(room.chatId)]);
      this.#ensure(epoch, id);
      if (this.#roomRequests.get(id) !== request) throw new Error('Room details were refreshed again. Try the action again.');
      const info = object(rawInfo); const status = object(rawStatus); const permissions = object(rawPermissions);
      if (info.chatId !== room.chatId || typeof info.isPublic !== 'boolean' || typeof status.participant !== 'boolean'
        || typeof status.pending !== 'boolean' || !['admin', 'member'].includes(String(status.role))
        || typeof permissions.entry !== 'boolean' || typeof permissions.chat !== 'boolean') throw new Error('Push returned unsupported room details.');
      const member = status.participant && !status.pending;
      const details: PushRoomDetails = { source: this.source, membership: status.pending ? 'pending' : member ? 'member' : 'none',
        publicRoom: info.isPublic, canSend: member && permissions.chat, canJoin: !member && !status.pending && permissions.entry,
        canModerate: member && status.role === 'admin' };
      this.#details.set(id, { title: text(info.groupName, 256) || room.title, description: text(info.groupDescription, 4096, true), details });
      this.#publish(); return details;
    } catch (error) {
      if (!this.#disposed && epoch === this.#epoch && this.#roomRequests.get(id) === request) { this.#details.delete(id); this.#publish(); }
      throw error;
    }
  }
  async history(id: string, before?: string): Promise<MessagePage> {
    const access = await this.refreshRoom(id);
    if (!access.publicRoom && access.membership !== 'member') throw new Error('Join this private room before reading its history.');
    const { room, client, epoch } = await this.#client(id);
    const cursor = before === undefined ? undefined : this.#cursors.get(before);
    if (before !== undefined && (!cursor || cursor.room !== id || cursor.epoch !== epoch)) throw new Error('This history page expired. Return to latest messages.');
    let limit = PUSH_HISTORY_LIMIT;
    let page: ReturnType<typeof readPushHistory>;
    for (;;) {
      const raw = await client.history(room.chatId, { limit, ...(cursor ? { reference: cursor.reference } : {}) });
      this.#ensureAccess(id, access, epoch);
      if (!Array.isArray(raw) || raw.length > limit) throw new Error('Push returned an unsupported room history response. No messages were replaced.');
      try { page = readPushHistory(raw, id, cursor?.reference); break; }
      catch (error) {
        // Retry reads only, and only for a known aggregate budget failure.
        // No truncation or skipping: the smaller page retains protocol links.
        if (!(error instanceof PushHistoryBudgetError) || limit === 1) throw error;
        limit = Math.max(1, Math.floor(Math.min(raw.length, limit) / 2));
      }
    }
    const path = cursor?.path ?? { positions: new Map<string, number>(), fingerprints: new Map<number, string>() };
    const depth = cursor?.depth ?? 0;
    // The backend must not splice an already visited page into this traversal.
    for (const message of page.messages) {
      const position = path.positions.get(message.id);
      if (position !== undefined && position !== depth) throw new Error('Push history repeated an earlier page. Return to latest messages.');
    }
    if (page.nextReference && path.positions.has(page.nextReference) && path.positions.get(page.nextReference)! <= depth) {
      throw new Error('Push history contains a pagination cycle. Return to latest messages.');
    }
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(page)));
    this.#ensureAccess(id, access, epoch);
    const fingerprint = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
    const previous = path.fingerprints.get(depth);
    if (previous !== undefined && previous !== fingerprint) throw new Error('Push changed an existing history page. Return to latest messages.');
    path.fingerprints.set(depth, fingerprint);
    for (const message of page.messages) path.positions.set(message.id, depth);
    if (!page.nextReference) return { messages: page.messages };
    const token = crypto.randomUUID();
    if (this.#cursors.size >= 200) this.#cursors.delete(this.#cursors.keys().next().value!);
    this.#cursors.set(token, { room: id, reference: page.nextReference, epoch, path, depth: depth + 1 });
    return { messages: page.messages, olderCursor: token };
  }
  async members(id: string, page = 1, pending = false): Promise<PushMemberPage> {
    if (!Number.isSafeInteger(page) || page < 1 || page > 1_000_000 || typeof pending !== 'boolean') throw new Error('Choose a valid member page.');
    const access = await this.refreshRoom(id);
    if (!access.publicRoom && access.membership !== 'member') throw new Error('Join this private room before viewing its members.');
    if (pending && !access.canModerate) throw new Error('Only a current Push room administrator can view pending members.');
    const { room, client, epoch } = await this.#client(id); this.#ensureAccess(id, access, epoch);
    const raw = object(await client.participants(room.chatId, { page, limit: 20, filter: { pending } }));
    this.#ensureAccess(id, access, epoch);
    if (!Array.isArray(raw.members) || raw.members.length > 20) throw new Error('Push returned an unsupported member list.');
    const seen = new Set<string>();
    const members = raw.members.map(value => {
      const member = object(value);
      const address = parsePushIdentity(member.address);
      if (!address || (member.role !== 'ADMIN' && member.role !== 'MEMBER')) throw new Error('Push returned an unsupported member list.');
      if (seen.has(address)) throw new Error('Push returned a duplicated member. Refresh the member list.');
      seen.add(address);
      // Do not copy SDK userInfo, encrypted keys or unselected profile fields.
      return { address, role: member.role } as PushMember;
    });
    return { members, page, hasMore: members.length === 20, pending };
  }
  async send(id: string, body: string, opts?: { replyTo?: string; file?: PushAttachment }): Promise<void> {
    const fileContent = opts?.file === undefined ? undefined : writePushFile(opts.file);
    if ((!body.trim() && fileContent === undefined) || body.length > 16_000 || new TextEncoder().encode(body).byteLength > 64 * 1024) throw new Error('Write a message of at most 16,000 characters.');
    const replyTo = opts?.replyTo;
    if (replyTo !== undefined && fileContent !== undefined) throw new Error('Remove the file to reply to a message.');
    if (replyTo !== undefined && (typeof replyTo !== 'string' || !/^[a-zA-Z0-9]{10,128}$/.test(replyTo))) throw new Error('Choose an original message in this room to reply to.');
    let access = await this.refreshRoom(id);
    if (!access.canSend) throw new Error('Push has not allowed this wallet to post in the room.');
    const { room, client, epoch } = await this.#client(id);
    this.#ensureAccess(id, access, epoch);
    if (replyTo !== undefined) {
      // A CID alone is not a room binding. Resolve just that original message,
      // validate its recipients/reference, then recheck posting authority.
      const raw = await client.history(room.chatId, { reference: replyTo, limit: 1 });
      this.#ensureAccess(id, access, epoch);
      if (!Array.isArray(raw) || raw.length !== 1) throw new Error('Choose an original message in this room to reply to.');
      const parent = readPushHistory(raw, id, replyTo);
      if (parent.messages.length !== 1 || parent.messages[0].id !== replyTo) throw new Error('Choose an original message in this room to reply to.');
      access = await this.refreshRoom(id);
      if (!access.canSend) throw new Error('Push has not allowed this wallet to post in the room.');
      this.#ensureAccess(id, access, epoch);
    }
    const payload: PushSdkMessage = fileContent !== undefined
      ? body.trim() ? { type: 'Composite', content: [{ type: 'Text', content: body }, { type: 'File', content: fileContent }] }
        : { type: 'File', content: fileContent }
      : replyTo === undefined ? { type: 'Text', content: body }
        : { type: 'Reply', content: { type: 'Text', content: body }, reference: replyTo };
    await client.send(room.chatId, payload);
    this.#ensure(epoch, id);
    // A resolved SDK send is not evidence of delivery/read. The caller refreshes history.
  }
  async join(id: string): Promise<PushRoomDetails> {
    const access = await this.refreshRoom(id);
    if (access.membership === 'member') return access;
    if (!access.canJoin) throw new Error('This wallet does not meet the existing room admission rules.');
    const { room, client, epoch } = await this.#client(id);
    this.#ensureAccess(id, access, epoch);
    await client.join(room.chatId); this.#ensure(epoch, id);
    return this.refreshRoom(id); // A pending membership must remain pending in the UI.
  }
  async leave(id: string): Promise<PushRoomDetails> {
    const access = await this.refreshRoom(id);
    if (access.membership === 'none') return access;
    const { room, client, epoch } = await this.#client(id);
    this.#ensureAccess(id, access, epoch);
    await client.leave(room.chatId); this.#ensure(epoch, id);
    this.#cursors.clear(); return this.refreshRoom(id);
  }
  async moderate(id: string, action: 'add' | 'remove', address: string, role: 'ADMIN' | 'MEMBER' = 'MEMBER') {
    if (!/^0x[a-fA-F0-9]{40}$/.test(address) || !['add', 'remove'].includes(action) || !['ADMIN', 'MEMBER'].includes(role)) throw new Error('Choose a valid wallet and membership action.');
    const access = await this.refreshRoom(id);
    if (!access.canModerate) throw new Error('Only a current Push room administrator can manage members.');
    const { room, client, epoch } = await this.#client(id);
    this.#ensureAccess(id, access, epoch);
    await client[action](room.chatId, { role, accounts: [address] }); this.#ensure(epoch, id);
    return this.refreshRoom(id);
  }
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true; this.#epoch++; this.#abort?.abort(); this.#stop(); this.session?.dispose();
    this.#details.clear(); this.#cursors.clear(); this.#roomRequests.clear(); this.#listeners.clear(); this.#catalog = null;
  }
}
