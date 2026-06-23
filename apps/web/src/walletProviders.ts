import type { Eip1193Provider } from "@app/transport";

export type WalletProviderKind = "injected" | "walletconnect";

export interface WalletEventProvider extends Eip1193Provider {
  on?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  on?(event: "disconnect" | "session_delete", listener: () => void): void;
  removeListener?(event: "accountsChanged", listener: (accounts: string[]) => void): void;
  removeListener?(event: "disconnect" | "session_delete", listener: () => void): void;
  connect?(): Promise<unknown>;
  disconnect?(): Promise<void>;
}

let activeProvider: WalletEventProvider | null = null;
let activeKind: WalletProviderKind | null = null;

const accountFromResponse = (accounts: unknown): string | null =>
  Array.isArray(accounts) && typeof accounts[0] === "string" ? accounts[0] : null;

export function getInjectedEthereum(): WalletEventProvider | null {
  if (typeof window === "undefined") return null;
  return (window as Window & { ethereum?: WalletEventProvider }).ethereum ?? null;
}

export function getActiveProvider(): WalletEventProvider | null {
  return activeProvider ?? getInjectedEthereum();
}

export function getActiveKind(): WalletProviderKind | null {
  return activeKind;
}

export function setActiveProvider(provider: WalletEventProvider, kind: WalletProviderKind) {
  activeProvider = provider;
  activeKind = kind;
}

export function clearActiveProvider() {
  activeProvider = null;
  activeKind = null;
}

export const walletConnectAvailable = (): boolean =>
  Boolean(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID);

async function initWalletConnectProvider(): Promise<WalletEventProvider & { accounts?: string[] }> {
  if (!walletConnectAvailable()) throw new Error("WalletConnect is not configured.");
  const { EthereumProvider } = await import("@walletconnect/ethereum-provider");
  const provider = await EthereumProvider.init({
    projectId: import.meta.env.VITE_WALLETCONNECT_PROJECT_ID as string,
    optionalChains: [1],
    rpcMap: {
      1: (import.meta.env.VITE_MAINNET_RPC_URL as string | undefined) || "https://ethereum-rpc.publicnode.com",
    },
    showQrModal: true,
    metadata: {
      name: "Chirpy",
      description: "Wallet-native chat for any community",
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.png`],
    },
  });
  return provider as unknown as WalletEventProvider & { accounts?: string[] };
}

export async function connectWalletConnect(): Promise<{ provider: WalletEventProvider; address: string }> {
  const provider = await initWalletConnectProvider();
  if (provider.connect) await provider.connect();
  else await provider.request({ method: "eth_requestAccounts" });
  const address = accountFromResponse(provider.accounts)
    ?? accountFromResponse(await provider.request({ method: "eth_accounts" }));
  if (!address) {
    await provider.disconnect?.();
    throw new Error("WalletConnect did not return an account.");
  }
  setActiveProvider(provider, "walletconnect");
  return { provider, address };
}

export async function restoreWalletConnect(): Promise<{ provider: WalletEventProvider; address: string } | null> {
  if (!walletConnectAvailable()) return null;
  const provider = await initWalletConnectProvider();
  const address = accountFromResponse(provider.accounts)
    ?? accountFromResponse(await provider.request({ method: "eth_accounts" }));
  if (!address) return null;
  setActiveProvider(provider, "walletconnect");
  return { provider, address };
}
