import { describe, expect, it, vi } from 'vitest';
import { PushRoomSession, PushSessionChangedError, type RawPushClient, type PushSigner, type PushWalletProvider } from '../src/pushSession';
const owner = `0x${'1'.repeat(40)}`; const other = `0x${'2'.repeat(40)}`;
function deferred<T>() { let resolve!: (v:T)=>void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function fixture() {
  let address = owner; let chain = '0x1'; let current = true;
  const listeners = new Map<string, Set<() => void>>();
  const request = vi.fn(async ({ method }: { method: string }): Promise<any> => {
    if (method === 'eth_accounts') return [address];
    if (method === 'eth_chainId') return chain;
    if (method === 'personal_sign' || method === 'eth_signTypedData_v4') return `0x${'a'.repeat(130)}`;
    throw new Error('Unexpected wallet operation');
  });
  const provider: PushWalletProvider = { request,
    on(event, listener) { if (!listeners.has(event)) listeners.set(event, new Set()); listeners.get(event)!.add(listener); },
    removeListener(event, listener) { listeners.get(event)?.delete(listener); },
  };
  const action = vi.fn(async () => ({ ok: true }));
  const raw: RawPushClient = { account: owner, decryptedPgpPvtKey: 'synthetic-private-material', chat: { history: action, send: action,
    group: { info: action, join: action, leave: action, permissions: action, add: action, remove: action, participants: { status: action, list: action } } } };
  let signer!: PushSigner;
  const initialize = vi.fn(async (wallet: PushSigner) => { signer = wallet; return raw; });
  const session = new PushRoomSession(owner, provider, () => current, initialize);
  return { session, provider, raw, action, initialize, request, listeners, signer: () => signer,
    emit: (event: string) => listeners.get(event)?.forEach(listener => listener()),
    address: (value: string) => { address = value; }, chain: (value: string) => { chain = value; }, replace: () => { current = false; } };
}
describe('wallet-bound Push sessions', () => {
  it('requires removable wallet observers to detect reconnects of the same account', () => {
    expect(() => new PushRoomSession(owner, { request: async () => undefined }, () => true)).toThrow('safely observe');
  });
  it('deduplicates enable and exposes only guarded room methods, never keys or wallet writes', async () => {
    const f = fixture(); const a = f.session.enable(); const b = f.session.enable(); expect(a).toBe(b);
    const client = await a; expect(f.initialize).toHaveBeenCalledOnce();
    expect(await f.session.enable()).toBe(client);
    expect(client).not.toHaveProperty('decryptedPgpPvtKey'); expect(client).not.toHaveProperty('chat');
    expect(f.signer()).not.toHaveProperty('sendTransaction'); expect(f.signer()).not.toHaveProperty('request');
    expect(f.signer().signMessage.length).toBe(1); expect(f.signer().signTypedData.length).toBe(1);
    await client.join('room'); expect(f.action).toHaveBeenCalledOnce();
    f.session.dispose();
  });
  it.each(['accountsChanged', 'chainChanged', 'disconnect', 'session_delete'])('invalidates a recovered client on %s even after the same wallet reconnects', async event => {
    const f = fixture(); const client = await f.session.enable(); f.emit(event);
    await expect(client.send('room', { content: 'message' })).rejects.toBeInstanceOf(PushSessionChangedError);
    expect(f.action).not.toHaveBeenCalled(); expect(f.session.getSnapshot().status).toBe('idle');
    const next = await f.session.enable(); expect(next).not.toBe(client); f.session.dispose();
  });
  it('rejects silent account, chain and provider changes before dispatch', async () => {
    for (const change of [(f: ReturnType<typeof fixture>) => f.address(other), (f: ReturnType<typeof fixture>) => f.chain('0xa'), (f: ReturnType<typeof fixture>) => f.replace()]) {
      const f = fixture(); const client = await f.session.enable(); change(f);
      await expect(client.send('room')).rejects.toBeInstanceOf(PushSessionChangedError);
      expect(f.action).not.toHaveBeenCalled(); expect(f.session.getSnapshot().status).toBe('idle'); f.session.dispose();
    }
  });
  it('does not report a cached client ready after a silent chain switch', async () => {
    const f = fixture(); await f.session.enable(); f.chain('0xa');
    await expect(f.session.enable()).rejects.toBeInstanceOf(PushSessionChangedError); f.session.dispose();
  });
  it('rejects a delayed initializer after disconnect without replacing a newer client', async () => {
    const f = fixture(); const ready = deferred<RawPushClient>();
    f.initialize.mockImplementationOnce(async () => ready.promise);
    const old = f.session.enable(); await vi.waitFor(() => expect(f.initialize).toHaveBeenCalledOnce());
    f.emit('disconnect'); const current = await f.session.enable(); ready.resolve(f.raw);
    await expect(old).rejects.toBeInstanceOf(PushSessionChangedError);
    expect(await f.session.enable()).toBe(current); f.session.dispose();
  });
  it('rejects late writes with an explicit uncertain-completion error and never retries them', async () => {
    const f = fixture(); const client = await f.session.enable(); const reply = deferred<any>();
    f.action.mockImplementationOnce(async () => reply.promise);
    const sending = client.send('room'); await vi.waitFor(() => expect(f.action).toHaveBeenCalledOnce());
    f.emit('accountsChanged'); reply.resolve({ ok: true });
    await expect(sending).rejects.toThrow('may have completed'); expect(f.action).toHaveBeenCalledOnce(); f.session.dispose();
  });
  it('binds signatures to the owner and checks the wallet after a signature completes', async () => {
    const f = fixture(); await f.session.enable(); const signer = f.signer();
    await expect(signer.signMessage({ account: other as `0x${string}`, message: 'test' })).rejects.toBeInstanceOf(PushSessionChangedError);
    expect(f.request.mock.calls.filter(([arg]) => arg.method === 'personal_sign')).toHaveLength(0);
    const signed = deferred<string>();
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async arg => arg.method === 'personal_sign' ? signed.promise : original(arg));
    const pending = signer.signMessage({ message: 'test' });
    await vi.waitFor(() => expect(f.request.mock.calls.some(([arg]) => arg.method === 'personal_sign')).toBe(true));
    f.address(other); signed.resolve(`0x${'a'.repeat(130)}`);
    await expect(pending).rejects.toBeInstanceOf(PushSessionChangedError); f.session.dispose();
  });
  it('rejects wrong-account or keyless SDK recovery and permits explicit retry', async () => {
    for (const bad of [{ ...fixture().raw, account: other }, { ...fixture().raw, decryptedPgpPvtKey: undefined }]) {
      const f = fixture(); f.initialize.mockResolvedValueOnce(bad);
      await expect(f.session.enable()).rejects.toThrow('Rooms could not be enabled'); expect(f.session.getSnapshot().status).toBe('error');
      await f.session.enable(); expect(f.session.getSnapshot().status).toBe('ready'); f.session.dispose();
    }
  });
  it('routes legacy recovery only through the bound provider and rejects other RPC authority', async () => {
    const f = fixture(); await f.session.enable(); const recovery = f.signer().provider.provider;
    const original = f.request.getMockImplementation()!;
    f.request.mockImplementation(async args => args.method === 'eth_decrypt' ? 'synthetic-recovered-key' : original(args));
    await expect(recovery.request({ method: 'eth_decrypt', params: ['cipher', owner] })).resolves.toBe('synthetic-recovered-key');
    await expect(recovery.request({ method: 'eth_decrypt', params: ['cipher', other] })).rejects.toThrow('Unsupported');
    await expect(recovery.request({ method: 'eth_sendTransaction', params: [{}] })).rejects.toThrow('Unsupported');
    f.emit('disconnect');
    await expect(recovery.request({ method: 'eth_decrypt', params: ['cipher', owner] })).rejects.toBeInstanceOf(PushSessionChangedError);
    f.session.dispose();
  });
  it('keeps SDK request details out of failed room action messages', async () => {
    const f = fixture(); const client = await f.session.enable(); f.action.mockRejectedValueOnce(new Error('synthetic-private-request'));
    await expect(client.send('room')).rejects.toThrow('Push could not complete this room action');
    expect(f.action).toHaveBeenCalledOnce(); f.session.dispose();
  });
  it('keeps initializer diagnostics out of public error state and rejection messages', async () => {
    const f = fixture(); f.initialize.mockRejectedValueOnce(new Error('synthetic-sensitive-request-details'));
    await expect(f.session.enable()).rejects.toThrow('Rooms could not be enabled');
    expect(JSON.stringify(f.session.getSnapshot())).not.toContain('synthetic-sensitive'); f.session.dispose();
  });
  it('rejects wallet read failures before invoking a room action', async () => {
    const f = fixture(); const client = await f.session.enable(); f.request.mockRejectedValueOnce(new Error('provider unavailable'));
    await expect(client.join('room')).rejects.toBeInstanceOf(PushSessionChangedError);
    expect(f.action).not.toHaveBeenCalled(); f.session.dispose();
  });
  it('disposes all observers and makes retained methods and signers unusable', async () => {
    const f = fixture(); const client = await f.session.enable(); const signer = f.signer();
    f.session.dispose(); f.session.dispose();
    expect([...f.listeners.values()].every(set => set.size === 0)).toBe(true);
    await expect(f.session.enable()).rejects.toBeInstanceOf(PushSessionChangedError);
    await expect(client.history('room')).rejects.toBeInstanceOf(PushSessionChangedError);
    await expect(signer.signMessage({ message: 'test' })).rejects.toBeInstanceOf(PushSessionChangedError);
  });
});

describe('Push operation deadlines', () => {
  it('expires a stalled initializer and cannot install its late client over a fresh session', async () => {
    vi.useFakeTimers(); const f = fixture(); const pending = deferred<RawPushClient>();
    try {
      f.initialize.mockImplementationOnce(async () => pending.promise);
      const old = f.session.enable(); const rejected = expect(old).rejects.toThrow('Push took too long');
      await vi.advanceTimersByTimeAsync(120_000); await rejected;
      expect(f.session.getSnapshot().status).toBe('error');
      const fresh = await f.session.enable(); pending.resolve(f.raw);
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.session.enable()).toBe(fresh); expect(f.session.getSnapshot().status).toBe('ready');
    } finally { f.session.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('bounds provider checks before initialization or dispatch without issuing a room action', async () => {
    vi.useFakeTimers(); const f = fixture(); const accounts = deferred<any>();
    try {
      f.request.mockImplementationOnce(async () => accounts.promise);
      const initializing = f.session.enable(); const rejected = expect(initializing).rejects.toThrow('Push took too long');
      await vi.advanceTimersByTimeAsync(120_000); await rejected;
      expect(f.initialize).not.toHaveBeenCalled(); accounts.resolve([owner]);
      await vi.advanceTimersByTimeAsync(0); expect(f.initialize).not.toHaveBeenCalled();
      const client = await f.session.enable();
      f.request.mockImplementationOnce(async () => new Promise(() => {}));
      const read = client.history('room'); const denied = expect(read).rejects.toThrow('Push took too long');
      await vi.advanceTimersByTimeAsync(30_000); await denied;
      expect(f.action).not.toHaveBeenCalled();
    } finally { f.session.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it.each(['history', 'send'] as const)('rejects stalled %s, never retries, and discards late completion', async method => {
    vi.useFakeTimers(); const f = fixture(); const pending = deferred<any>();
    try {
      const client = await f.session.enable(); f.action.mockImplementationOnce(async () => pending.promise);
      const operation = client[method]('room'); const rejected = expect(operation).rejects.toThrow('may have completed');
      await vi.advanceTimersByTimeAsync(30_000); await rejected;
      expect(f.action).toHaveBeenCalledOnce(); expect(f.session.getSnapshot().status).toBe('error');
      await expect(client.send('room')).rejects.toBeInstanceOf(PushSessionChangedError);
      const fresh = await f.session.enable(); pending.resolve({ secret: 'old response' });
      await vi.advanceTimersByTimeAsync(0);
      expect(await f.session.enable()).toBe(fresh); expect(f.action).toHaveBeenCalledOnce();
    } finally { f.session.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
  it('an old deadline cannot invalidate a newer account session', async () => {
    vi.useFakeTimers(); const f = fixture();
    try {
      const client = await f.session.enable(); f.action.mockImplementationOnce(async () => new Promise(() => {}));
      const operation = client.history('room'); const rejected = expect(operation).rejects.toBeInstanceOf(PushSessionChangedError);
      await vi.advanceTimersByTimeAsync(0); f.emit('accountsChanged');
      const fresh = await f.session.enable(); await vi.advanceTimersByTimeAsync(30_000); await rejected;
      expect(await f.session.enable()).toBe(fresh); expect(f.session.getSnapshot().status).toBe('ready');
    } finally { f.session.dispose(); vi.clearAllTimers(); vi.useRealTimers(); }
  });
});
