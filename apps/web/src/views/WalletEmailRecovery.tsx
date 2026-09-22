import React, { useEffect, useRef, useState } from 'react';
import { Button, Field } from '../ui';
import { useI18n } from '../i18n';
import { verifyRecoveryWallet } from '../recoveryWallet';
import { decryptWalletEmailArchive, encryptWalletEmailArchive, MAX_EMAIL_ARCHIVE_FILE_BYTES, type WalletEmailArchive } from '../walletEmailArchive';
import { snapshotWalletEmailRecovery, type WalletEmailSnapshot } from '../walletEmailReceipts';
import { mergeWalletEmailArchive, pruneBackedUpWalletEmailIds, removableWalletEmailIds, restoreWalletEmailArchive } from '../walletEmailArchiveStorage';
import { download } from './dialogs';

/** Parent keys this component by wallet, mode and provider revision. No mailbox network access. */
export function WalletEmailRecovery({wallet, service}: {wallet: string; service: string}) {
  const {t} = useI18n();
  const [expanded, setExpanded] = useState(false);
  const [password, setPassword] = useState(''), [confirmation, setConfirmation] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [review, setReview] = useState<{data: WalletEmailArchive; snapshot: WalletEmailSnapshot} | null>(null);
  const [backup, setBackup] = useState<WalletEmailSnapshot | null>(null), [saved, setSaved] = useState(false);
  const [status, setStatus] = useState(''), [working, setWorking] = useState(false);
  const operation = useRef<AbortController | null>(null), active = useRef(true), latest = useRef('');
  const scope = JSON.stringify([wallet, service]); latest.current = scope;
  useEffect(() => { active.current = true; return () => { active.current = false; operation.current?.abort(); }; }, []);
  const validPassword = password.length >= 12 && password.length <= 1024 && Boolean(password.trim());
  const ensureCurrent = () => {
    if (!active.current || latest.current !== scope || operation.current?.signal.aborted) throw new Error('Recovery session changed');
  };
  const run = async (purpose: 'export' | 'restore', action: (proof: Awaited<ReturnType<typeof verifyRecoveryWallet>>, signal: AbortSignal) => Promise<void>) => {
    if (operation.current) return;
    const controller = new AbortController(); operation.current = controller; setWorking(true); setStatus('');
    let proof: Awaited<ReturnType<typeof verifyRecoveryWallet>> | undefined;
    try {
      proof = await verifyRecoveryWallet(wallet, ensureCurrent, purpose);
      await action(proof, controller.signal);
    } catch {
      if (active.current && latest.current === scope) { setStatus('failed'); setReview(null); setBackup(null); setSaved(false); }
    } finally {
      proof?.dispose(); operation.current = null;
      if (active.current && latest.current === scope) { setWorking(false); setPassword(''); setConfirmation(''); }
    }
  };
  const exportIds = () => {
    if (!validPassword || password !== confirmation || operation.current) return;
    setBackup(null); setSaved(false); setReview(null);
    void run('export', async proof => {
      const snapshot = snapshotWalletEmailRecovery(wallet, service);
      const data: WalletEmailArchive = {version: 1, wallet, service, createdAt: Date.now(), active: snapshot.state.active,
        ids: snapshot.state.receipts.map(item => item.id)};
      const archive = await encryptWalletEmailArchive(data, password);
      // Verify the generated file before offering removal. A download request is not proof of a saved file.
      if (JSON.stringify(await decryptWalletEmailArchive(archive, password, wallet, service)) !== JSON.stringify(data)) throw new Error('Backup verification failed');
      await proof.assertCurrent(); ensureCurrent();
      if (snapshotWalletEmailRecovery(wallet, service).revision !== snapshot.revision) throw new Error('Saved requests changed');
      download('chat-email-request-recovery.json', archive);
      setBackup(snapshot); setStatus('prepared');
    });
  };
  const unlock = () => {
    if (!validPassword || !file || file.size > MAX_EMAIL_ARCHIVE_FILE_BYTES || operation.current) return;
    setReview(null); setBackup(null); setSaved(false);
    void run('restore', async proof => {
      const data = await decryptWalletEmailArchive(await file.text(), password, wallet, service);
      await proof.assertCurrent(); ensureCurrent();
      const snapshot = snapshotWalletEmailRecovery(wallet, service);
      mergeWalletEmailArchive(snapshot, data, wallet, service); // Check capacity before review; no writes.
      setReview({data, snapshot}); setStatus('review');
    });
  };
  const apply = () => {
    if (!review) return;
    void run('restore', async (proof, signal) => {
      await proof.assertCurrent();
      await restoreWalletEmailArchive(review.data, wallet, service, review.snapshot.revision, () => { ensureCurrent(); proof.assertSession(); }, signal);
      ensureCurrent(); setReview(null); setStatus('restored');
    });
  };
  const prune = () => {
    if (!backup || !saved) return;
    void run('restore', async (proof, signal) => {
      await proof.assertCurrent();
      await pruneBackedUpWalletEmailIds(wallet, service, backup.revision, () => { ensureCurrent(); proof.assertSession(); }, signal);
      ensureCurrent(); setBackup(null); setSaved(false); setStatus('pruned');
    });
  };
  return <details className="email-recovery" data-insights-ignore="true" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{t('mailRecovery.title')}</summary>
    {expanded && <>
      <p>{t('mailRecovery.scope')}</p>
      <p className="muted">{t('mailRecovery.passwordHelp')}</p>
      <Field label={t('mailRecovery.password')}><input className="input" type="password" autoComplete="new-password" maxLength={1024}
        value={password} disabled={working} onChange={event => { setPassword(event.target.value); setReview(null); }} /></Field>
      <Field label={t('recovery.confirmPassword')}><input className="input" type="password" autoComplete="new-password" maxLength={1024}
        value={confirmation} disabled={working} onChange={event => setConfirmation(event.target.value)} /></Field>
      <Button disabled={working || !validPassword || password !== confirmation} onClick={exportIds}>{t('mailRecovery.export')}</Button>
      <Field label={t('mailRecovery.file')} hint={t('mailRecovery.fileHint')}><input className="input" type="file" accept=".json,application/json" disabled={working}
        onChange={event => { setFile(event.target.files?.[0] ?? null); setReview(null); setStatus(''); }} /></Field>
      {file && file.size > MAX_EMAIL_ARCHIVE_FILE_BYTES && <p role="alert">{t('mailRecovery.tooLarge')}</p>}
      <Button disabled={working || !validPassword || !file || file.size > MAX_EMAIL_ARCHIVE_FILE_BYTES} onClick={unlock}>{t('mailRecovery.unlock')}</Button>
      {review && <section aria-label={t('mailRecovery.review')}>
        <p>{t('mailRecovery.reviewCount', undefined, {count: String(review.data.ids.length)})}</p>
        <p>{t('mailRecovery.reviewHint')}</p>
        <ul>{review.data.ids.map(id => <li key={id}><code>{id}</code></li>)}</ul>
        <Button disabled={working} onClick={apply}>{t('mailRecovery.restore')}</Button>{' '}
        <Button disabled={working} onClick={() => { setReview(null); setStatus(''); }}>{t('dialog.cancel')}</Button>
      </section>}
      {backup && removableWalletEmailIds(backup).length > 0 && <section>
        <p>{t('mailRecovery.pruneHint', undefined, {count: String(removableWalletEmailIds(backup).length)})}</p>
        <label><input type="checkbox" checked={saved} disabled={working} onChange={event => setSaved(event.target.checked)} /> {t('mailRecovery.saved')}</label>
        <p><Button disabled={working || !saved} onClick={prune}>{t('mailRecovery.prune')}</Button></p>
      </section>}
      {working && <p role="status">{t('mailRecovery.working')}</p>}
      {status && status !== 'review' && <p role={status === 'failed' ? 'alert' : 'status'}>{t(`mailRecovery.${status}`)}</p>}
    </>}
  </details>;
}
