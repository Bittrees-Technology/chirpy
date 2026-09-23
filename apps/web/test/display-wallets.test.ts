import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readDisplayWallets, publishDisplayWallet, DISPLAY_WALLET_CHANGED } from '../src/displayWallets';
import { setActiveProvider, clearActiveProvider } from '../src/walletProviders';
const wallet = '0x'+'1'.repeat(40), other = '0x'+'2'.repeat(40), inboxId = 'a'.repeat(64), service = 'https://chat.example/api/profile?kind=display-wallet';
vi.mock('../src/apiEndpoint', () => ({syncEndpoint: () => ({service: 'https://chat.example/api/usersync', requestUrl: '/api/usersync'})}));
const input = {wallet, inboxId, network: 'dev' as const, displayWallet: other, revision: 0};
const choice = () => ({...input, version: 1, revision: 1, updatedAt: 1});
let provider: any, handlers: Map<string, () => void>;
beforeEach(() => {
  handlers = new Map(); provider = {request: vi.fn(async ({method}) => method === 'eth_accounts' ? [wallet] : '0x1234'), on: (event, fn) => handlers.set(event, fn), removeListener: vi.fn()}; setActiveProvider(provider, 'injected');
  vi.stubGlobal('fetch', vi.fn(async (_url, init) => Response.json(init?.method === 'POST' ? {service, status: 'saved', choice: choice()} : {service, choices: [choice()]})));
});
afterEach(() => { clearActiveProvider(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });
it('checks fresh SDK links both before and after signing, binds the exact intent and omits cookies', async () => {
  const links = vi.fn(async () => {}), dispatch = vi.spyOn(window, 'dispatchEvent');
  expect(await publishDisplayWallet(input, new AbortController().signal, links)).toEqual(choice());
  expect(links).toHaveBeenCalledTimes(2); const init = vi.mocked(fetch).mock.calls[0][1]!;
  expect(init.credentials).toBe('omit'); expect(init.redirect).toBe('error');
  expect(JSON.parse(init.body as string).command).toMatchObject({...input, service, version: 1});
  expect(dispatch.mock.calls.some(([event]) => event.type === DISPLAY_WALLET_CHANGED)).toBe(true);
  expect(provider.removeListener).toHaveBeenCalledTimes(3);
});
it.each(['wallet', 'provider', 'disconnect', 'unlink'])('cannot publish after %s changes while the signature prompt is open', async change => {
  let done!: (value: string) => void; provider.request.mockImplementation(async ({method}) => method === 'eth_accounts' ? [wallet] : new Promise(resolve => {done = resolve;}));
  const links = vi.fn(async () => {}), result = publishDisplayWallet(input, new AbortController().signal, links);
  await vi.waitFor(() => expect(done).toBeTypeOf('function'));
  if (change === 'wallet') provider.request.mockResolvedValue([other]);
  if (change === 'provider') setActiveProvider({request: async () => [wallet]}, 'injected');
  if (change === 'disconnect') handlers.get('disconnect')!();
  if (change === 'unlink') links.mockRejectedValue(Error('unlinked'));
  done('0x1234'); await expect(result).rejects.toThrow(); expect(fetch).not.toHaveBeenCalled();
});
it('rejects an invalid command before opening a signature prompt', async () => {
  await expect(publishDisplayWallet({...input, inboxId: 'invalid'}, new AbortController().signal, async () => {})).rejects.toThrow();
  expect(provider.request.mock.calls.map(([arg]) => arg.method)).toEqual(['eth_accounts']); expect(fetch).not.toHaveBeenCalled();
});
it('does not announce success for late responses after cancellation or mismatched acknowledgements', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent');
  for (const patch of [{wallet: other}, {network: 'production'}, {revision: 2}, {inboxId: 'b'.repeat(64)}, {displayWallet: wallet}, {extra: true}]) {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({service, status: 'saved', choice: {...choice(), ...patch}}));
    await expect(publishDisplayWallet(input, new AbortController().signal, async () => {})).rejects.toThrow();
  }
  let finish!: (value: Response) => void; vi.mocked(fetch).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController(), pending = publishDisplayWallet(input, controller.signal, async () => {});
  await vi.waitFor(() => expect(finish).toBeTypeOf('function')); controller.abort(); finish(Response.json({service, status: 'saved', choice: choice()}));
  await expect(pending).rejects.toThrow(); expect(dispatch.mock.calls.some(([event]) => event.type === DISPLAY_WALLET_CHANGED)).toBe(false);
});
it('rejects oversized, unordered, foreign-service or wrong-network reads and duplicate requests', async () => {
  expect(await readDisplayWallets('dev', [wallet])).toEqual([choice()]);
  await expect(readDisplayWallets('dev', [wallet, wallet])).rejects.toThrow();
  for (const data of [{service: 'https://wrong.example', choices: [choice()]}, {service, choices: [{...choice(), network: 'production'}]}, {service, choices: [{...choice(), wallet: other}]}]) {
    vi.mocked(fetch).mockResolvedValueOnce(Response.json(data)); await expect(readDisplayWallets('dev', [wallet])).rejects.toThrow();
  }
  vi.mocked(fetch).mockResolvedValueOnce(new Response(' '.repeat(40001))); await expect(readDisplayWallets('dev', [wallet])).rejects.toThrow();
});
