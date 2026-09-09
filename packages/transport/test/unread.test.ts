import { afterEach, expect, it, vi } from "vitest";
import { ReadState } from "../src/readState";
import { XmtpTransport } from "../src/xmtp";
import { PERSONAL_ORG } from "@app/core";
afterEach(() => vi.unstubAllGlobals());
it("persists exact nanosecond cursors without moving backwards or crossing wallet/network scope", () => {
  const data = new Map<string, string>();
  vi.stubGlobal("localStorage", { getItem: (k) => data.get(k) ?? null, setItem: (k, v) => data.set(k, v) });
  const first = new ReadState("dev:wallet-a");
  const time = 1234567890123456789n;
  expect(first.advance("dm", time)).toBe(true);
  const restored = new ReadState("dev:wallet-a");
  expect(restored.get("dm")).toBe(time);
  expect(restored.advance("dm", time - 1n)).toBe(false);
  expect(new ReadState("production:wallet-a").get("dm")).toBe(0n);
  expect(new ReadState("dev:wallet-b").get("dm")).toBe(0n);
});
it("keeps monotonic read state in memory when browser storage is unavailable", () => {
  vi.stubGlobal("localStorage", { getItem: () => { throw new Error("disabled"); }, setItem: () => { throw new Error("disabled"); } });
  const read = new ReadState("a");
  expect(read.advance("dm", 5n)).toBe(true);
  expect(read.advance("dm", 3n)).toBe(false);
  expect(read.get("dm")).toBe(5n);
});
function setup() {
  const t = new XmtpTransport(PERSONAL_ORG, { address: "0x0000000000000000000000000000000000000001" }, null) as any;
  t.sdk = { ConsentState: { Allowed: 1 }, ConversationType: { Group: "group" }, ContentType: { Text: 13, Reply: 12 } };
  t.status = "ready";
  t.client = { inboxId: "self-inbox" };
  const conversation = { id: "dm", metadata: { conversationType: "dm" }, consentState: async () => 1, sendReadReceipt: vi.fn(), countMessages: vi.fn(async () => 2n) };
  t.conversations.set("dm", conversation);
  t.messageCursors.set("loaded", { conversationId: "dm", at: 100n });
  return { t, conversation };
}
it("read marking requires a loaded boundary, preserves newer unread messages, and works with receipts off", async () => {
  const { t, conversation } = setup();
  await t.markRead("dm", { sendReceipt: true, throughMessageId: "not-loaded" });
  expect(t.readState.get("dm")).toBe(0n);
  await t.markRead("dm", { sendReceipt: false, throughMessageId: "loaded" });
  expect(t.readState.get("dm")).toBe(100n);
  expect(conversation.sendReadReceipt).not.toHaveBeenCalled();
  expect(await t.unreadCount(conversation)).toBe(2);
  expect(conversation.countMessages).toHaveBeenCalledWith({ contentTypes: [13, 12], excludeSenderInboxIds: ["self-inbox"], sentAfterNs: 100n });
});
it("read marking cannot borrow a loaded boundary from another conversation", async () => {
  const { t, conversation } = setup();
  t.messageCursors.set("other", { conversationId: "other-dm", at: 900n });
  await t.markRead("dm", { sendReceipt: true, throughMessageId: "other" });
  expect(t.readState.get("dm")).toBe(0n);
  expect(conversation.sendReadReceipt).not.toHaveBeenCalled();
});
