import { test as base, type BrowserContext, type Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type WalletFixtures = {
  walletAddress: string;
};

type WalletInjectionTarget = Page | BrowserContext;

const isHex = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

export async function injectSyntheticWallet(target: WalletInjectionTarget): Promise<string> {
  const account = privateKeyToAccount(generatePrivateKey());

  await target.exposeFunction("__walletSign", (params: unknown[] = []) => {
    const rawHex = params.find(isHex);
    if (!rawHex) throw new Error("personal_sign requires a raw hex message.");
    return account.signMessage({ message: { raw: rawHex } });
  });
  await target.exposeFunction("__walletAddress", () => account.address);
  await target.addInitScript(() => {
    const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
    (window as any).ethereum = {
      isMetaMask: true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        if (method === "eth_requestAccounts" || method === "eth_accounts") {
          return [await (window as any).__walletAddress()];
        }
        if (method === "eth_chainId") return "0x1";
        if (method === "personal_sign") {
          return (window as any).__walletSign(params ?? []);
        }
        throw new Error(`unhandled wallet method: ${method}`);
      },
      on: (event: string, callback: (...args: unknown[]) => void) => {
        const callbacks = handlers.get(event) ?? new Set();
        callbacks.add(callback);
        handlers.set(event, callbacks);
      },
      removeListener: (event: string, callback: (...args: unknown[]) => void) => {
        handlers.get(event)?.delete(callback);
      },
    };
  });
  await target.route("https://api.ensideas.com/ens/resolve/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        address: account.address,
        name: "test.eth",
        displayName: "test.eth",
        avatar: null,
      }),
    });
  });

  return account.address;
}

export const test = base.extend<WalletFixtures>({
  walletAddress: async ({ page }, use) => {
    await use(await injectSyntheticWallet(page));
  },
});

export { expect } from "@playwright/test";
