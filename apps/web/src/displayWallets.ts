import { stringToHex } from 'viem';
import { publicProfileEndpoint } from './publicProfiles';
import { getActiveProvider, getProviderRevision, subscribeProvider } from './walletProviders';
import { profileAddress } from '../../../packages/core/src/publicProfile.js';
import { displayNetwork, displayWalletSignMessage, validDisplayWalletCommand, validDisplayWalletRecord, type DisplayNetwork, type DisplayWalletCommand, type DisplayWalletRecord } from '../../../packages/core/src/displayWallet.js';
export const DISPLAY_WALLET_CHANGED = 'chat:display-wallet-changed';
export function displayWalletEndpoint() {
  const endpoint = publicProfileEndpoint();
  return { service: endpoint.service + '?kind=display-wallet', requestUrl: endpoint.requestUrl + '?kind=display-wallet' };
}
async function body(response: Response) {
  if (!response.ok) throw Error('Display choice request failed');
  const reader = response.body?.getReader(); if (!reader) throw Error('Missing display choice response');
  const parts: Uint8Array[] = []; let length = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; length += value.length; if (length > 40000) throw Error('Display choice response too large'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); }
  const data = new Uint8Array(length); let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}
export async function readDisplayWallets(network: DisplayNetwork, wallets: string[], signal?: AbortSignal): Promise<DisplayWalletRecord[]> {
  if (!displayNetwork(network) || !wallets.length || wallets.length > 50 || !wallets.every(profileAddress) || new Set(wallets).size !== wallets.length) throw Error('Invalid display choice wallets');
  const endpoint = displayWalletEndpoint();
  const result = await body(await fetch(`${endpoint.requestUrl}&network=${network}&wallet=${encodeURIComponent(wallets.join(','))}`, { credentials: 'omit', redirect: 'error', cache: 'no-store', signal: AbortSignal.any([AbortSignal.timeout(8000), ...(signal ? [signal] : [])]) }));
  if (result.service !== endpoint.service || !Array.isArray(result.choices) || result.choices.length !== wallets.length || !result.choices.every((record: unknown, i: number) => validDisplayWalletRecord(record, wallets[i], network))) throw Error('Invalid display choices');
  signal?.throwIfAborted(); return result.choices;
}
export async function publishDisplayWallet(input: Omit<DisplayWalletCommand, 'version' | 'service' | 'expiresAt'>, signal: AbortSignal, assertCurrentLinks: () => Promise<void>): Promise<DisplayWalletRecord> {
  const endpoint = displayWalletEndpoint(), provider = getActiveProvider(), generation = getProviderRevision(), cancelled = new AbortController();
  if (!provider) throw Error('Connect wallet');
  const cancel = () => cancelled.abort(), scope = AbortSignal.any([signal, cancelled.signal]); const unsubscribe = subscribeProvider(cancel);
  const current = () => { scope.throwIfAborted(); if (getActiveProvider() !== provider || getProviderRevision() !== generation) throw Error('Wallet changed'); };
  const check = async () => { current(); const accounts = await provider.request({ method: 'eth_accounts' }); current(); if (!Array.isArray(accounts) || String(accounts[0]).toLowerCase() !== input.wallet) throw Error('Wallet changed'); };
  try {
    provider.on?.('accountsChanged', cancel); provider.on?.('disconnect', cancel); provider.on?.('session_delete', cancel);
    await check(); await assertCurrentLinks(); current();
    const command: DisplayWalletCommand = { ...input, version: 1, service: endpoint.service, expiresAt: Date.now() + 300000 };
    if (!validDisplayWalletCommand(command, endpoint.service)) throw Error('Invalid display choice');
    const signature = await provider.request({ method: 'personal_sign', params: [stringToHex(displayWalletSignMessage(command)), input.wallet] });
    await check(); await assertCurrentLinks(); current();
    const result = await body(await fetch(endpoint.requestUrl, { method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ command, signature }), signal: AbortSignal.any([scope, AbortSignal.timeout(30000)]) }));
    await check();
    if (result.service !== endpoint.service || result.status !== 'saved' || !validDisplayWalletRecord(result.choice, input.wallet, input.network) || result.choice.revision !== input.revision + 1 || result.choice.inboxId !== input.inboxId || result.choice.displayWallet !== input.displayWallet) throw Error('Display choice outcome unknown');
    window.dispatchEvent(new Event(DISPLAY_WALLET_CHANGED)); return result.choice;
  } finally { unsubscribe(); provider.removeListener?.('accountsChanged', cancel); provider.removeListener?.('disconnect', cancel); provider.removeListener?.('session_delete', cancel); }
}
