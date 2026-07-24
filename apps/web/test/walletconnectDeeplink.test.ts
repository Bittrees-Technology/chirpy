import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(__dirname, "../../..");

describe("WalletConnect native return path", () => {
  it("registers the chirpy URL scheme in Tauri", () => {
    const config = JSON.parse(
      readFileSync(resolve(root, "apps/web/src-tauri/tauri.conf.json"), "utf8"),
    );
    expect(config.plugins["deep-link"].mobile[0].scheme).toEqual(["chirpy"]);
    expect(config.plugins["deep-link"].desktop.schemes).toEqual(["chirpy"]);

    const capabilities = JSON.parse(
      readFileSync(resolve(root, "apps/web/src-tauri/capabilities/default.json"), "utf8"),
    );
    expect(capabilities.permissions).toContain("deep-link:default");
  });

  it("passes the chirpy URL scheme to WalletConnect metadata", () => {
    const source = readFileSync(resolve(root, "apps/web/src/walletProviders.ts"), "utf8");
    expect(source).toContain('native: "chirpy://"');
    expect(source).toContain("universal: window.location.origin");
  });
});
