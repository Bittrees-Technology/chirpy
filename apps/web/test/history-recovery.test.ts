import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HistoryRecovery } from '../src/views/HistoryRecovery';
import { I18nProvider } from '../src/i18n';

it('requires a click, prevents duplicate requests, and reports requested rather than restored', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  let resolve!: () => void;
  const request = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  try {
    await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(HistoryRecovery, { request }))));
    expect(request).not.toHaveBeenCalled();
    await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click(); });
    expect(request).toHaveBeenCalledTimes(1); expect(host.querySelector('button')!.disabled).toBe(true);
    await act(async () => resolve());
    expect(host.querySelector('[role="status"]')!.textContent).toContain('does not confirm that all history has arrived');
    expect(host.querySelector('button')!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
it('allows retry on failure and clears a previous wallet’s pending status on remount', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const host = document.createElement('div'); const root = createRoot(host);
  let resolve!: () => void;
  const request = vi.fn().mockRejectedValueOnce(new Error('offline')).mockImplementationOnce(() => new Promise<void>(done => { resolve = done; }));
  const render = (key: string) => root.render(React.createElement(I18nProvider, null, React.createElement(HistoryRecovery, { key, request })));
  try {
    await act(async () => render('wallet-a'));
    await act(async () => host.querySelector('button')!.click());
    expect(host.querySelector('[role="alert"]')!.textContent).toContain('try again');
    await act(async () => host.querySelector('button')!.click());
    await act(async () => render('wallet-b'));
    await act(async () => resolve());
    expect(host.querySelector('[role="status"]')).toBeNull(); expect(host.querySelector('[role="alert"]')).toBeNull();
    expect(host.querySelector('button')!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
