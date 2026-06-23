import { describe, expect, it } from "vitest";
import { classifyConversation } from "../src/xmtp";

describe("classifyConversation", () => {
  const groupType = "group";

  it("classifies conversations with group metadata as rooms", () => {
    expect(classifyConversation({ metadata: { conversationType: groupType } }, groupType)).toBe("room");
  });

  it("classifies conversations with a name field as rooms", () => {
    expect(classifyConversation({ name: "general" }, groupType)).toBe("room");
  });

  it("classifies conversations without room signals as DMs", () => {
    expect(classifyConversation({ metadata: { conversationType: "dm" } }, groupType)).toBe("dm");
    expect(classifyConversation({}, groupType)).toBe("dm");
  });
});
