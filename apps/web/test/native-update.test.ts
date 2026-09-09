import { afterEach, expect, it, vi } from 'vitest';
import { autoUpdateOnLaunch, isDesktopApp, runUpdate } from '../src/update';
const check = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/plugin-updater', () => ({ check }));
afterEach(() => { vi.unstubAllEnvs(); delete (window as any).__TAURI_INTERNALS__; vi.clearAllMocks(); });
it.each(['ios', 'android', ''])('does not invoke desktop update APIs on %s', async platform => {
  (window as any).__TAURI_INTERNALS__ = {}; vi.stubEnv('VITE_NATIVE_PLATFORM', platform);
  expect(isDesktopApp()).toBe(false); const status = vi.fn();
  expect(await runUpdate(status)).toBe(false); expect(status).toHaveBeenCalledWith({ state: 'unsupported' }); expect(check).not.toHaveBeenCalled();
});
it.each(['darwin', 'windows', 'linux'])('checks without silently installing or restarting on %s', async platform => {
  (window as any).__TAURI_INTERNALS__ = {}; vi.stubEnv('VITE_NATIVE_PLATFORM', platform);
  const install = vi.fn(); check.mockResolvedValue({ version: '1.0.0', downloadAndInstall: install });
  expect(isDesktopApp()).toBe(true); await autoUpdateOnLaunch(); expect(check).toHaveBeenCalledTimes(1); expect(install).not.toHaveBeenCalled();
});
