import { afterEach, describe, expect, it, vi } from "vitest";
import { XmtpTransport } from "../src/xmtp";
import { PERSONAL_ORG } from "@app/core";
const address = "0x0000000000000000000000000000000000000001";
function transport(namespace = "acme") { return new XmtpTransport({ ...PERSONAL_ORG, namespace }, { address }, null) as any; }
afterEach(() => vi.unstubAllGlobals());
describe("receipt privacy", () => {
  it("sends no receipt unless explicitly enabled and never sends room receipts", async () => {
    const t = transport(); const sendReadReceipt = vi.fn();
    t.sdk = { ConsentState: { Allowed: 1 } };
    t.conversations.set("dm", { sendReadReceipt, consentState: async () => 1 });
    await t.markRead("dm"); await t.markRead("dm", { sendReceipt: false });
    expect(sendReadReceipt).not.toHaveBeenCalled();
    await t.markRead("dm", { sendReceipt: true }); expect(sendReadReceipt).toHaveBeenCalledTimes(1);
    t.roomMeta.set("room", {}); t.conversations.set("room", { sendReadReceipt });
    await t.markRead("room", { sendReceipt: true }); expect(sendReadReceipt).toHaveBeenCalledTimes(1);
  });
});
describe("organization isolation and room discovery", () => {
  it("keeps DMs global and separates identically named rooms without creating seeds", async () => {
    const t = transport(); t.status = "ready";
    const rooms = [{ id: "one", kind: "room", title: "general", namespace: "acme" },
      { id: "two", kind: "room", title: "general", namespace: "other" },
      { id: "three", kind: "room", title: "general", namespace: "acme" },
      { id: "legacy", kind: "room", title: "general" }, { id: "dm", kind: "dm" }];
    t.client = { conversations: { sync: vi.fn(), syncAll: vi.fn(), list: async () => rooms } };
    t.mapConversation = async (c) => c;
    t.createRoom = vi.fn();
    expect((await t.listConversations()).map((c) => c.id)).toEqual(["one", "three", "dm"]);
    expect(t.createRoom).not.toHaveBeenCalled();
  });
  it("shows the same published room ID to wallets that have not joined", async () => {
    const gate = { combine: "all", rules: [{ kind: "ens" }] };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ rooms: [{ id: "published", namespace: "acme", title: "Members", gate }] }) }));
    const t = transport(); t.org.gateUrl = "https://gate.example/api/room-join"; t.status = "ready";
    t.client = { conversations: { sync: vi.fn(), syncAll: vi.fn(), list: async () => [] } };
    const rooms = await t.listConversations();
    expect(rooms[0]).toMatchObject({ id: "published", peers: [], namespace: "acme" });
    expect(t.roomMeta.get("published").gate).toEqual(gate);
  });
  it("does not invent current-wallet membership", async () => {
    const t = transport(); t.status = "ready"; t.client = { inboxId: "me", preferences: { getInboxStates: async () => [] } };
    expect(await t.addressesForMembers({ members: async () => [] })).toEqual([]);
  });
});

it("keeps existing DMs available when the external directory is down", async () => {
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
  const t = transport(); t.org.gateUrl = "https://gate.example/api/room-join"; t.status = "ready";
  t.client = { conversations: { sync: vi.fn(), syncAll: vi.fn(), list: async () => [{ id: "dm", kind: "dm" }] } };
  t.mapConversation = async (c) => c;
  expect((await t.listConversations()).map((c) => c.id)).toEqual(["dm"]);
  expect(t.warning).toContain("Published rooms are unavailable");
});
