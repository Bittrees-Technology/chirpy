import { expect, it, vi } from "vitest";
import { XmtpTransport } from "../src/xmtp";
import { PERSONAL_ORG } from "@app/core";
const address = "0x0000000000000000000000000000000000000001";
const sdk = { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 }, ConversationType: { Group: "group" }, isText: () => true, isTextReply: () => false };
function setup(state = 0) {
  const t = new XmtpTransport(PERSONAL_ORG, { address }, null) as any;
  let consent = state;
  const conversation = { id: "dm", metadata: { conversationType: "dm" },
    consentState: vi.fn(async () => consent), updateConsentState: vi.fn(async (value) => { consent = value; }),
    sendText: vi.fn(async () => "message"), sendReaction: vi.fn(), sendReadReceipt: vi.fn(), messages: vi.fn(async () => []), sync: vi.fn() };
  t.sdk = sdk; t.status = "ready"; t.conversations.set("dm", conversation);
  return { t, conversation };
}
it.each([0, 2])("consent %s prevents sends, reactions and read receipts at transport level", async (state) => {
  const { t, conversation } = setup(state);
  await expect(t.send("dm", "hello")).rejects.toThrow("Accept or unblock");
  await expect(t.react("dm", "message", "👍")).rejects.toThrow("Accept or unblock");
  await t.markRead("dm", { sendReceipt: true });
  expect(conversation.sendText).not.toHaveBeenCalled();
  expect(conversation.sendReaction).not.toHaveBeenCalled();
  expect(conversation.sendReadReceipt).not.toHaveBeenCalled();
});
it("explicit accept, block and unblock persist through the SDK", async () => {
  const { t, conversation } = setup();
  await t.setConversationConsent("dm", "allowed");
  await t.send("dm", "hello");
  expect(conversation.sendText).toHaveBeenCalledWith("hello");
  await t.setConversationConsent("dm", "denied");
  await expect(t.send("dm", "blocked")).rejects.toThrow();
  expect(await t.listMessages("dm")).toEqual([]);
  expect(conversation.messages).not.toHaveBeenCalled();
  await t.setConversationConsent("dm", "allowed");
  await t.send("dm", "back");
  expect(conversation.updateConsentState.mock.calls).toEqual([[1], [2], [1]]);
});
it("unknown or unavailable consent fails closed", async () => {
  const { t, conversation } = setup();
  conversation.consentState.mockRejectedValue(new Error("consent unavailable"));
  await expect(t.send("dm", "hello")).rejects.toThrow("consent unavailable");
  expect(conversation.sendText).not.toHaveBeenCalled();
});
it("failed consent changes do not report success or send", async () => {
  const { t, conversation } = setup();
  conversation.updateConsentState.mockRejectedValue(new Error("offline"));
  await expect(t.setConversationConsent("dm", "allowed")).rejects.toThrow("offline");
  await expect(t.send("dm", "hello")).rejects.toThrow("Accept or unblock");
});
