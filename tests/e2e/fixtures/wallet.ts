import { test as base } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type WalletFixtures = {
  walletAddress: string;
};

export const test = base.extend<WalletFixtures>({
  walletAddress: async ({ page }, use) => {
    const account = privateKeyToAccount(generatePrivateKey());

    await page.exposeFunction("__walletSign", (rawHex: string) =>
      account.signMessage({ message: { raw: rawHex as `0x${string}` } }));
    await page.exposeFunction("__walletAddress", () => account.address);
    await page.addInitScript(() => {
      const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
      (window as any).ethereum = {
        isMetaMask: true,
        request: async ({ method, params }: { method: string; params?: unknown[] }) => {
          if (method === "eth_requestAccounts" || method === "eth_accounts") {
            return [await (window as any).__walletAddress()];
          }
          if (method === "eth_chainId") return "0x1";
          if (method === "personal_sign") {
            const [raw] = params ?? [];
            return (window as any).__walletSign(raw);
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
    await page.route("https://api.ensideas.com/ens/resolve/**", async (route) => {
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

    await use(account.address);
  },
});

export { expect } from "@playwright/test";
