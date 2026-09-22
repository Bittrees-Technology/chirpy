import { createWalletClient, custom, type Address, type WalletClient } from 'viem';
import type { Eip1193Provider } from './index.js';

export interface PushWalletProvider extends Eip1193Provider {
  on?(event: string, listener: () => void): void;
  removeListener?(event: string, listener: () => void): void;
}
export type PushSessionStatus = 'idle' | 'enabling' | 'ready' | 'error';
export interface PushSessionSnapshot { status: PushSessionStatus; revision: number; error?: string }
type Method = (...args: any[]) => Promise<unknown>;
export interface PushRoomClient {
  history: Method;
  send: Method;
  info: Method;
  join: Method;
  leave: Method;
  permissions: Method;
  participantStatus: Method;
  participants: Method;
  add: Method;
  remove: Method;
}
/** Kept inside the session; never returned to application consumers. */
export interface RawPushClient {
  account: string;
  decryptedPgpPvtKey?: string;
  chat: {
    history: Method; send: Method;
    group: {
      info: Method; join: Method; leave: Method; permissions: Method; add: Method; remove: Method;
      participants: { status: Method; list: Method };
    };
  };
}
export type PushSigner = Pick<WalletClient, 'signMessage' | 'signTypedData' | 'getChainId'> & { account: NonNullable<WalletClient['account']>; provider: { provider: Eip1193Provider } };
export type PushInitializer = (signer: PushSigner) => Promise<RawPushClient>;
async function initializeSdk(signer: PushSigner): Promise<RawPushClient> {
  const { PushAPI, CONSTANTS } = await import('@pushprotocol/restapi');
  // Recover through the signer, never through a cached plaintext private key.
  return await PushAPI.initialize(signer, { env: CONSTANTS.ENV.PROD, autoUpgrade: false }) as unknown as RawPushClient;
}
export class PushSessionChangedError extends Error {
  constructor() { super('The wallet connection changed or could not be verified. Enable rooms again. An action already sent to Push may have completed; check history or membership before retrying.'); }
}
const events = ['accountsChanged', 'chainChanged', 'disconnect', 'session_delete'];
function chainNumber(value: unknown): number {
  if (typeof value !== 'string' || !/^0x[0-9a-f]+$/i.test(value)) throw new PushSessionChangedError();
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result < 1) throw new PushSessionChangedError();
  return result;
}

/** One wallet/provider binding. isCurrent must read live connection state, not a React closure.
 * Explicit disposal drops access to the SDK and unregisters all observers. It does not
 * erase SDK memory or cancel requests already dispatched to the network. */
export class PushRoomSession {
  #snapshot: PushSessionSnapshot = Object.freeze({ status: 'idle', revision: 0 });
  #listeners = new Set<() => void>();
  #pending: Promise<PushRoomClient> | null = null;
  #client: PushRoomClient | null = null;
  #slot: { raw: RawPushClient | null } | null = null;
  #disposed = false;
  #chain: number | undefined;
  #owner: Address;
  constructor(owner: string, private provider: PushWalletProvider, private isCurrent: () => boolean,
    private initialize: PushInitializer = initializeSdk) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(owner)) throw new Error('Connect a valid wallet before enabling rooms.');
    if (!provider.on || !provider.removeListener) throw new Error('This wallet cannot safely observe room sessions.');
    this.#owner = owner.toLowerCase() as Address;
    try { for (const event of events) provider.on(event, this.invalidate); }
    catch {
      for (const event of events) { try { provider.removeListener(event, this.invalidate); } catch { /* Best-effort cleanup of a rejected provider. */ } }
      throw new Error('This wallet cannot safely observe room sessions.');
    }
  }
  getSnapshot = (): PushSessionSnapshot => this.#snapshot;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  #publish(status: PushSessionStatus, error?: string) {
    this.#snapshot = Object.freeze({ status, revision: this.#snapshot.revision, ...(error ? { error } : {}) });
    this.#listeners.forEach(listener => listener());
  }
  invalidate = () => {
    if (this.#slot) this.#slot.raw = null;
    this.#slot = null; this.#client = null; this.#pending = null; this.#chain = undefined;
    this.#snapshot = Object.freeze({ status: 'idle', revision: this.#snapshot.revision + 1 });
    this.#listeners.forEach(listener => listener());
  };
  dispose() {
    if (this.#disposed) return;
    this.#disposed = true;
    for (const event of events) this.provider.removeListener?.(event, this.invalidate);
    this.invalidate(); this.#listeners.clear();
  }
  #ensure(revision: number) {
    if (this.#disposed || revision !== this.#snapshot.revision || !this.isCurrent()) {
      if (revision === this.#snapshot.revision && !this.#disposed) this.invalidate();
      throw new PushSessionChangedError();
    }
  }
  async #check(revision: number, expectedChain?: number): Promise<number> {
    this.#ensure(revision);
    try {
      const [accounts, chain] = await Promise.all([
        this.provider.request({ method: 'eth_accounts' }), this.provider.request({ method: 'eth_chainId' }),
      ]);
      this.#ensure(revision);
      const actualChain = chainNumber(chain);
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string' || accounts[0].toLowerCase() !== this.#owner
        || (expectedChain !== undefined && actualChain !== expectedChain)) throw new PushSessionChangedError();
      return actualChain;
    } catch {
      if (revision === this.#snapshot.revision) this.invalidate();
      throw new PushSessionChangedError();
    }
  }
  enable(): Promise<PushRoomClient> {
    if (this.#disposed) return Promise.reject(new PushSessionChangedError());
    if (this.#pending) return this.#pending;
    const revision = this.#snapshot.revision;
    // Even an existing facade must check the actual wallet before reporting ready.
    if (this.#client) {
      const client = this.#client;
      return this.#check(revision, this.#chain).then(() => { this.#ensure(revision); return client; });
    }
    const operation = Promise.resolve().then(async () => {
      const chain = await this.#check(revision);
      const wallet = createWalletClient({ account: this.#owner, transport: custom(this.provider) });
      const checkAccount = (account: unknown) => {
        if (account === undefined) return;
        const address = typeof account === 'string' ? account : (account as { address?: unknown } | null)?.address;
        if (typeof address !== 'string' || address.toLowerCase() !== this.#owner) throw new PushSessionChangedError();
      };
      const check = () => this.#check(revision, chain);
      const assert = () => this.#ensure(revision);
      // Push identifies viem by one-argument signing methods. Expose only the signer
      // methods it needs, never sendTransaction or arbitrary provider requests.
      const recoveryProvider: Eip1193Provider = { request: async ({ method, params }) => {
        // The SDK's legacy key recovery otherwise falls back to window.ethereum,
        // which may be a different wallet from the active WalletConnect session.
        const ownerIndex = method === 'eth_decrypt' ? 1 : 0;
        if (!['eth_decrypt', 'eth_getEncryptionPublicKey'].includes(method) || !Array.isArray(params)
          || params.length !== ownerIndex + 1 || typeof params[ownerIndex] !== 'string'
          || (params[ownerIndex] as string).toLowerCase() !== this.#owner
          || (method === 'eth_decrypt' && (typeof params[0] !== 'string' || params[0].length > 512 * 1024))) {
          throw new Error('Unsupported Push key recovery request.');
        }
        await check(); assert();
        const result = await this.provider.request({ method, params });
        await check(); return result;
      } };
      const signer = {
        account: wallet.account,
        provider: { provider: recoveryProvider },
        async getChainId() { return check(); },
        async signMessage(args: Parameters<typeof wallet.signMessage>[0]) {
          checkAccount(args.account); await check(); assert(); const result = await wallet.signMessage(args); await check(); return result;
        },
        async signTypedData(args: Parameters<typeof wallet.signTypedData>[0]) {
          checkAccount(args.account); await check(); assert(); const result = await wallet.signTypedData(args); await check(); return result;
        },
      } as unknown as PushSigner;
      const raw = await this.initialize(signer);
      await check();
      if (typeof raw.account !== 'string' || raw.account.toLowerCase() !== this.#owner || typeof raw.decryptedPgpPvtKey !== 'string' || !raw.decryptedPgpPvtKey) {
        throw new Error('Push did not recover room keys for this wallet.');
      }
      const slot = { raw: raw as RawPushClient | null }; this.#slot = slot;
      const method = (path: string[]): Method => async (...args) => {
        await check(); this.#ensure(revision);
        if (!slot.raw) throw new PushSessionChangedError();
        let receiver: any = slot.raw;
        for (const part of path.slice(0, -1)) receiver = receiver?.[part];
        const action = receiver?.[path[path.length - 1]];
        if (typeof action !== 'function') throw new Error('This Push room action is unavailable.');
        try {
          const result = await Reflect.apply(action, receiver, args);
          await check(); return result;
        } catch (error) { await check(); throw error; }
      };
      const group = (name: string) => method(['chat', 'group', name]);
      const client: PushRoomClient = {
        history: method(['chat', 'history']), send: method(['chat', 'send']), info: group('info'),
        join: group('join'), leave: group('leave'), permissions: group('permissions'), add: group('add'), remove: group('remove'),
        participantStatus: method(['chat', 'group', 'participants', 'status']), participants: method(['chat', 'group', 'participants', 'list']),
      };
      Object.freeze(client);
      this.#ensure(revision); this.#client = client; this.#chain = chain; this.#publish('ready'); return client;
    }).catch(error => {
      if (revision === this.#snapshot.revision && !this.#disposed) {
        if (this.#slot) this.#slot.raw = null;
        this.#slot = null; this.#client = null;
        // SDK errors may carry request/signing details; keep the public state generic.
        this.#publish('error', 'Rooms could not be enabled. Check your wallet and try again.');
      }
      this.#ensure(revision);
      throw new Error('Rooms could not be enabled. Check your wallet and try again.');
    }).finally(() => { if (this.#pending === operation) this.#pending = null; });
    this.#pending = operation; this.#publish('enabling'); return operation;
  }
}
