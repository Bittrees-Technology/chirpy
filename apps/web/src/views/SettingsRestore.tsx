import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useI18n } from '../i18n';
import { useSettingsPrefs } from '../state';
import { Button, Field } from '../ui';
import { decryptRecoveryArchive, encryptRecoveryArchive, MAX_RECOVERY_FILE_BYTES, validateRecoveryData, type RecoveryData } from '../recoveryArchive';
import { readLocalData, type LocalData } from '../localData';
import { planLocalRecovery, planRecoveryPreferences } from '../recoveryMerge';
import { abandonRecovery, backupArchive, clearUnpreparedRecovery, continueRecovery, discardRecoveryBackup, prepareRecovery, readRecoveryJournal, recoveryPending, type RecoveryJournal } from '../recoveryJournal';
import { loadSettings, parseSettingsRaw, walletSettingsKey } from '../settingsStorage';
import { verifyRecoveryWallet } from '../recoveryWallet';
import { download } from './dialogs';
import { parseWalletLabelRaw, readWalletLabelRaw } from '../walletProfile';

type Review = { incoming: RecoveryData; local: LocalData; prefsRaw: string | null; labelRaw?: string | null };
export function SettingsRestore({ wallet }: { wallet: string }) {
  const { t } = useI18n();
  const { pauseSyncForRecovery, refreshAfterRecovery } = useSettingsPrefs();
  const [file, setFile] = useState<File | null>(null);
  const [password, setPassword] = useState('');
  const [backupPassword, setBackupPassword] = useState('');
  const [backupConfirmation, setBackupConfirmation] = useState('');
  const [review, setReview] = useState<Review | null>(null);
  const [replace, setReplace] = useState<string[]>([]);
  const [restoreReceipts, setRestoreReceipts] = useState(false);
  const [addLegacyBlocks, setAddLegacyBlocks] = useState(false);
  const [restoreLabel, setRestoreLabel] = useState(false);
  const [journal, setJournal] = useState<RecoveryJournal | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(true);
  const [status, setStatus] = useState<'idle' | 'failed' | 'applied' | 'undone' | 'downloaded' | 'abandoned'>('idle');
  const generation = useRef(0); const running = useRef(false);
  const ensure = (value: number) => { if (generation.current !== value) throw new Error('Recovery view changed'); };
  const refresh = async (value: number) => {
    const next = await readRecoveryJournal(wallet); ensure(value);
    setJournal(next); setPending(recoveryPending(wallet));
  };
  useEffect(() => {
    const value = ++generation.current;
    void refresh(value).catch(() => { if (generation.current === value) setStatus('failed'); })
      .finally(() => { if (generation.current === value) setBusy(false); });
    return () => { generation.current++; };
  }, [wallet]);
  const plan = useMemo(() => {
    if (!review) return null;
    try {
      const choices = replace.map(key => ({ kind: key.startsWith('contact:') ? 'contact' as const : 'note' as const, id: key.slice(key.indexOf(':') + 1) }));
      const local = planLocalRecovery(review.local, review.incoming, choices);
      const prefs = parseSettingsRaw(review.prefsRaw).prefs;
      const current = { blocked: prefs.blocked, readReceiptsDefault: prefs.readReceiptsDefault, readReceiptOverrides: prefs.readReceiptOverrides ?? {} };
      const preferences = planRecoveryPreferences(wallet, current, review.incoming, { restoreReceipts, addLegacyBlocks });
      const labelChange = restoreLabel && review.incoming.version === 2
        ? { before: review.labelRaw!, after: review.incoming.localDisplayName === null ? null : JSON.stringify(review.incoming.localDisplayName) } : undefined;
      validateRecoveryData({ ...review.incoming, contacts: local.data.contacts, notes: local.data.notes, preferences });
      return { local, preferences, current, labelChange, changed: local.addedContacts + local.addedNotes + local.replaced > 0 || JSON.stringify(current) !== JSON.stringify(preferences)
        || Boolean(labelChange && parseWalletLabelRaw(labelChange.before) !== parseWalletLabelRaw(labelChange.after)) };
    } catch { return null; }
  }, [review, replace, restoreReceipts, addLegacyBlocks, restoreLabel, wallet]);
  const run = async (operation: (proof: Awaited<ReturnType<typeof verifyRecoveryWallet>>, value: number) => Promise<void>, purpose: 'export' | 'restore' = 'restore') => {
    if (running.current) return;
    running.current = true; setBusy(true); setStatus('idle'); const value = generation.current;
    let proof: Awaited<ReturnType<typeof verifyRecoveryWallet>> | undefined;
    try {
      proof = await verifyRecoveryWallet(wallet, () => ensure(value), purpose);
      await operation(proof, value);
    } catch { if (generation.current === value) setStatus('failed'); }
    finally {
      proof?.dispose(); running.current = false;
      if (generation.current === value) {
        setPassword(''); setBackupPassword(''); setBackupConfirmation('');
        try { await refresh(value); } catch { if (generation.current === value) setStatus('failed'); }
        if (generation.current === value) setBusy(false);
      }
    }
  };
  const unlock = () => {
    if (!file || file.size > MAX_RECOVERY_FILE_BYTES || password.length < 12 || password.length > 1024) { setStatus('failed'); return; }
    void run(async (proof, value) => {
      const incoming = await decryptRecoveryArchive(await file.text(), password, wallet);
      const local = await readLocalData(wallet);
      const prefs = loadSettings(walletSettingsKey(wallet));
      await proof.assertCurrent(); ensure(value);
      if (prefs.failed || recoveryPending(wallet) || await readRecoveryJournal(wallet)) throw new Error('Resolve existing recovery first');
      const labelRaw = incoming.version === 2 ? readWalletLabelRaw(wallet) : undefined;
      proof.assertSession(); setReplace([]); setRestoreReceipts(false); setAddLegacyBlocks(false); setRestoreLabel(false);
      setReview({ incoming, local, prefsRaw: prefs.raw, labelRaw });
    });
  };
  const apply = () => {
    if (!review || !plan?.changed) return;
    void run(async (proof) => {
      pauseSyncForRecovery();
      try {
        const prepared = await prepareRecovery(wallet, review.local, review.prefsRaw, plan.local.data, plan.preferences, review.incoming.source, proof.assertSession, plan.labelChange);
        await proof.assertCurrent();
        await continueRecovery(wallet, prepared.id, false, proof.assertSession);
        refreshAfterRecovery(); setReview(null); setStatus('applied');
      } finally { if (!recoveryPending(wallet)) refreshAfterRecovery(); }
    });
  };
  const reconcile = (undo: boolean) => {
    if (!journal) return;
    if (undo && !window.confirm(t('restore.undoConfirm'))) return;
    void run(async proof => {
      pauseSyncForRecovery();
      try {
        await continueRecovery(wallet, journal.id, undo, proof.assertSession);
        refreshAfterRecovery(); setStatus(undo ? 'undone' : 'applied');
      } finally { if (!recoveryPending(wallet)) refreshAfterRecovery(); }
    });
  };
  const abandon = () => {
    if (!journal || !window.confirm(t('restore.abandonConfirm'))) return;
    void run(async proof => {
      pauseSyncForRecovery();
      await abandonRecovery(wallet, journal.id, proof.assertSession);
      refreshAfterRecovery(); setStatus('abandoned');
    });
  };
  const validBackupPassword = backupPassword.length >= 12 && backupPassword.length <= 1024 && Boolean(backupPassword.trim()) && backupPassword === backupConfirmation;
  return <section className="card" data-insights-ignore="true" aria-label={t('restore.title')}>
    <h2>{t('restore.title')}</h2>
    <p className="muted">{t('restore.help')}</p>
    {busy && <p role="status">{t('restore.working')}</p>}
    {status === 'failed' && <p role="alert">{t('restore.failed')}</p>}
    {['applied', 'undone', 'downloaded', 'abandoned'].includes(status) && <p role="status">{t(`restore.${status}`)}</p>}
    {pending && <p role="alert">{t('restore.pending')}</p>}
    {journal ? <>
      <p>{t('restore.backupHeld')}</p>
      {(pending || journal.phase === 'prepared' || journal.phase === 'undoing') && <Button disabled={busy} onClick={() => journal.phase === 'abandoned' ? abandon() : reconcile(journal.phase === 'undoing' || journal.phase === 'undone')}>{t('restore.resume')}</Button>}
      {!['undone', 'abandoned'].includes(journal.phase) && <Button disabled={busy} onClick={() => reconcile(true)}>{t('restore.undo')}</Button>}
      {pending && <Button disabled={busy} onClick={abandon}>{t('restore.abandon')}</Button>}
      <details><summary>{t('restore.backupExport')}</summary>
        <p className="field-hint">{t('restore.backupHelp')}</p>
        <Field label={t('restore.backupPassword')}><input className="input" type="password" autoComplete="new-password" maxLength={1024} value={backupPassword} disabled={busy} onChange={event => setBackupPassword(event.target.value)} /></Field>
        <Field label={t('restore.backupConfirm')}><input className="input" type="password" autoComplete="new-password" maxLength={1024} value={backupConfirmation} disabled={busy} onChange={event => setBackupConfirmation(event.target.value)} /></Field>
        <Button disabled={busy || !validBackupPassword} onClick={() => { void run(async proof => {
          const fresh = await readRecoveryJournal(wallet);
          if (!fresh || fresh.id !== journal.id) throw new Error('Backup changed');
          const raw = await encryptRecoveryArchive(backupArchive(fresh), backupPassword);
          await proof.assertCurrent(); download('chat-before-restore.json', raw); setStatus('downloaded');
        }, 'export'); }}>{t('restore.downloadBackup')}</Button>
      </details>
      {!pending && ['applied', 'undone', 'abandoned'].includes(journal.phase) && <Button variant="danger" disabled={busy} onClick={() => {
        if (!window.confirm(t('restore.discardConfirm'))) return;
        void run(async proof => { await discardRecoveryBackup(wallet, journal.id, proof.assertSession); });
      }}>{t('restore.discard')}</Button>}
    </> : pending ? <Button disabled={busy} onClick={() => { void run(async proof => {
      await clearUnpreparedRecovery(wallet, proof.assertSession); refreshAfterRecovery();
    }); }}>{t('restore.clearPreparation')}</Button> : <>
      <Field label={t('restore.file')}><input className="input" type="file" accept=".json,application/json" disabled={busy} onChange={event => { setFile(event.target.files?.[0] ?? null); setReview(null); setStatus('idle'); }} /></Field>
      {!review ? <>
        <Field label={t('restore.password')}><input className="input" type="password" autoComplete="off" maxLength={1024} value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></Field>
        <Button disabled={busy || !file || password.length < 12} onClick={unlock}>{t('restore.review')}</Button>
      </> : <>
        <h3>{t('restore.reviewTitle')}</h3>
        <p>{t('restore.claimedSource')}: {review.incoming.source === 'chirpy' ? 'Chat' : review.incoming.source === 'governance' ? 'Governance' : 'Research'}. {t('restore.sourceWarning')}</p>
        <p>{t('restore.newContacts')}: {plan?.local.addedContacts ?? '—'} · {t('restore.newNotes')}: {plan?.local.addedNotes ?? '—'}</p>
        <details><summary>{t('restore.inspectFile')}</summary>
          <ul className="local-items">{review.incoming.contacts.map(contact => <li key={contact.address}>{contact.address}: {contact.label}</li>)}</ul>
          <ul className="local-items">{review.incoming.notes.map(note => <li key={note.id}><strong>{note.id}</strong><p className="restore-text">{note.text}</p></li>)}</ul>
        </details>
        <p>{t('restore.conflictsHelp')}</p>
        {plan?.local.conflicts.map(conflict => {
          const key = `${conflict.kind}:${conflict.id}`;
          return <details key={key}><summary>{conflict.id}</summary>
            <p>{t('restore.existing')}: <span className="restore-text">{'label' in conflict.existing ? conflict.existing.label : conflict.existing.text}</span></p>
            <p>{t('restore.incoming')}: <span className="restore-text">{'label' in conflict.incoming ? conflict.incoming.label : conflict.incoming.text}</span></p>
            <label className="check"><input type="checkbox" disabled={busy} checked={replace.includes(key)} onChange={event => setReplace(current => event.target.checked ? [...current, key] : current.filter(value => value !== key))} />{t('restore.replace')}</label>
          </details>;
        })}
        {review.incoming.version === 2 && <div className="recovery-label-review">
          <p>{t('restore.existing')}: <span className="restore-text">{review.labelRaw === null ? t('restore.nameDefault') : parseWalletLabelRaw(review.labelRaw!) || t('restore.nameBlank')}</span></p>
          <p>{t('restore.incoming')}: <span className="restore-text">{review.incoming.localDisplayName === null ? t('restore.nameDefault') : review.incoming.localDisplayName || t('restore.nameBlank')}</span></p>
          <label className="check"><input type="checkbox" checked={restoreLabel} disabled={busy} onChange={event => setRestoreLabel(event.target.checked)} />{t('restore.localName')}</label>
          <p className="field-hint">{t('restore.localNameHelp')}</p>
        </div>}
        <label className="check"><input type="checkbox" checked={restoreReceipts} disabled={busy} onChange={event => setRestoreReceipts(event.target.checked)} />{t('restore.receipts')}</label>
        <details><summary>{t('restore.receiptDetails')}</summary>
          <p>{t('restore.defaultReceipts')}: {t(plan?.current.readReceiptsDefault ? 'restore.on' : 'restore.off')} → {t(review.incoming.preferences.readReceiptsDefault ? 'restore.on' : 'restore.off')}</p>
          <ul className="local-items">{Object.entries(review.incoming.preferences.readReceiptOverrides).map(([key, value]) => <li key={key}>{key}: {t((plan?.current.readReceiptOverrides[key] ?? plan?.current.readReceiptsDefault) ? 'restore.on' : 'restore.off')} → {t(value ? 'restore.on' : 'restore.off')}</li>)}</ul>
        </details>
        <label className="check"><input type="checkbox" checked={addLegacyBlocks} disabled={busy} onChange={event => setAddLegacyBlocks(event.target.checked)} />{t('restore.blocks')}</label>
        <p className="field-hint">{t('restore.blocksHelp')}</p>
        <details><summary>{t('restore.blockDetails')}</summary><ul className="local-items">{review.incoming.preferences.blocked.map(address => <li key={address}>{address}</li>)}</ul></details>
        {!plan && <p role="alert">{t('restore.limit')}</p>}
        {plan && !plan.changed && <p role="status">{t('restore.noChanges')}</p>}
        <p className="field-hint">{t('restore.applyHelp')}</p>
        <Button variant="primary" disabled={busy || !plan?.changed} onClick={apply}>{t('restore.apply')}</Button>
        <Button disabled={busy} onClick={() => setReview(null)}>{t('dialog.cancel')}</Button>
      </>}
    </>}
  </section>;
}
