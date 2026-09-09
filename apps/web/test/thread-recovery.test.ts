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
