import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Thread } from "../src/views/Thread";
const state = vi.hoisted(() => ({ send: vi.fn(), activeConversation: { id: "dm", kind: "dm", title: "Peer", peers: ["0x1", "0x2"] }, messages: [] }));
vi.mock("../src/state", () => ({ useChat: () => ({ ...state, react: vi.fn(), setRoomPolicy: vi.fn(), requestRoomJoin: vi.fn() }), useIdentity: () => ({ identity: { address: "0x1" } }) }));
vi.mock("../src/useEns", () => ({ useEnsProfiles: () => new Map(), nameFor: (_id, _record, fallback) => fallback || "Peer" }));
vi.mock("../src/i18n", () => ({ useI18n: () => ({ t: (_key, fallback) => fallback }) }));
let container; let root;
beforeEach(async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  HTMLElement.prototype.scrollIntoView = vi.fn();
  state.activeConversation = { id: "dm", kind: "dm", title: "Peer", peers: ["0x1", "0x2"] };
  state.send.mockReset(); container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  await act(async () => root.render(React.createElement(Thread)));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
async function type(value) {
  await act(async () => {
    const input = container.querySelector("input");
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function submit() { await act(async () => container.querySelector("form").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }))); }
it("retains the draft on failure and clears it only after successful retry", async () => {
  state.send.mockRejectedValueOnce(new Error("Offline")).mockResolvedValueOnce(undefined);
  await type("keep this message"); await submit();
  expect(container.querySelector("input").value).toBe("keep this message");
  expect(container.querySelector('[role="alert"]').textContent).toContain("Offline");
  await submit(); expect(container.querySelector("input").value).toBe("");
  expect(state.send).toHaveBeenCalledTimes(2);
});
it("keeps separate drafts when switching conversations", async () => {
  await type("first draft");
  state.activeConversation = { ...state.activeConversation, id: "second" };
  await act(async () => root.render(React.createElement(Thread)));
  expect(container.querySelector("input").value).toBe(""); await type("second draft");
  state.activeConversation = { ...state.activeConversation, id: "dm" };
  await act(async () => root.render(React.createElement(Thread)));
  expect(container.querySelector("input").value).toBe("first draft");
});

it("does not pull a reader away from older messages when new messages arrive", async () => {
  const history = container.querySelector('[role="region"]');
  Object.defineProperties(history, { scrollHeight: { value: 1000, configurable: true }, clientHeight: { value: 100, configurable: true }, scrollTop: { value: 0, writable: true, configurable: true } });
  await act(async () => history.dispatchEvent(new Event("scroll", { bubbles: true })));
  vi.mocked(HTMLElement.prototype.scrollIntoView).mockClear();
  state.messages = [{ id: "new", conversationId: "dm", sender: "0x2", body: "new message", sentAt: Date.now() }] as any;
  await act(async () => root.render(React.createElement(Thread)));
  expect(HTMLElement.prototype.scrollIntoView).not.toHaveBeenCalled();
  expect(container.textContent).toContain("New messages — jump to latest");
  const jump = Array.from(container.querySelectorAll("button")).find((b: any) => b.textContent.includes("jump to latest")) as HTMLElement;
  await act(async () => jump.click());
  expect(HTMLElement.prototype.scrollIntoView).toHaveBeenCalledTimes(1);
  state.messages = [];
});
