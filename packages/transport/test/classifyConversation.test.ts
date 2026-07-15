import { describe, expect, it } from "vitest";
import type { Conversation } from "../src/types";
import {
  classifyConversation,
  dedupeSeedRooms,
  isSeedRoomTitle,
  seedRoomTitles,
} from "../src/xmtp";

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

describe("seed room detection", () => {
  it("falls back to a canonical 'general' seed title when no default rooms are configured", () => {
    expect(seedRoomTitles({ defaultRooms: [] })).toEqual(new Set(["general"]));
    expect(
      seedRoomTitles({
        defaultRooms: [
          { id: "r1", title: "General", gate: { combine: "any", rules: [] } },
          { id: "r2", title: "#Announcements", gate: { combine: "any", rules: [] } },
        ],
      }),
    ).toEqual(new Set(["general", "announcements"]));
  });

  it("matches legacy seed rooms regardless of casing or a leading '#'", () => {
    const seeds = seedRoomTitles({ defaultRooms: [] });
    expect(isSeedRoomTitle("general", seeds)).toBe(true);
    expect(isSeedRoomTitle("#general", seeds)).toBe(true);
    expect(isSeedRoomTitle("  General  ", seeds)).toBe(true);
    expect(isSeedRoomTitle("random", seeds)).toBe(false);
  });
});

describe("dedupeSeedRooms", () => {
  const room = (id: string, title: string, sentAt?: number): Conversation => ({
    id,
    kind: "room",
    title,
    peers: [],
    unread: 0,
    ...(sentAt === undefined
      ? {}
      : { lastMessage: { id: `m-${id}`, conversationId: id, sender: "0x", body: "hi", sentAt } }),
  });
  const dm = (id: string): Conversation => ({ id, kind: "dm", title: "peer", peers: [], unread: 0 });

  it("collapses duplicate seed rooms to the most recently active one and leaves others untouched", () => {
    const seeds = seedRoomTitles({ defaultRooms: [] });
    const input: Conversation[] = [
      room("a", "general", 100),
      dm("dm1"),
      room("b", "#general", 300),
      room("c", "General", 200),
      room("d", "random"),
    ];
    const result = dedupeSeedRooms(input, seeds);
    const generals = result.filter((c) => c.kind === "room" && c.title.toLowerCase().includes("general"));
    expect(generals).toHaveLength(1);
    expect(generals[0].id).toBe("b"); // sentAt 300 wins
    expect(result.map((c) => c.id)).toEqual(expect.arrayContaining(["dm1", "d"]));
    expect(result).toHaveLength(3); // one general + dm + random room
  });
});
