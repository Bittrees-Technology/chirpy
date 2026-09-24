import { getInjectedEthereum, type WalletEventProvider } from './walletProviders';

export interface BrowserWallet {
  id: string;
  name: string;
  rdns: string | null;
  provider: WalletEventProvider;
}

// Metadata is supplied by extensions, not a verified identity. Never execute
// icons or use an advertised name/domain to grant signing permissions.
export function discoverBrowserWallets(target: Window = window) {
  const announced: BrowserWallet[] = [];
  const observers = new Set<() => void>();
  const snapshot = (): BrowserWallet[] => {
    const legacy = getInjectedEthereum();
    return legacy && !announced.some(wallet => wallet.provider === legacy)
      ? [...announced, { id: 'legacy', name: 'Browser wallet', rdns: null, provider: legacy }]
      : [...announced];
  };
  const announce = (event: Event) => {
    try {
      const { info, provider } = (event as CustomEvent).detail ?? {};
      if (!info || !provider || typeof provider.request !== 'function') return;
      const { uuid, name, rdns } = info;
      if (typeof uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(uuid)) return;
      if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name)) return;
      if (typeof rdns !== 'string' || rdns.length > 253 || !/^[a-z0-9]+(?:[.-][a-z0-9]+)+$/i.test(rdns)) return;
      if (announced.length >= 32 || announced.some(wallet => wallet.id === uuid || wallet.provider === provider)) return;
      announced.push(Object.freeze({ id: uuid, name: name.trim(), rdns, provider }));
      observers.forEach(observer => observer());
    } catch { /* Malformed extension announcements must not break connection. */ }
  };
  target.addEventListener('eip6963:announceProvider', announce);
  target.dispatchEvent(new Event('eip6963:requestProvider'));
  return {
    snapshot,
    subscribe(observer: () => void) { observers.add(observer); return () => { observers.delete(observer); }; },
    destroy() { target.removeEventListener('eip6963:announceProvider', announce); observers.clear(); },
  };
}
