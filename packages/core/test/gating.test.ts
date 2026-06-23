import { describe, expect, it } from "vitest";
import {
  decodeGate,
  encodeGate,
  evalGate,
  type ChainReader,
  type Gate,
} from "@app/core";

const USER = "0x0000000000000000000000000000000000000abc";
const OTHER = "0x0000000000000000000000000000000000000def";
const TOKEN = "0x1111111111111111111111111111111111111111";
const SAFE = "0x2222222222222222222222222222222222222222";

const reader = (overrides: Partial<ChainReader> = {}): ChainReader => ({
  erc20Balance: async () => 0n,
  erc20Decimals: async () => 18,
  erc721Balance: async () => 0n,
  erc1155Balance: async () => 0n,
  erc1155BalanceAny: async () => 0n,
  safeOwners: async () => [],
  safeDelegates: async () => [],
  ensAddress: async () => null,
  ensName: async () => null,
  rolesOf: async () => [],
  power: async () => 0,
  ...overrides,
});

const gating = {
  roleCascade: { partner: 3, "junior partner": 2, associate: 1 },
  powerTier: { label: "Power", resolver: "mock", tiers: [1, 10] },
};

describe("evalGate", () => {
  it("admits everyone for empty rules", async () => {
    await expect(evalGate({ combine: "any", rules: [] }, USER, reader(), gating)).resolves.toBe(true);
  });

  it("enforces ERC-20 human minimums using token decimals", async () => {
    const gate: Gate = {
      combine: "any",
      rules: [{ kind: "token", standard: "erc20", token: TOKEN, min: "1.5" }],
    };
    await expect(evalGate(gate, USER, reader({
      erc20Decimals: async () => 6,
      erc20Balance: async () => 1_500_000n,
    }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({
      erc20Decimals: async () => 6,
      erc20Balance: async () => 1_499_999n,
    }), gating)).resolves.toBe(false);
  });

  it("enforces ERC-721 count minimums", async () => {
    const gate: Gate = {
      combine: "any",
      rules: [{ kind: "token", standard: "erc721", token: TOKEN, min: "2" }],
    };
    await expect(evalGate(gate, USER, reader({ erc721Balance: async () => 2n }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({ erc721Balance: async () => 1n }), gating)).resolves.toBe(false);
  });

  it("enforces ERC-1155 specific token ids", async () => {
    const gate: Gate = {
      combine: "any",
      rules: [{ kind: "token", standard: "erc1155", token: TOKEN, min: "3", tokenId: "7" }],
    };
    await expect(evalGate(gate, USER, reader({
      erc1155Balance: async (_token, _user, id) => id === 7n ? 3n : 0n,
    }), gating)).resolves.toBe(true);
  });

  it("enforces ERC-1155 any-id balances when tokenId is omitted", async () => {
    const gate: Gate = {
      combine: "any",
      rules: [{ kind: "token", standard: "erc1155", token: TOKEN, min: "4" }],
    };
    await expect(evalGate(gate, USER, reader({ erc1155BalanceAny: async () => 4n }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({ erc1155BalanceAny: async () => 3n }), gating)).resolves.toBe(false);
  });

  it("allows Safe owners and delegates but rejects unrelated wallets", async () => {
    const gate: Gate = { combine: "any", rules: [{ kind: "safe", safe: SAFE }] };
    await expect(evalGate(gate, USER, reader({ safeOwners: async () => [USER] }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({ safeDelegates: async () => [USER] }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({ safeOwners: async () => [OTHER] }), gating)).resolves.toBe(false);
  });

  it("supports specific ENS and any primary ENS checks", async () => {
    await expect(evalGate({
      combine: "any",
      rules: [{ kind: "ens", name: "bücher.eth" }],
    }, USER, reader({ ensAddress: async () => USER }), gating)).resolves.toBe(true);
    await expect(evalGate({
      combine: "any",
      rules: [{ kind: "ens", name: "alice.eth" }],
    }, USER, reader({ ensAddress: async () => OTHER }), gating)).resolves.toBe(false);
    await expect(evalGate({
      combine: "any",
      rules: [{ kind: "ens" }],
    }, USER, reader({ ensName: async () => "alice.eth" }), gating)).resolves.toBe(true);
  });

  it("supports exact role checks and higher-rank cascade", async () => {
    await expect(evalGate({
      combine: "any",
      rules: [{ kind: "role", role: "moderator" }],
    }, USER, reader({ rolesOf: async () => ["moderator"] }), gating)).resolves.toBe(true);
    await expect(evalGate({
      combine: "any",
      rules: [{ kind: "role", role: "associate" }],
    }, USER, reader({ rolesOf: async () => ["partner"] }), gating)).resolves.toBe(true);
  });

  it("supports configured voting power tiers and fails when power is disabled", async () => {
    const gate: Gate = { combine: "any", rules: [{ kind: "power", tier: 10 }] };
    await expect(evalGate(gate, USER, reader({ power: async () => 10 }), gating)).resolves.toBe(true);
    await expect(evalGate(gate, USER, reader({ power: async () => 9 }), gating)).resolves.toBe(false);
    await expect(evalGate(gate, USER, reader({ power: async () => 10 }), {
      roleCascade: {},
      powerTier: null,
    })).resolves.toBe(false);
  });

  it("combines rules with any and all semantics", async () => {
    const rules: Gate["rules"] = [
      { kind: "ens" },
      { kind: "role", role: "member" },
    ];
    const r = reader({ ensName: async () => "alice.eth", rolesOf: async () => [] });
    await expect(evalGate({ combine: "any", rules }, USER, r, gating)).resolves.toBe(true);
    await expect(evalGate({ combine: "all", rules }, USER, r, gating)).resolves.toBe(false);
  });

  it("fails closed when the reader throws", async () => {
    const gate: Gate = {
      combine: "all",
      rules: [{ kind: "token", standard: "erc20", token: TOKEN, min: "1" }],
    };
    await expect(evalGate(gate, USER, reader({
      erc20Balance: async () => { throw new Error("rpc down"); },
    }), gating)).resolves.toBe(false);
  });
});

describe("gate URL encoding", () => {
  it("round-trips multi-rule gates with unicode and base64url output", () => {
    const gate: Gate = {
      combine: "all",
      rules: [
        { kind: "ens", name: "bücher.eth" },
        { kind: "token", standard: "erc1155", token: TOKEN, min: "2", tokenId: "42" },
        { kind: "role", role: "associate" },
      ],
    };
    const encoded = encodeGate(gate);
    expect(encoded).not.toMatch(/[+/=]/);
    expect(decodeGate(encoded)).toEqual(gate);
  });

  it("returns an open gate for malformed input", () => {
    expect(decodeGate("not-valid-base64")).toEqual({ combine: "any", rules: [] });
  });
});
