import { preparePushFile, readPushAttachment } from '../src/pushMedia';
import { describe, expect, it, vi } from 'vitest';
import { PushRooms } from '../src/pushRooms';
import { parsePushRegistry } from '../src/pushRegistry';
import type { PushRoomClient, PushSessionStatus } from '../src/pushSession';
const group = 'a'.repeat(64); const owner = `0x${'1'.repeat(40)}`;
const catalog = () => parsePushRegistry({ rooms: { shareholders: group }, custom: [], revision: 1 }, 'governance');
const id = catalog().rooms[0].id;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function setup() {
  let status: PushSessionStatus = 'idle'; let revision = 0; const listeners = new Set<() => void>();
  const client: PushRoomClient = { info: vi.fn(async () => ({ chatId: group, groupName: 'Shareholders', groupDescription: 'Original room', isPublic: false })),
    participantStatus: vi.fn(async () => ({ participant: true, pending: false, role: 'member' })), permissions: vi.fn(async () => ({ entry: true, chat: true })),
    history: vi.fn(async () => []), send: vi.fn(async () => ({})), join: vi.fn(async () => ({})), leave: vi.fn(async () => ({})), participants: vi.fn(async () => ({ members: [] })), add: vi.fn(async () => ({})), remove: vi.fn(async () => ({})) };
  const session = { getSnapshot: () => ({ status, revision }), subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    enable: vi.fn(async () => { status = 'ready'; listeners.forEach(fn => fn()); return client; }), dispose: vi.fn(() => { status = 'idle'; revision++; listeners.forEach(fn => fn()); }) };
  const load = vi.fn(async () => catalog()); const rooms = new PushRooms('governance', owner, session, load);
  const disconnect = () => { status = 'idle'; revision++; listeners.forEach(fn => fn()); };
  return { rooms, session, client, load, disconnect };
}
describe('source-scoped Push room adapter', () => {
  it('discovers original rooms without signing or treating missing gates as open admission', async () => {
    const f = setup(); await f.rooms.discover(); expect(f.session.enable).not.toHaveBeenCalled();
    expect(f.rooms.getSnapshot().rooms[0]).toMatchObject({ id, peers: [], push: { membership: 'unknown', canSend: false, canJoin: false } });
    await expect(f.rooms.history(id)).rejects.toThrow('Enable Push rooms'); expect(f.session.enable).not.toHaveBeenCalled();
  });
  it('preserves a catalog on fetch failure and accepts a genuinely empty catalog distinctly', async () => {
    const f = setup(); await f.rooms.discover(); f.load.mockRejectedValueOnce(new Error('unavailable'));
    await expect(f.rooms.discover()).rejects.toThrow(); expect(f.rooms.getSnapshot().rooms).toHaveLength(1); expect(f.rooms.getSnapshot().error).toContain('preserved');
    f.load.mockResolvedValueOnce({ ...catalog(), rooms: [] }); await f.rooms.discover(); expect(f.rooms.getSnapshot().rooms).toEqual([]);
  });
  it('preserves multiline source descriptions while rejecting hidden control characters', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.info).mockResolvedValue({ chatId: group, groupName: 'Source room', groupDescription: 'First line\nSecond line', isPublic: false });
    await f.rooms.refreshRoom(id); expect(f.rooms.getSnapshot().rooms[0].description).toBe('First line\nSecond line');
    vi.mocked(f.client.info).mockResolvedValue({ chatId: group, groupName: 'Bad\u0000title', groupDescription: '', isPublic: false });
    await expect(f.rooms.refreshRoom(id)).rejects.toThrow('unsupported room details');
  });
  it('prevents private-history reads by nonmembers but permits public history', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    await expect(f.rooms.history(id)).rejects.toThrow('Join this private room'); expect(f.client.history).not.toHaveBeenCalled();
    vi.mocked(f.client.info).mockResolvedValue({ chatId: group, groupName: 'Public', groupDescription: '', isPublic: true });
    expect(await f.rooms.history(id)).toEqual({ messages: [] });
  });
  it('checks current posting permission on each send and uses the original group ID', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable(); await f.rooms.send(id, 'Hello');
    expect(f.client.send).toHaveBeenCalledWith(group, { type: 'Text', content: 'Hello' });
    vi.mocked(f.client.permissions).mockResolvedValue({ entry: true, chat: false });
    await expect(f.rooms.send(id, 'Denied')).rejects.toThrow('not allowed'); expect(f.client.send).toHaveBeenCalledTimes(1);
  });
  it('does not report a pending join as membership or permit posting', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.participantStatus).mockResolvedValueOnce({ participant: false, pending: false, role: 'member' }).mockResolvedValue({ participant: true, pending: true, role: 'member' });
    expect(await f.rooms.join(id)).toMatchObject({ membership: 'pending', canSend: false, canJoin: false }); expect(f.client.join).toHaveBeenCalledWith(group);
    await expect(f.rooms.send(id, 'pending')).rejects.toThrow('not allowed');
  });
  it('does not call join when the existing admission rules deny entry', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    vi.mocked(f.client.permissions).mockResolvedValue({ entry: false, chat: false });
    await expect(f.rooms.join(id)).rejects.toThrow('admission rules'); expect(f.client.join).not.toHaveBeenCalled();
  });
  it('requires a current admin for bounded member changes', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    await expect(f.rooms.moderate(id, 'add', owner)).rejects.toThrow('administrator'); expect(f.client.add).not.toHaveBeenCalled();
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: true, pending: false, role: 'admin' });
    await f.rooms.moderate(id, 'add', owner); expect(f.client.add).toHaveBeenCalledWith(group, { role: 'MEMBER', accounts: [owner] });
  });
  it('clears membership/capabilities on disconnect and rejects late room metadata', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable(); await f.rooms.refreshRoom(id);
    const response = deferred<unknown>(); vi.mocked(f.client.info).mockReturnValueOnce(response.promise);
    const pending = f.rooms.refreshRoom(id); await vi.waitFor(() => expect(f.client.info).toHaveBeenCalledTimes(2));
    f.disconnect(); response.resolve({ chatId: group, groupName: 'Late', groupDescription: '', isPublic: true });
    await expect(pending).rejects.toThrow('connection changed'); expect(f.rooms.getSnapshot().rooms[0].push.membership).toBe('unknown');
  });
  it('does not let older permission responses overwrite a newer restriction', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const response = deferred<unknown>(); vi.mocked(f.client.info).mockReturnValueOnce(response.promise);
    const old = f.rooms.refreshRoom(id); await vi.waitFor(() => expect(f.client.info).toHaveBeenCalledOnce());
    vi.mocked(f.client.permissions).mockResolvedValue({ entry: true, chat: false });
    await f.rooms.refreshRoom(id);
    response.resolve({ chatId: group, groupName: 'Stale permission', groupDescription: '', isPublic: false });
    await expect(old).rejects.toThrow('refreshed again');
    expect(f.rooms.getSnapshot().rooms[0].push.canSend).toBe(false);
    expect(f.rooms.getSnapshot().rooms[0].title).toBe('Shareholders');
  });
  it('rejects a foreign room or stale pagination token without a history request', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    await expect(f.rooms.history(id.replace('governance', 'research'))).rejects.toThrow('selected source');
    await expect(f.rooms.history(id, 'invented')).rejects.toThrow('expired'); expect(f.client.history).not.toHaveBeenCalled();
  });
  it('rejects cross-page cycles, overlap and changed continuation pages while allowing stable revisits', async () => {
    const message = (cid: string, link: string | null, body = 'original') => ({ cid, link, fromDID: owner, toDID: group, timestamp: 1, messageType: 'Text', messageContent: body });
    const first = 'QmFirstMessage', second = 'QmSecondMessage', third = 'QmThirdMessage';
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValueOnce([message(first, second)]);
    const head = await f.rooms.history(id); expect(head.olderCursor).toBeTruthy();
    vi.mocked(f.client.history).mockResolvedValueOnce([message(second, first)]);
    await expect(f.rooms.history(id, head.olderCursor)).rejects.toThrow('pagination cycle');
    vi.mocked(f.client.history).mockResolvedValueOnce([message(second, first), message(first, null)]);
    await expect(f.rooms.history(id, head.olderCursor)).rejects.toThrow('repeated an earlier page');
    vi.mocked(f.client.history).mockResolvedValue([message(second, third)]);
    const older = await f.rooms.history(id, head.olderCursor); expect(older.messages[0].id).toBe(second);
    expect((await f.rooms.history(id, head.olderCursor)).messages).toEqual(older.messages);
    vi.mocked(f.client.history).mockResolvedValueOnce([message(second, third, 'rewritten')]);
    await expect(f.rooms.history(id, head.olderCursor)).rejects.toThrow('changed an existing history page');
    vi.mocked(f.client.history).mockResolvedValueOnce([message(third, null)]);
    expect((await f.rooms.history(id, older.olderCursor)).messages[0].id).toBe(third);
  });
  it('bounds member pages and returns only addresses and roles', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.participants).mockResolvedValue({ members: [{ address: `eip155:${owner}`, role: 'MEMBER', userInfo: { encryptedPrivateKey: 'do-not-copy', profile: { name: 'private profile' } } }] });
    expect(await f.rooms.members(id)).toEqual({ members: [{ address: owner, role: 'MEMBER' }], page: 1, pending: false, hasMore: false });
    expect(f.client.participants).toHaveBeenCalledWith(group, { page: 1, limit: 20, filter: { pending: false } });
    await expect(f.rooms.members(id, 0)).rejects.toThrow('valid member page');
    vi.mocked(f.client.participants).mockResolvedValue({ members: Array(21).fill({ address: owner, role: 'MEMBER' }) });
    await expect(f.rooms.members(id)).rejects.toThrow('unsupported member list');
    vi.mocked(f.client.participants).mockResolvedValue({ members: Array(2).fill({ address: owner, role: 'MEMBER' }) });
    await expect(f.rooms.members(id)).rejects.toThrow('duplicated member');
  });
  it('preserves NFT and smart-wallet member identifiers without collapsing them into contract addresses', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const addresses = [`nft:eip155:1:${owner}:42:100`, `scw:eip155:10:${owner}`];
    vi.mocked(f.client.participants).mockResolvedValue({ members: addresses.map(address => ({ address, role: 'MEMBER' })) });
    expect((await f.rooms.members(id)).members.map(member => member.address)).toEqual(addresses);
  });
  it('requires membership for private member lists and admin authority for pending lists', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    await expect(f.rooms.members(id, 1, true)).rejects.toThrow('administrator');
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    await expect(f.rooms.members(id)).rejects.toThrow('Join this private room');
    expect(f.client.participants).not.toHaveBeenCalled();
  });
  it('discards late private member lists after membership is revoked', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const response = deferred<unknown>(); vi.mocked(f.client.participants).mockReturnValueOnce(response.promise);
    const pending = f.rooms.members(id); await vi.waitFor(() => expect(f.client.participants).toHaveBeenCalledOnce());
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    await f.rooms.refreshRoom(id); response.resolve({ members: [{ address: owner, role: 'MEMBER' }] });
    await expect(pending).rejects.toThrow('permissions changed');
  });
  it('does not reveal late private history after a newer membership denial', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const response = deferred<unknown>(); vi.mocked(f.client.history).mockReturnValueOnce(response.promise);
    const pending = f.rooms.history(id); await vi.waitFor(() => expect(f.client.history).toHaveBeenCalledOnce());
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    await f.rooms.refreshRoom(id); response.resolve([]);
    await expect(pending).rejects.toThrow('permissions changed');
    expect(f.rooms.getSnapshot().rooms[0].push.membership).toBe('none');
  });
  it('disposes pending registry work and session ownership', async () => {
    const f = setup(); const response = deferred<ReturnType<typeof catalog>>(); f.load.mockReturnValueOnce(response.promise);
    const pending = f.rooms.discover(); f.rooms.dispose(); response.resolve(catalog()); await pending;
    expect(f.session.dispose).toHaveBeenCalledOnce(); await expect(f.rooms.enable()).rejects.toThrow();
  });
});

const replyCid = 'QmOriginalMessage';
const replyRow = (overrides = {}) => ({ cid: replyCid, link: null, fromDID: owner, toDID: group, timestamp: 1, messageType: 'Text', messageContent: 'Original message', ...overrides });
describe('Push reply dispatch', () => {
  it('resolves the original in the selected room and sends the SDK reply envelope once', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValue([replyRow()]);
    await f.rooms.send(id, 'Reply body', { replyTo: replyCid });
    expect(f.client.history).toHaveBeenCalledWith(group, { reference: replyCid, limit: 1 });
    expect(f.client.permissions).toHaveBeenCalledTimes(2);
    expect(f.client.send).toHaveBeenCalledExactlyOnceWith(group, { type: 'Reply', content: { type: 'Text', content: 'Reply body' }, reference: replyCid });
  });
  it.each(['', 'https://example.test/message', '../another-room', 'x'.repeat(129), null, 7])('rejects malformed reference %s before any SDK read or write', async replyTo => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    await expect(f.rooms.send(id, 'body', { replyTo: replyTo as string })).rejects.toThrow('original message');
    expect(f.client.info).not.toHaveBeenCalled(); expect(f.client.history).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled();
  });
  it.each([
    [], [replyRow({ cid: 'QmDifferentMessage' })], [replyRow({ toDID: 'b'.repeat(64) })],
    [replyRow({ toCAIP10: 'b'.repeat(64) })], [replyRow(), replyRow()],
  ].map(rows => ({ rows })))('rejects unavailable, substituted, foreign and excessive reference results %#', async ({ rows }) => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValue(rows);
    await expect(f.rooms.send(id, 'body', { replyTo: replyCid })).rejects.toThrow(); expect(f.client.send).not.toHaveBeenCalled();
  });
  it('does not read a private original when posting authority is absent', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.participantStatus).mockResolvedValue({ participant: false, pending: false, role: 'member' });
    await expect(f.rooms.send(id, 'body', { replyTo: replyCid })).rejects.toThrow('not allowed');
    expect(f.client.history).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled();
  });
  it('rechecks authority after resolving a parent and rejects revocation during that read', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockImplementation(async () => {
      vi.mocked(f.client.permissions).mockResolvedValue({ entry: true, chat: false }); return [replyRow()];
    });
    await expect(f.rooms.send(id, 'body', { replyTo: replyCid })).rejects.toThrow('not allowed'); expect(f.client.send).not.toHaveBeenCalled();
  });
  it.each(['disconnect', 'dispose', 'remove room', 'known denial'])('discards a delayed original on %s', async action => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const result = deferred<unknown>(); vi.mocked(f.client.history).mockReturnValue(result.promise);
    const pending = f.rooms.send(id, 'body', { replyTo: replyCid });
    await vi.waitFor(() => expect(f.client.history).toHaveBeenCalledOnce());
    if (action === 'disconnect') f.disconnect();
    if (action === 'dispose') f.rooms.dispose();
    if (action === 'remove room') { f.load.mockResolvedValue({ ...catalog(), rooms: [] }); await f.rooms.discover(); }
    if (action === 'known denial') { vi.mocked(f.client.permissions).mockResolvedValue({ entry: true, chat: false }); await f.rooms.refreshRoom(id); }
    result.resolve([replyRow()]); await expect(pending).rejects.toThrow(); expect(f.client.send).not.toHaveBeenCalled();
  });
  it('never falls back to plain text or retries after a rejected SDK reply', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable(); vi.mocked(f.client.history).mockResolvedValue([replyRow()]);
    vi.mocked(f.client.send).mockRejectedValue(new Error('Unknown delivery outcome'));
    await expect(f.rooms.send(id, 'body', { replyTo: replyCid })).rejects.toThrow('Unknown delivery outcome'); expect(f.client.send).toHaveBeenCalledOnce();
  });
});


describe('Push file dispatch', () => {
  const selected = () => preparePushFile('chosen.txt', 'text/plain', new TextEncoder().encode('Exact chosen bytes'));
  it('sends a file without requiring text and preserves its bytes and safe name', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const file = selected(); await f.rooms.send(id, '', { file });
    expect(f.client.send).toHaveBeenCalledOnce();
    const [room, payload] = vi.mocked(f.client.send).mock.calls[0];
    expect(room).toBe(group); expect(payload.type).toBe('File'); expect(readPushAttachment(payload.type, payload.content)).toEqual(file);
  });
  it('sends a caption and file as one ordered Composite without a second network write', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const file = selected(); await f.rooms.send(id, 'Original caption', { file });
    const [, payload] = vi.mocked(f.client.send).mock.calls[0];
    expect(payload.type).toBe('Composite'); expect(payload.content).toHaveLength(2);
    expect(payload.content[0]).toEqual({ type: 'Text', content: 'Original caption' });
    expect(readPushAttachment(payload.content[1].type, payload.content[1].content)).toEqual(file);
    expect(f.client.send).toHaveBeenCalledOnce();
  });
  it('snapshots the chosen content before asynchronous authority checks', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const file = selected(), original = { ...file };
    const pending = f.rooms.send(id, '', { file }); file.base64 = btoa('Changed after click'); file.filename = 'changed.bin';
    await pending; const [, payload] = vi.mocked(f.client.send).mock.calls[0];
    expect(readPushAttachment(payload.type, payload.content)).toEqual(original);
  });
  it('rejects invalid files, oversized captions and captioned file replies before network access', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    for (const [body, opts] of [['', { file: { ...selected(), bytes: 0 } }], ['x'.repeat(16_001), { file: selected() }], ['Caption', { file: selected(), replyTo: replyCid }]] as const) {
      await expect(f.rooms.send(id, body, opts)).rejects.toThrow();
    }
    expect(f.client.info).not.toHaveBeenCalled(); expect(f.client.send).not.toHaveBeenCalled();
  });
  it('denies lost posting authority and never retries an uncertain file send', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.permissions).mockResolvedValueOnce({ entry: true, chat: false });
    await expect(f.rooms.send(id, '', { file: selected() })).rejects.toThrow('not allowed'); expect(f.client.send).not.toHaveBeenCalled();
    vi.mocked(f.client.send).mockRejectedValue(new Error('Unknown outcome'));
    await expect(f.rooms.send(id, '', { file: selected() })).rejects.toThrow('Unknown outcome'); expect(f.client.send).toHaveBeenCalledOnce();
  });
});

describe('bounded file-heavy Push history', () => {
  const file = { type: 'File', content: JSON.stringify({ name: 'large.bin', content: 'data:application/octet-stream;base64,' + Buffer.alloc(1_000_000, 31).toString('base64') }) };
  const rows = Array.from({ length: 8 }, (_, i) => ({ cid: `QmLargeMessage${i}`, link: i === 7 ? null : `QmLargeMessage${i + 1}`, fromDID: owner, toDID: group, timestamp: i, messageType: file.type, messageObj: { content: file.content } }));
  it('shrinks oversized reads without losing original links or file bytes, including stable page revisits', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockImplementation(async (_room, options) => {
      const start = options.reference ? rows.findIndex(r => r.cid === options.reference) : 0;
      return rows.slice(start, start + options.limit);
    });
    const first = await f.rooms.history(id); expect(first.messages.map(m => m.id)).toEqual(rows.slice(0, 4).map(r => r.cid).reverse());
    expect(vi.mocked(f.client.history).mock.calls.map(c => c[1].limit)).toEqual([30, 4]);
    const second = await f.rooms.history(id, first.olderCursor);
    expect(second.messages.map(m => m.id)).toEqual(rows.slice(4).map(r => r.cid).reverse()); expect(second.olderCursor).toBeUndefined();
    expect((await f.rooms.history(id, first.olderCursor)).messages).toEqual(second.messages);
    expect(first.messages[0].pushAttachment?.bytes).toBe(1_000_000);
  });
  it('does not retry malformed history, ignored read limits or lost access', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValueOnce([{ ...rows[0], toDID: 'b'.repeat(64) }]);
    await expect(f.rooms.history(id)).rejects.toThrow('unsupported'); expect(f.client.history).toHaveBeenCalledOnce();
    vi.mocked(f.client.history).mockClear().mockResolvedValue(rows);
    await expect(f.rooms.history(id)).rejects.toThrow('unsupported'); expect(f.client.history).toHaveBeenCalledTimes(2);
    vi.mocked(f.client.history).mockClear().mockImplementation(async () => { f.disconnect(); return rows; });
    await expect(f.rooms.history(id)).rejects.toThrow('connection changed'); expect(f.client.history).toHaveBeenCalledOnce();
  });
  it('stops at one unsupported large composite instead of skipping it or retrying forever', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValue([{ ...rows[0], messageType: 'Composite', messageObj: { content: Array(7).fill({ messageType: 'File', messageObj: { content: file.content } }) } }]);
    await expect(f.rooms.history(id)).rejects.toThrow('display limit'); expect(f.client.history).toHaveBeenCalledTimes(2);
    expect(vi.mocked(f.client.history).mock.calls.map(c => c[1].limit)).toEqual([30, 1]);
  });
});


describe('Push file replies', () => {
  it('sends a file as a single native reply after binding the original and rechecking permissions', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    const file = preparePushFile('reply.txt', 'text/plain', new TextEncoder().encode('Exact reply bytes'));
    vi.mocked(f.client.history).mockResolvedValue([replyRow()]);
    await f.rooms.send(id, '', { replyTo: replyCid, file });
    const [room, payload] = vi.mocked(f.client.send).mock.calls[0];
    expect(room).toBe(group); expect(payload.type).toBe('Reply'); expect(payload.reference).toBe(replyCid);
    expect(readPushAttachment(payload.content.type, payload.content.content)).toEqual(file);
    expect(f.client.history).toHaveBeenCalledExactlyOnceWith(group, { reference: replyCid, limit: 1 });
    expect(f.client.permissions).toHaveBeenCalledTimes(2); expect(f.client.send).toHaveBeenCalledOnce();
  });
  it('refuses a foreign original without dropping the reply or sending a standalone file', async () => {
    const f = setup(); await f.rooms.discover(); await f.rooms.enable();
    vi.mocked(f.client.history).mockResolvedValue([replyRow({ toDID: 'b'.repeat(64) })]);
    await expect(f.rooms.send(id, '', { replyTo: replyCid, file: preparePushFile('empty.bin', '', new Uint8Array()) })).rejects.toThrow('unsupported');
    expect(f.client.send).not.toHaveBeenCalled();
  });
});

describe('Push reaction authority and linked snapshots',()=>{
 const target='QmReactionTarget',first='QmNewestReaction',second='QmOlderReaction';
 const row=(cid:string,link:string|null,extra={})=>({cid,link,fromDID:owner,toDID:group,timestamp:1,messageType:'Text',messageContent:'Original',...extra});
 const reaction=(cid:string,link:string|null,emoji='👍',reference=target)=>row(cid,link,{messageType:'Reaction',messageObj:{content:emoji,reference}});
 it('binds a reaction to the original room and refreshes posting permission after reading it',async()=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();vi.mocked(f.client.history).mockResolvedValue([row(target,null)]);
  await f.rooms.react(id,target,'👍');expect(f.client.history).toHaveBeenCalledExactlyOnceWith(group,{reference:target,limit:1});
  expect(f.client.permissions).toHaveBeenCalledTimes(2);expect(f.client.send).toHaveBeenCalledExactlyOnceWith(group,{type:'Reaction',content:'👍',reference:target});
 });
 it('rejects unsupported/removal input before any authority or SDK call',async()=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();
  for(const emoji of ['', '🎉', '__proto__']) await expect(f.rooms.react(id,target,emoji)).rejects.toThrow('supported');
  await expect(f.rooms.react(id,'../foreign','👍')).rejects.toThrow('original');expect(f.client.info).not.toHaveBeenCalled();expect(f.client.send).not.toHaveBeenCalled();
 });
 it.each([[],[row(target,null,{toDID:'b'.repeat(64)})],[row('QmSubstitutedTarget',null)],[reaction(target,null)],[row(target,null),row(target,null)]].map(rows=>({rows})))('rejects missing, foreign, substituted, reaction and excessive originals %#',async({rows})=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();vi.mocked(f.client.history).mockResolvedValue(rows);
  await expect(f.rooms.react(id,target,'👍')).rejects.toThrow();expect(f.client.send).not.toHaveBeenCalled();
 });
 it.each(['permission','disconnect','dispose'])('rejects a delayed original after %s changes',async change=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();const wait=deferred<unknown>();vi.mocked(f.client.history).mockReturnValue(wait.promise);
  const pending=f.rooms.react(id,target,'👍');await vi.waitFor(()=>expect(f.client.history).toHaveBeenCalledOnce());
  if(change==='permission')vi.mocked(f.client.permissions).mockResolvedValue({entry:true,chat:false});
  if(change==='disconnect')f.disconnect();if(change==='dispose')f.rooms.dispose();
  wait.resolve([row(target,null)]);await expect(pending).rejects.toThrow();expect(f.client.send).not.toHaveBeenCalled();
 });
 it('never retries or falls back to text after an uncertain reaction send',async()=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();vi.mocked(f.client.history).mockResolvedValue([row(target,null)]);vi.mocked(f.client.send).mockRejectedValue(Error('Uncertain'));
  await expect(f.rooms.react(id,target,'👍')).rejects.toThrow('Uncertain');expect(f.client.send).toHaveBeenCalledTimes(1);
 });
 it('retains deduplicated reactions across older pages, revisits and a newer independent snapshot',async()=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();
  vi.mocked(f.client.history).mockImplementation(async(_,options)=>options.reference===target?[row(target,null)]:options.reference===second?[reaction(second,target)]:[reaction(first,second)]);
  const latest=await f.rooms.history(id),middle=await f.rooms.history(id,latest.olderCursor),oldest=await f.rooms.history(id,middle.olderCursor);
  expect(oldest.messages[0].reactions).toEqual({'👍':[owner]});expect((await f.rooms.history(id,middle.olderCursor)).messages).toEqual(oldest.messages);
  vi.mocked(f.client.history).mockResolvedValueOnce([reaction(second,target,'🔥')]);
  await expect(f.rooms.history(id,latest.olderCursor)).rejects.toThrow('changed an existing history page');
  vi.mocked(f.client.history).mockResolvedValue([row(target,null)]);expect((await f.rooms.history(id)).messages[0].reactions).toBeUndefined();
 });
 it.each(['membership','visibility','malformed','catalog'])('forgets cached reaction snapshots after %s changes',async change=>{
  const f=setup();await f.rooms.discover();await f.rooms.enable();vi.mocked(f.client.history).mockResolvedValue([reaction(first,target)]);const latest=await f.rooms.history(id);
  if(change==='membership')vi.mocked(f.client.participantStatus).mockResolvedValue({participant:false,pending:false,role:'member'});
  if(change==='visibility')vi.mocked(f.client.info).mockResolvedValue({chatId:group,groupName:'Public',groupDescription:'',isPublic:true});
  if(change==='malformed')vi.mocked(f.client.info).mockResolvedValue({});
  if(change==='catalog'){f.load.mockResolvedValueOnce({...catalog(),rooms:[]});await f.rooms.discover();await f.rooms.discover();}
  else await f.rooms.refreshRoom(id).catch(()=>{});
  vi.mocked(f.client.participantStatus).mockResolvedValue({participant:true,pending:false,role:'member'});vi.mocked(f.client.info).mockResolvedValue({chatId:group,groupName:'Room',groupDescription:'',isPublic:false});
  await expect(f.rooms.history(id,latest.olderCursor)).rejects.toThrow('expired');
 });
});

it('bounds reaction snapshots without silently truncating counts or resetting linked history',async()=>{
 const f=setup();await f.rooms.discover();await f.rooms.enable();
 const target='QmFinalOriginal';
 vi.mocked(f.client.history).mockImplementation(async(_,options)=>{
  const start=options.reference?Number(options.reference.slice('QmEvent'.length)):0;
  return Array.from({length:30},(_,offset)=>({cid:'QmEvent'+String(start+offset).padStart(7,'0'),link:'QmEvent'+String(start+offset+1).padStart(7,'0'),fromDID:owner,toDID:group,timestamp:0,messageType:'Reaction',messageObj:{content:'👍',reference:target}}));
 });
 let page=await f.rooms.history(id);for(let index=1;index<200;index++)page=await f.rooms.history(id,page.olderCursor);
 await expect(f.rooms.history(id,page.olderCursor)).rejects.toThrow('snapshot reached its limit');
 vi.mocked(f.client.history).mockResolvedValue([{cid:'QmNewSnapshotReaction',link:target,fromDID:owner,toDID:group,timestamp:0,messageType:'Reaction',messageObj:{content:'❤️',reference:target}}]);
 const fresh=await f.rooms.history(id);
 // A new snapshot evicts the old 6,000-event path as a whole; it cannot mix or
 // truncate those counts into the new path to meet the aggregate cache limit.
 await expect(f.rooms.history(id,page.olderCursor)).rejects.toThrow('expired');
 vi.mocked(f.client.history).mockResolvedValue([{cid:target,link:null,fromDID:owner,toDID:group,timestamp:0,messageType:'Text',messageContent:'New snapshot'}]);
 expect((await f.rooms.history(id,fresh.olderCursor)).messages[0].reactions).toEqual({'❤️':[owner]});
});
