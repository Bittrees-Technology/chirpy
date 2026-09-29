import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { I18nProvider } from '../src/i18n';
import { GateRuleEditor } from '../src/views/dialogs';
const editor = (props: React.ComponentProps<typeof GateRuleEditor>) => React.createElement(I18nProvider, null, React.createElement(GateRuleEditor, props));
it('only offers supported mainnet rule types in the production editor', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); const root = createRoot(container);
  const gating = { enableSafeRules: true, enableEnsRules: true, roleCascade: {}, powerTier: { label: 'Voting power', resolver: 'custom', tiers: [1] } } as any;
  try {
    await act(async () => root.render(editor({ rules: [], gating, production: true, onChange: vi.fn() })));
    const labels = [...container.querySelectorAll('button')].map(button => button.textContent);
    expect(labels).toEqual(['Token', 'Safe owners', 'ENS', 'Governance role']);
    expect(container.textContent).toContain('explicit ERC-1155 token ID');
    expect(container.textContent).toContain('Safe-delegate gates are unavailable');
    await act(async () => root.render(editor({ rules: [{ kind: 'token', token: '', standard: 'erc1155', min: '1' }], gating, production: true, onChange: vi.fn() })));
    expect(container.querySelector('input[placeholder="token ID (required)"]')).not.toBeNull();
  } finally { await act(async () => root.unmount()); }
});

it('pins production role choices to Governance without silently adopting legacy roles', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container=document.createElement('div');const root=createRoot(container);const onChange=vi.fn();
  const gating={enableSafeRules:true,enableEnsRules:true,roleCascade:{}} as any;
  try {
    await act(async()=>root.render(editor({rules:[],gating,production:true,onChange})));
    await act(async()=>[...container.querySelectorAll('button')].find(b=>b.textContent==='Governance role')!.click());
    expect(onChange).toHaveBeenLastCalledWith([{kind:'role',role:'Associate',authority:'bittrees-governance'}]);
    await act(async()=>root.render(editor({rules:[{kind:'role',role:'Partner'}],gating,production:true,onChange})));
    const select=container.querySelector('select')!;
    expect(select.value).toBe('');
    expect([...select.options].filter(o=>!o.disabled).map(o=>o.value)).toEqual(['Associate','Junior Partner','Partner']);
    await act(async()=>{select.value='Partner';select.dispatchEvent(new Event('change',{bubbles:true}));});
    expect(onChange).toHaveBeenLastCalledWith([{kind:'role',role:'Partner',authority:'bittrees-governance'}]);
  } finally {await act(async()=>root.unmount());}
});
