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
        blocked: ["0xabc", "0xdef", "0x123"],
      },
      savedMessages: [
        { id: "one", body: "local" },
        { id: "dupe", body: "newer", updatedAt: 20 },
        { id: "two", body: "remote" },
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
  const fetcher = vi.fn().mockResolvedValueOnce({ ok: true, json: async () => ({ blob: null, revision: 4 }) })
    .mockResolvedValueOnce({ ok: false, status: 409 });
  vi.stubGlobal("fetch", fetcher);
  expect(await pushBlob(address, "sig", blob)).toEqual({ ok: false, stale: true });
  expect(fetcher).not.toHaveBeenCalled();
  await pullRemoteBlob(address); await pushBlob(address, "sig", blob);
  expect(JSON.parse(fetcher.mock.calls[1][1].body).expectedRevision).toBe(4);
});
it("does not interpret an unavailable store as empty", async () => {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
  await expect(pullRemoteBlob("offline-device")).rejects.toThrow("Unable to read");
  expect(await pushBlob("offline-device", "sig", {} as any)).toEqual({ ok: false, stale: true });
});
