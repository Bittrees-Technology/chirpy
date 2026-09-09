import { afterEach, describe, expect, it, vi } from "vitest";
import { mergePayload, pullRemoteBlob, pushBlob, type SettingsSyncPayload } from "../src/userSync";

const payload = (overrides: Partial<SettingsSyncPayload>): SettingsSyncPayload => ({
  version: 1,
  settingsPrefs: {
    readReceiptsDefault: false,
    syncAcrossDevices: true,
    blocked: [],
  },
  savedMessages: [],
  updatedAt: 1,
  ...overrides,
});

describe("mergePayload", () => {
  it("unions saved messages by id, unions blocked addresses lowercased, and keeps newer scalar prefs", () => {
    const local = payload({
      settingsPrefs: {
        readReceiptsDefault: false,
        syncAcrossDevices: true,
        blocked: ["0xABC", "0xdef"],
      },
      savedMessages: [
        { id: "one", body: "local" },
        { id: "dupe", body: "older", updatedAt: 1 },
      ],
      updatedAt: 10,
    });
    const remote = payload({
      settingsPrefs: {
        readReceiptsDefault: true,
        syncAcrossDevices: false,
        blocked: ["0xabc", "0x123"],
      },
      savedMessages: [
        { id: "dupe", body: "newer", updatedAt: 20 },
        { id: "two", body: "remote" },
      ],
      updatedAt: 20,
    });

    expect(mergePayload(local, remote)).toEqual({
      version: 1,
      settingsPrefs: {
        readReceiptsDefault: true,
        syncAcrossDevices: false,
        blocked: ["0x123", "0xabc", "0xdef"],
        readReceiptOverrides: {},
      },
      savedMessages: [
        { id: "dupe", body: "newer", updatedAt: 20 },
        { id: "one", body: "local", updatedAt: 10 },
        { id: "two", body: "remote", updatedAt: 20 },
      ],
      updatedAt: 20,
    });
  });

  it("keeps local scalar prefs when local is newer", () => {
    const local = payload({
      settingsPrefs: { readReceiptsDefault: true, syncAcrossDevices: false, blocked: [] },
      updatedAt: 30,
    });
    const remote = payload({
      settingsPrefs: { readReceiptsDefault: false, syncAcrossDevices: true, blocked: [] },
      updatedAt: 20,
    });

    expect(mergePayload(local, remote).settingsPrefs).toMatchObject({
      readReceiptsDefault: true,
      syncAcrossDevices: false,
    });
  });
});


afterEach(() => vi.unstubAllGlobals());
it("requires a successful read and carries its revision on writes", async () => {
  const address = "new-device"; const blob = { updatedAt: 10 } as any;
  const authorization = { grant: { version: 2, address, device: "0x0000000000000000000000000000000000000001", issuedAt: Date.now(), epoch: 0, service: new URL("/api/usersync", window.location.href).href, expiresAt: Date.now() + 10000 }, sign: async () => "signature" } as any;
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ blob: null, revision: 4, authVersion: 2, epoch: 0, service: new URL("/api/usersync", window.location.href).href }) })
    .mockResolvedValueOnce({ ok: false, status: 409 });
  vi.stubGlobal("fetch", fetcher);
  expect(await pushBlob(address, authorization, blob)).toEqual({ ok: false, stale: true });
  expect(fetcher).not.toHaveBeenCalled();
  await pullRemoteBlob(address); await pushBlob(address, authorization, blob);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).expectedRevision).toBe(4);
});
it("does not interpret an unavailable store as empty", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  await expect(pullRemoteBlob("offline-device")).rejects.toThrow("Unable to read");
  expect(await pushBlob("offline-device", null as any, {} as any)).toEqual({ ok: false, stale: true });
});

it("keeps the newer receipt override map including removals instead of resurrecting old opt-ins", () => {
  const older = payload({ settingsPrefs: { readReceiptsDefault: false, syncAcrossDevices: true, blocked: [], readReceiptOverrides: { "xmtp:production:dm": true } }, updatedAt: 1 });
  const newer = payload({ settingsPrefs: { readReceiptsDefault: false, syncAcrossDevices: true, blocked: [], readReceiptOverrides: {} }, updatedAt: 2 });
  expect(mergePayload(older, newer).settingsPrefs.readReceiptOverrides).toEqual({});
  expect(mergePayload(newer, older).settingsPrefs.readReceiptOverrides).toEqual({});
});


describe("offline merge convergence", () => {
  const snapshot = (flag: boolean, body: string, updatedAt = 10) => payload({
    updatedAt,
    settingsPrefs: { readReceiptsDefault: flag, syncAcrossDevices: flag, blocked: [], readReceiptOverrides: { room: flag } },
    savedMessages: [{ id: "same", body, updatedAt }],
  });

  it("converges equal-time preferences and message conflicts in either direction", () => {
    const a = snapshot(true, "alpha");
    const b = snapshot(false, "beta");
    const merged = mergePayload(a, b);
    expect(merged).toEqual(mergePayload(b, a));
    expect(merged.settingsPrefs).toMatchObject({ readReceiptsDefault: false, syncAcrossDevices: false, readReceiptOverrides: { room: false } });
    expect(mergePayload(merged, a)).toEqual(merged);
    expect(mergePayload(merged, b)).toEqual(merged);
  });

  it("retains legacy message timestamps across later merges", () => {
    const old = payload({ updatedAt: 10, savedMessages: [{ id: "note", body: "old" }] });
    const unrelated = payload({ updatedAt: 30 });
    const edited = payload({ updatedAt: 20, savedMessages: [{ id: "note", body: "edited" }] });
    const merged = mergePayload(mergePayload(old, unrelated), edited);
    expect(merged.savedMessages).toEqual([{ id: "note", body: "edited", updatedAt: 20 }]);
    expect(merged).toEqual(mergePayload(old, mergePayload(unrelated, edited)));
  });

  it("resolves duplicate IDs by message time within either snapshot", () => {
    const duplicates = payload({ savedMessages: [{ id: "note", body: "new", updatedAt: 20 }, { id: "note", body: "old", updatedAt: 10 }] });
    expect(mergePayload(duplicates, payload({})).savedMessages[0].body).toBe("new");
    expect(mergePayload(payload({}), duplicates).savedMessages[0].body).toBe("new");
  });

  it("converges after repeated three-device exchanges and JSON round trips", () => {
    const devices = [snapshot(true, "a"), snapshot(false, "b"), snapshot(true, "c")];
    devices[0].settingsPrefs.blocked = ["0xBBB"];
    devices[1].settingsPrefs.blocked = ["0xAAA"];
    delete devices[2].settingsPrefs.readReceiptOverrides;
    const expected = mergePayload(mergePayload(devices[0], devices[1]), devices[2]);
    for (const [a, b, c] of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
      const merged = mergePayload(devices[a], mergePayload(devices[b], devices[c]));
      expect(merged).toEqual(expected);
      expect(mergePayload(JSON.parse(JSON.stringify(merged)), devices[a])).toEqual(expected);
    }
  });
});


it("uses object-order-independent message tie breaking without mutating snapshots", () => {
  const a = payload({ savedMessages: [{ id: "note", detail: { a: 1, b: 2 }, body: "alpha" }] });
  const b = payload({ savedMessages: [{ body: "beta", detail: { b: 2, a: 1 }, id: "note" }] });
  const before = JSON.stringify([a, b]);
  const merged = mergePayload(a, b);
  expect(merged).toEqual(mergePayload(b, a));
  expect(JSON.stringify([a, b])).toBe(before);
  expect(mergePayload(merged, merged)).toEqual(merged);
});

it("does not revive a receipt opt-in when an equal-time device removed the override", () => {
  const a = payload({ settingsPrefs: { readReceiptsDefault: true, syncAcrossDevices: true, blocked: [], readReceiptOverrides: { room: true } } });
  const b = payload({ settingsPrefs: { readReceiptsDefault: true, syncAcrossDevices: true, blocked: [], readReceiptOverrides: {} } });
  expect(mergePayload(a, b).settingsPrefs.readReceiptOverrides).toEqual({ room: false });
  expect(mergePayload(b, a)).toEqual(mergePayload(a, b));
});


it("converges mixed-age offline snapshots across exchange groupings", () => {
  const choices = [undefined, {}, { room: true }, { room: false }];
  const snapshots = Array.from({ length: 24 }, (_, i) => payload({
    updatedAt: i % 3,
    settingsPrefs: { readReceiptsDefault: i % 2 === 0, syncAcrossDevices: i % 4 === 0, blocked: [String(i % 3)], readReceiptOverrides: choices[i % choices.length] },
    savedMessages: [{ id: String(i % 2), body: String(i), ...(i % 2 ? { updatedAt: i % 5 } : {}) }],
  }));
  for (const a of snapshots) for (const b of snapshots) {
    const merged = mergePayload(a, b);
    expect(merged).toEqual(mergePayload(b, a));
    expect(mergePayload(merged, merged)).toEqual(merged);
    const c = snapshots[(a.updatedAt + b.updatedAt + 7) % snapshots.length];
    expect(mergePayload(merged, c)).toEqual(mergePayload(a, mergePayload(b, c)));
  }
});
