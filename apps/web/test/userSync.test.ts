import { describe, expect, it } from "vitest";
import { mergePayload, type SettingsSyncPayload } from "../src/userSync";

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
