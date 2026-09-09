import { beforeEach, describe, expect, it, vi } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { createJoinHandler } from "../room-join.js";
import { resetRateLimits } from "../server-utils.js";
vi.mock("@xmtp/node-sdk", () => ({ IdentifierKind: { Ethereum: 0 } }));
const alice = privateKeyToAccount(`0x${"1".repeat(64)}`);
const mallory = privateKeyToAccount(`0x${"2".repeat(64)}`);
const gate = { combine: "all", rules: [{ kind: "token", standard: "erc721", token: alice.address, min: "1" }] };
function setup() {
  let clock = 1000;
  const addMembers = vi.fn();
  const balance = vi.fn().mockResolvedValue(1n);
  const room = { id: "room-one", namespace: "acme", title: "Members", chainId: 1, gate };
  const rooms = [room];
  const bot = { inboxId: "bot", fetchInboxIdByIdentifier: vi.fn().mockResolvedValue("alice-inbox"),
    conversations: { sync: vi.fn(), getConversationById: vi.fn().mockResolvedValue({ sync: vi.fn(), isSuperAdmin: () => true, addMembers }) } };
  const handler = createJoinHandler({ getClient: async () => bot, getRooms: async () => rooms,
    reader: () => ({ erc721Balance: balance }) as any, service: () => "https://gate.example/api/room-join", now: () => clock });
  const call = async (body) => {
    const res = { code: 0, body: null as any, setHeader() {}, status(n) { this.code = n; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method: "POST", body }, res); return res;
  };
  const challenge = async (extra = {}) => (await call({ action: "challenge", convId: room.id, namespace: room.namespace,
    address: alice.address, inboxId: "alice-inbox", ...extra })).body;
  const join = async (c, extra = {}, account = alice) => call({ action: "join", nonce: c.nonce, signature: await account.signMessage({ message: c.message }), ...extra });
  return { call, challenge, join, addMembers, balance, bot, rooms, tick: () => { clock += 300001; } };
}
beforeEach(() => { resetRateLimits(); });
describe("trusted room admission", () => {
  it("admits the qualifying wallet inbox once", async () => {
    const s = setup(); const c = await s.challenge();
    expect((await s.join(c)).code).toBe(200);
    expect(s.addMembers).toHaveBeenCalledWith(["alice-inbox"]);
    expect((await s.join(c)).code).toBe(401);
    expect(s.addMembers).toHaveBeenCalledTimes(1);
  });
  it("ignores requester-supplied rules and denies a nonholder", async () => {
    const s = setup(); s.balance.mockResolvedValue(0n);
    const c = await s.challenge();
    expect((await s.join(c, { gate: { combine: "any", rules: [] }, gating: { powerTier: {} } })).code).toBe(403);
    expect(s.addMembers).not.toHaveBeenCalled();
  });
  it("rejects a qualifying signature targeting someone else's inbox", async () => {
    const s = setup(); const c = await s.challenge({ inboxId: "mallory-inbox" });
    expect((await s.join(c)).code).toBe(403); expect(s.addMembers).not.toHaveBeenCalled();
  });
  it("rejects wrong signatures, expired challenges and unregistered rooms", async () => {
    const s = setup();
    expect((await s.join(await s.challenge(), {}, mallory)).code).toBe(403);
    const c = await s.challenge(); s.tick(); expect((await s.join(c)).code).toBe(401);
    expect((await s.call({ action: "challenge", convId: "unknown" })).code).toBe(400);
    expect(s.addMembers).not.toHaveBeenCalled();
  });
  it("binds signatures to a unique room-specific challenge", async () => {
    const s = setup(); const a = await s.challenge(); const b = await s.challenge();
    expect((await s.call({ action: "join", nonce: b.nonce, signature: await alice.signMessage({ message: a.message }) })).code).toBe(403);
    expect(a.message).toContain("Service: https://gate.example/api/room-join");
    expect(a.message).toContain("Room: room-one"); expect(s.addMembers).not.toHaveBeenCalled();
  });
  it("rechecks registry changes after issuing a challenge", async () => {
    const s = setup(); const c = await s.challenge(); s.rooms.length = 0;
    expect((await s.join(c)).code).toBe(403); expect(s.addMembers).not.toHaveBeenCalled();
  });
  it("rejects legacy reusable authorizations", async () => {
    const s = setup(); expect((await s.call({ address: alice.address, signature: "legacy", gate })).code).toBe(400);
  });
  it("catalog contains only explicitly published rooms in the requested namespace", async () => {
    const s = setup(); expect((await s.call({ action: "catalog", namespace: "other" })).body.rooms).toEqual([]);
    expect((await s.call({ action: "catalog", namespace: "acme" })).body.rooms[0].id).toBe("room-one");
  });
});
