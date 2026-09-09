import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { GateRuleEditor } from '../src/views/dialogs';
it('only offers supported mainnet rule types in the production editor', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); const root = createRoot(container);
  const gating = { enableSafeRules: true, enableEnsRules: true, roleCascade: {}, powerTier: { label: 'Voting power', resolver: 'custom', tiers: [1] } } as any;
  try {
    await act(async () => root.render(React.createElement(GateRuleEditor, { rules: [], gating, production: true, onChange: vi.fn() })));
    const labels = [...container.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toEqual(['Token', 'Safe owners', 'ENS']);
    expect(container.textContent).toContain('explicit ERC-1155 token ID');
    expect(container.textContent).toContain('Safe-delegate gates are unavailable');
    await act(async () => root.render(React.createElement(GateRuleEditor, { rules: [{ kind: 'token', token: '', standard: 'erc1155', min: '1' }], gating, production: true, onChange: vi.fn() })));
    expect(container.querySelector('input[placeholder="token ID (required)"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});
