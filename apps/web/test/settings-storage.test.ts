import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, SettingsStorageError } from '../src/settingsStorage';
const key = 'chat:settingsPrefs:v1:wallet:0x1111111111111111111111111111111111111111';
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal('localStorage', { getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value) });
});
afterEach(() => vi.unstubAllGlobals());
it('loads legacy partial preferences without rewriting them', () => {
  const raw = JSON.stringify({ readReceiptsDefault: true }); storage.set(key, raw);
  expect(loadSettings(key)).toEqual({ raw, prefs: { ...defaultSettings(), readReceiptsDefault: true }, updatedAt: 0, failed: false });
  expect(storage.get(key)).toBe(raw);
});
it('commits preferences and timestamp in one write under the compatible key', () => {
  const write = vi.spyOn(localStorage, 'setItem');
  const raw = saveSettings(key, null, { ...defaultSettings(), readReceiptsDefault: true }, 123);
  expect(write).toHaveBeenCalledTimes(1);
  expect(loadSettings(key)).toMatchObject({ raw, updatedAt: 123, failed: false, prefs: { readReceiptsDefault: true } });
});
it.each(['{broken', 'null', '[]', '{"version":2}', '{"readReceiptsDefault":"true"}', '{"readReceiptOverrides":{"rawId":true}}', '{"blocked":["invalid"]}', '{"updatedAt":-1}', '{"blocked":null}', '{"readReceiptOverrides":null}', '{"updatedAt":null}'])('preserves unreadable or unsupported record %s', raw => {
  storage.set(key, raw);
  expect(loadSettings(key)).toMatchObject({ raw, prefs: defaultSettings(), failed: true });
  expect(storage.get(key)).toBe(raw);
});
it('distinguishes missing settings from failed reads', () => {
  expect(loadSettings(key).failed).toBe(false);
  vi.spyOn(localStorage, 'getItem').mockImplementation(() => { throw new Error('Denied'); });
  expect(loadSettings(key).failed).toBe(true);
});
it('keeps the previous preference and timestamp when storage is full', () => {
  const before = saveSettings(key, null, defaultSettings(), 42);
  vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new Error('Quota'); });
  expect(() => saveSettings(key, before, { ...defaultSettings(), readReceiptsDefault: true }, 43)).toThrow(SettingsStorageError);
  expect(storage.get(key)).toBe(before);
});
it('rejects writes over another tab’s changes or deletions', () => {
  const before = saveSettings(key, null, defaultSettings(), 42);
  const after = saveSettings(key, before, { ...defaultSettings(), readReceiptsDefault: true }, 43);
  expect(() => saveSettings(key, before, defaultSettings(), 44)).toThrow(SettingsStorageError);
  expect(storage.get(key)).toBe(after);
  storage.delete(key);
  expect(() => saveSettings(key, after, defaultSettings(), 45)).toThrow(SettingsStorageError);
  expect(storage.has(key)).toBe(false);
});
it('rejects unsupported writes without truncating them', () => {
  expect(() => saveSettings(key, null, { ...defaultSettings(), blocked: Array(1001).fill('0x1111111111111111111111111111111111111111') }, 3)).toThrow();
  expect(storage.has(key)).toBe(false);
});

it('refuses writes requiring coordination when Web Locks are unavailable', async () => {
  const { withSettingsLock } = await import('../src/settingsStorage');
  Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined });
  const operation = vi.fn();
  await expect(withSettingsLock(key, operation)).rejects.toThrow(SettingsStorageError);
  expect(operation).not.toHaveBeenCalled();
});
