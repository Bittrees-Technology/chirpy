import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { DisplayWallet } from '../src/views/DisplayWallet';
import { I18nProvider } from '../src/i18n';
import { readDisplayWallets, publishDisplayWallet } from '../src/displayWallets';
import { setActiveProvider, clearActiveProvider } from '../src/walletProviders';
const state = vi.hoisted(() => ({ identity: {address: '0x'+'1'.repeat(40)}, mode: 'wallet', transportId: 'xmtp', transportStatus: 'ready', getDisplayWalletContext: vi.fn() }));
vi.mock('../src/state', () => ({useIdentity: () => state, useChat: () => state}));
vi.mock('../src/displayWallets', () => ({readDisplayWallets: vi.fn(), publishDisplayWallet: vi.fn()}));
vi.mock('../src/usePublicProfiles', () => ({usePublicProfiles: () => new Map([['0x'+'2'.repeat(40), {label: 'Linked public name'}]])}));
const a = '0x'+'1'.repeat(40), b = '0x'+'2'.repeat(40), inboxId = 'a'.repeat(64);
const context = (wallet = a) => ({wallet, network: 'dev' as const, inboxId, wallets: [a,b], automaticWallet: a});
const empty = wallet => ({version: 1 as const, wallet, network: 'dev' as const, inboxId: null, displayWallet: null, revision: 0, updatedAt: 0});
let root: Root, container: HTMLDivElement;
const button = (text: string) => [...container.querySelectorAll('button')].find(button => button.textContent === text)!;
const render = (strict = false) => act(async () => root.render(React.createElement(I18nProvider, null, strict ? React.createElement(React.StrictMode, null, React.createElement(DisplayWallet)) : React.createElement(DisplayWallet))));
const select = (value: string) => act(async () => {const field = container.querySelector('select')!; field.value = value; field.dispatchEvent(new Event('change', {bubbles: true}));});
beforeEach(() => {
  vi.clearAllMocks(); vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); state.identity = {address: a}; state.mode = 'wallet'; state.transportId = 'xmtp'; state.transportStatus = 'ready';
  setActiveProvider({request: async () => [a]}, 'injected'); state.getDisplayWalletContext.mockResolvedValue(context()); vi.mocked(readDisplayWallets).mockResolvedValue([empty(a),empty(b)]);
  container = document.createElement('div'); root = createRoot(container);
});
afterEach(async () => {await act(async () => root.unmount()); clearActiveProvider(); vi.unstubAllGlobals(); vi.restoreAllMocks();});
it('loads safely under StrictMode, previews the selected public profile and requires fresh explicit consent', async () => {
  await render(true); expect(button('Reload display choice').disabled).toBe(false); expect(container.querySelectorAll('option')).toHaveLength(3);
  expect(button('Publish display choice').disabled).toBe(true); expect(publishDisplayWallet).not.toHaveBeenCalled();
  await select(b); expect(container.textContent).toContain('Linked public name');
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); expect(button('Publish display choice').disabled).toBe(false);
  await select(a); expect(button('Publish display choice').disabled).toBe(true);
});
it('clears stale state after unknown publication outcomes and requires reload and new consent', async () => {
  await render(); await select(b); await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  vi.mocked(publishDisplayWallet).mockRejectedValueOnce(Error('ack lost')); await act(async () => button('Publish display choice').click());
  expect(container.textContent).toContain('An interrupted save may already have completed'); expect(button('Publish display choice').disabled).toBe(true);
  await act(async () => button('Reload display choice').click()); expect(button('Publish display choice').disabled).toBe(true); expect(publishDisplayWallet).toHaveBeenCalledTimes(1);
});
it('rechecks SDK linkage before publication and rereads the actual shared winner after saving', async () => {
  await render(); await select(b); await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  vi.mocked(publishDisplayWallet).mockImplementation(async (input, signal, check) => {await check(); vi.mocked(readDisplayWallets).mockResolvedValue([{...empty(a), revision: 1, updatedAt: 1, inboxId, displayWallet: b}, {...empty(b), revision: 1, updatedAt: 2, inboxId, displayWallet: a}]); return {...empty(a),...input,revision:1,updatedAt:1};});
  await act(async () => button('Publish display choice').click());
  expect(container.querySelector('select')!.value).toBe(a); expect(container.textContent).toContain('Choice saved'); expect(button('Publish display choice').disabled).toBe(true);
});
it('refuses a selected wallet removed after the editor was opened', async () => {
  await render(); await select(b); await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click());
  state.getDisplayWalletContext.mockResolvedValue({...context(), wallets:[a]});
  vi.mocked(publishDisplayWallet).mockImplementation(async (_input, _signal, check) => {await check(); throw Error('should not reach publication');});
  await act(async () => button('Publish display choice').click()); expect(container.textContent).toContain('An interrupted save may already have completed');
});
it('aborts a provider-replaced save and ignores its late success', async () => {
  await render(); let finish!: (value: any) => void; vi.mocked(publishDisplayWallet).mockImplementationOnce(() => new Promise(resolve => {finish = resolve;}));
  await act(async () => container.querySelector<HTMLInputElement>('input[type=checkbox]')!.click()); await act(async () => button('Publish display choice').click());
  const signal = vi.mocked(publishDisplayWallet).mock.calls[0][1]; await act(async () => setActiveProvider({request: async () => [a]}, 'injected')); expect(signal.aborted).toBe(true);
  await act(async () => finish({...empty(a),revision:1,updatedAt:1,inboxId})); expect(container.textContent).not.toContain('Choice saved');
});
it('does not offer linked identity changes to guest/mock or inactive messaging sessions', async () => {
  state.mode = 'guest'; await render(); expect(container.textContent).toBe('');
  state.mode = 'wallet'; state.transportId = 'mock'; await render(); expect(container.textContent).toBe('');
  state.transportId = 'xmtp'; state.transportStatus = 'idle'; await render(); expect(container.textContent).toContain('Enable messaging'); expect(readDisplayWallets).not.toHaveBeenCalled();
});
