import { describe, expect, it } from "vitest";
import { evaluatePolicy, mergePolicy, type Policy } from "@app/core";

describe("evaluatePolicy", () => {
  it("allows send under an active policy", () => {
    expect(evaluatePolicy({ mode: "active", attachments: "allow" }, { type: "send" })).toEqual({ allowed: true });
  });

  it("blocks non-admin sends in read-only mode and allows admin bypass", () => {
    const policy: Policy = { mode: "read-only", attachments: "allow" };
    expect(evaluatePolicy(policy, { type: "send" })).toMatchObject({ allowed: false, code: "read-only" });
    expect(evaluatePolicy(policy, { type: "send" }, { isAdmin: true })).toEqual({ allowed: true });
  });

  it("blocks attachments when disabled and enforces max upload bytes", () => {
    expect(evaluatePolicy(
      { mode: "active", attachments: "block" },
      { type: "attach", bytes: 1 },
    )).toMatchObject({ allowed: false, code: "attachments-blocked" });
    expect(evaluatePolicy(
      { mode: "active", attachments: "allow", maxUploadBytes: 10 },
      { type: "attach", bytes: 11 },
    )).toMatchObject({ allowed: false, code: "too-large" });
  });

  it("merges overrides on top of a base policy", () => {
    expect(mergePolicy(
      { mode: "active", attachments: "allow", maxUploadBytes: 100 },
      { mode: "read-only" },
    )).toEqual({ mode: "read-only", attachments: "allow", maxUploadBytes: 100 });
  });
});
