import React, { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { DisplayWalletContext } from '@app/transport';
import { selectDisplayWallet, type DisplayWalletRecord } from '../../../../packages/core/src/displayWallet.js';
import { useChat, useIdentity } from '../state';
import { getProviderRevision, subscribeProvider } from '../walletProviders';
import { readDisplayWallets, publishDisplayWallet } from '../displayWallets';
import { usePublicProfiles } from '../usePublicProfiles';
import { useI18n } from '../i18n';
import { Button, Field } from '../ui';
export function DisplayWallet() {
  const { identity, mode } = useIdentity(), { transportId, transportStatus } = useChat();
  const revision = useSyncExternalStore(subscribeProvider, getProviderRevision), { t } = useI18n();
  if (mode !== 'wallet' || transportId !== 'xmtp') return null;
  return transportStatus === 'ready' ? <Editor key={`${identity.address.toLowerCase()}:${revision}`} wallet={identity.address.toLowerCase()} /> : <p>{t('displayWallet.enable')}</p>;
}
function Editor({ wallet }: { wallet: string }) {
  const { getDisplayWalletContext } = useChat(), { t } = useI18n();
  const [snapshot, setSnapshot] = useState<{ context: DisplayWalletContext; own: DisplayWalletRecord; effective?: string } | null>(null);
  const [selected, setSelected] = useState(''), [consent, setConsent] = useState(false), [working, setWorking] = useState(false), [status, setStatus] = useState('');
  const operation = useRef<AbortController | null>(null), mounted = useRef(true);
  const preview = selected || snapshot?.context.automaticWallet || snapshot?.context.inboxId;
  const profiles = usePublicProfiles([preview], Boolean(snapshot));
  const refresh = async (signal: AbortSignal) => {
    const context = await getDisplayWalletContext(); signal.throwIfAborted();
    if (context.wallet !== wallet || !context.wallets.includes(wallet) || context.wallets.length > 100) throw Error('Wallet changed');
    const records: DisplayWalletRecord[] = [];
    for (let i = 0; i < context.wallets.length; i += 50) records.push(...await readDisplayWallets(context.network, context.wallets.slice(i, i + 50), signal));
    const own = records.find(record => record.wallet === wallet); if (!own) throw Error('Missing current choice');
    const effective = selectDisplayWallet(records, context.inboxId, context.network, context.wallets);
    if (mounted.current && !signal.aborted) { setSnapshot({ context, own, effective }); setSelected(effective ?? ''); setConsent(false); }
  };
  const load = async () => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setWorking(true); setStatus('');
    try { await refresh(controller.signal); }
    catch { if (mounted.current && !controller.signal.aborted) { setSnapshot(null); setStatus('failed'); } }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current && !controller.signal.aborted) setWorking(false); }
  };
  useEffect(() => { mounted.current = true; void load(); return () => { mounted.current = false; operation.current?.abort(); operation.current = null; }; }, []);
  const save = async () => {
    if (!snapshot || !consent || operation.current) return;
    const expected = snapshot.context, displayWallet = selected || null;
    if (displayWallet && !expected.wallets.includes(displayWallet)) return;
    const controller = new AbortController(); operation.current = controller; setWorking(true); setStatus('');
    const links = async () => {
      const current = await getDisplayWalletContext(); controller.signal.throwIfAborted();
      if (current.wallet !== wallet || current.inboxId !== expected.inboxId || current.network !== expected.network || !current.wallets.includes(wallet) || displayWallet && !current.wallets.includes(displayWallet)) throw Error('Linked wallets changed');
    };
    try {
      await publishDisplayWallet({ wallet, network: expected.network, inboxId: expected.inboxId, displayWallet, revision: snapshot.own.revision }, controller.signal, links);
      await refresh(controller.signal);
      if (mounted.current && !controller.signal.aborted) setStatus('saved');
    } catch { if (mounted.current && !controller.signal.aborted) { setSnapshot(null); setConsent(false); setStatus('uncertain'); } }
    finally { if (operation.current === controller) operation.current = null; if (mounted.current && !controller.signal.aborted) setWorking(false); }
  };
  return <section className="card display-wallet" data-insights-ignore="true" aria-label={t('displayWallet.title')}>
    <h2>{t('displayWallet.title')}</h2><p>{t('displayWallet.notice')}</p>
    {snapshot && <p>{t('displayWallet.current')}: <code>{snapshot.effective || snapshot.context.automaticWallet || snapshot.context.inboxId}</code></p>}
    <Field label={t('displayWallet.select')}><select aria-label={t('displayWallet.select')} className="input" value={selected} disabled={working || !snapshot} onChange={event => { setSelected(event.target.value); setConsent(false); setStatus(''); }}>
      <option value="">{t('displayWallet.automatic')}</option>
      {snapshot?.context.wallets.map(address => <option key={address} value={address}>{address}</option>)}
    </select></Field>
    {preview && <p>{t('displayWallet.preview')}: <strong>{profiles.get(preview)?.label ?? preview}</strong> · <code>{preview}</code></p>}
    <p>{t('displayWallet.nameHint')}</p><p>{t('displayWallet.latest')}</p>
    <label><input type="checkbox" checked={consent} disabled={working || !snapshot} onChange={event => setConsent(event.target.checked)} /> {t('displayWallet.consent')}</label>
    <div className="local-actions"><Button disabled={working || !snapshot || !consent} onClick={() => void save()}>{t('displayWallet.save')}</Button><Button disabled={working} onClick={() => void load()}>{t('displayWallet.reload')}</Button></div>
    {working && <p role="status">{t('displayWallet.working')}</p>}
    {status && <p role={status === 'saved' ? 'status' : 'alert'}>{t(`displayWallet.${status}`)}</p>}
  </section>;
}
