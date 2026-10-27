import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessagingDevicesView } from '../src/views/MessagingDevices';
import { I18nProvider } from '../src/i18n';
const device = 'ab'.repeat(32);
function mount(inspect: () => Promise<any>) {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  return { host, root, render: (key = 'a') => root.render(React.createElement(I18nProvider, null, React.createElement(MessagingDevicesView, { key, inspect, initiallyOpen: true }))) };
}
it('reads only on an explicit click, coalesces clicks, and discards a result after changing wallet scope', async () => {
  let finish!: (value: any) => void;
  const inspect = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); expect(inspect).not.toHaveBeenCalled();
    await act(async () => { f.host.querySelector('button')!.click(); f.host.querySelector('button')!.click(); });
    expect(inspect).toHaveBeenCalledOnce();
    await act(async () => f.render('wallet-b'));
    await act(async () => finish({ inboxId: 'old-wallet', localInstallationId: device, installations: [{ id: device, createdAtMs: null }] }));
    expect(f.host.querySelector('[role="status"]')).toBeNull(); expect(f.host.textContent).not.toContain(device);
  } finally { await act(async () => f.root.unmount()); }
});
it('shows device identity, clock limitations and unknown dates without offering removal or registration', async () => {
  const f = mount(vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [{ id: device, createdAtMs: null }] })));
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('Registered devices: 1'); expect(f.host.textContent).toContain('This browser');
    expect(f.host.textContent).toContain('do not show last activity'); expect(f.host.textContent).toContain('Date unavailable');
    expect(f.host.textContent).toContain(device); expect(f.host.querySelectorAll('button')).toHaveLength(1);
  } finally { await act(async () => f.root.unmount()); }
});
it('clears old results and hides provider diagnostics after a failed explicit refresh', async () => {
  const inspect = vi.fn(async () => ({ inboxId: 'cd'.repeat(32), localInstallationId: null, installations: [{ id: device, createdAtMs: 1_790_000_000_000 }] }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain(device); expect(f.host.querySelector('time')).not.toBeNull();
    inspect.mockRejectedValueOnce(new Error('NEVER_INCLUDE_PRIVATE_PROVIDER_DETAILS'));
    await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.querySelector('[role="alert"]')).not.toBeNull(); expect(f.host.querySelector('[role="status"]')).toBeNull();
    expect(f.host.textContent).not.toContain(device); expect(f.host.textContent).not.toContain('NEVER_INCLUDE');
  } finally { await act(async () => f.root.unmount()); }
});
it('distinguishes an absent network inbox from a known local installation missing in its registered list', async () => {
  const inspect = vi.fn(async () => ({ inboxId: null as string | null, localInstallationId: null as string | null, installations: [] }));
  const f = mount(inspect);
  try {
    await act(async () => f.render()); await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('No registered messaging inbox');
    inspect.mockResolvedValueOnce({ inboxId: 'cd'.repeat(32), localInstallationId: device, installations: [] });
    await act(async () => f.host.querySelector('button')!.click());
    expect(f.host.textContent).toContain('not in the registered list'); expect(f.host.textContent).not.toContain('No registered messaging inbox');
  } finally { await act(async () => f.root.unmount()); }
});
