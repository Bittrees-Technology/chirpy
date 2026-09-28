import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { MessagingDiagnosticsView } from '../src/views/MessagingDiagnostics';
import { I18nProvider } from '../src/i18n';
it('requires an explicit click, coalesces clicks and discards results after a wallet remount', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  let finish!: (value: any) => void;
  const inspect = vi.fn(() => new Promise<any>(resolve => { finish = resolve; }));
  const host = document.createElement('div'); const root = createRoot(host);
  const render = (key: string) => root.render(React.createElement(I18nProvider, null, React.createElement(MessagingDiagnosticsView, { key, inspect })));
  try {
    await act(async () => render('a')); expect(inspect).not.toHaveBeenCalled();
    await act(async () => { host.querySelector('button')!.click(); host.querySelector('button')!.click(); });
    expect(inspect).toHaveBeenCalledTimes(1);
    await act(async () => render('b'));
    await act(async () => finish({ inboxId: 'old-wallet' }));
    expect(host.querySelector('[role="status"]')).toBeNull();
    expect(host.textContent).not.toContain('old-wallet');
    expect(host.querySelector('button')!.disabled).toBe(false);
  } finally { await act(async () => root.unmount()); }
});
