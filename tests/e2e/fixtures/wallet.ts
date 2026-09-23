import { readFileSync } from "node:fs";
import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

type WalletFixtures = {
  walletAddress: string;
};

type WalletInjectionTarget = Page | BrowserContext;

const isHex = (value: unknown): value is `0x${string}` =>
  typeof value === "string" && /^0x[0-9a-fA-F]*$/.test(value);

export async function injectSyntheticWallet(target: WalletInjectionTarget, privateKey = generatePrivateKey()): Promise<string> {
  const account = privateKeyToAccount(privateKey);
  if (process.env.CHIRPY_TEST_NATIVE_CSP === "1") {
    const policy = JSON.parse(readFileSync("apps/web/src-tauri/tauri.conf.json", "utf8")).app.security.csp;
    await target.route("http://127.0.0.1:*/**", async route => {
      const response = await route.fetch();
      await route.fulfill({ response, headers: { ...response.headers(), "content-security-policy": policy } });
    });
  }

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
  // No public profile choice unless the test supplies its own endpoint fixture.
  await target.route("**/api/profile?wallet=*", route => {
    const url = new URL(route.request().url());
    return route.fulfill({json: {service: new URL('/api/profile', url).href,
      profiles: (url.searchParams.get('wallet') ?? '').split(',').map(wallet => ({version: 1, wallet, revision: 0, label: null, updatedAt: 0}))}});
  });
  await target.route("**/api/profile?kind=display-wallet*", route => {
    if (route.request().method() !== 'GET') return route.fulfill({status: 405, body: ''});
    const url = new URL(route.request().url());
    return route.fulfill({json: {service: new URL('/api/profile', url).href + '?kind=display-wallet',
      choices: (url.searchParams.get('wallet') ?? '').split(',').map(wallet => ({version: 1, wallet,
        network: url.searchParams.get('network'), revision: 0, inboxId: null, displayWallet: null, updatedAt: 0}))}});
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

/** The native policy intentionally prevents loading the external analytics
 * consent script. Still require a ready app, and keep the web banner assertion. */
export async function dismissAnalyticsConsent(page: Page) {
  const decline = page.getByRole('button', { name: 'Decline', exact: true });
  if (process.env.CHIRPY_TEST_NATIVE_CSP === '1') {
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(decline).toHaveCount(0);
  } else {
    await decline.click();
  }
}

export const test = base.extend<WalletFixtures>({
  walletAddress: async ({ page }, use) => {
    try { await use(await injectSyntheticWallet(page)); }
    finally { await page.unrouteAll({ behavior: "wait" }); }
  },
});

export { expect } from "@playwright/test";
