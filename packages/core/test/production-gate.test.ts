import { expect, it } from "vitest";
import { validateProductionGate, createOrg } from "../src/index";
it("rejects permissive malformed or unsupported production gate rules", () => {
  const gate = (rule) => ({ combine: "any", rules: [{ kind: "ens" }, rule] });
  for (const rule of [{ kind: "power", tier: 0 }, { kind: "role", role: "admin" },
    { kind: "token", standard: "erc20", token: "0x" + "1".repeat(40), min: "-1" },
    { kind: "token", standard: "erc20", token: "0x" + "1".repeat(40), min: "0" },
    { kind: "token", standard: "erc1155", token: "0x" + "1".repeat(40), min: "1" }]) expect(validateProductionGate(gate(rule))).toBe(false);
  expect(validateProductionGate({ combine: "any", rules: [] })).toBe(false);
  expect(validateProductionGate({ combine: "all", rules: [{ kind: "ens" }] })).toBe(true);
});
it("gives identically named new organizations different namespaces", () => {
  expect(createOrg({ name: "Acme" }).namespace).not.toEqual(createOrg({ name: "Acme" }).namespace);
});
