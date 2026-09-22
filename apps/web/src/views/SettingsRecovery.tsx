import { assertNoRecoveryPending, walletSettingsKey } from '../settingsStorage';
import React, { useEffect, useRef, useState } from 'react';
import { Button, Field } from '../ui';
import { useI18n } from '../i18n';
import { encryptRecoveryArchive, validateRecoveryData, type RecoveryData } from '../recoveryArchive';
import { verifyRecoveryWallet } from '../recoveryWallet';
import { readLocalData } from '../localData';
import { download } from './dialogs';

/** Key by connected wallet. Exports explicit application data, never protocol databases or keys. */
export function SettingsRecovery({ wallet, preferences }: { wallet: string; preferences: RecoveryData['preferences'] }) {
  const { t } = useI18n();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [status, setStatus] = useState<'idle' | 'working' | 'prepared' | 'failed'>('idle');
  const active = useRef(true);
  const busy = useRef(false);
  const latest = useRef('');
  const fingerprint = JSON.stringify({ wallet: wallet.toLowerCase(), preferences });
  latest.current = fingerprint;
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const validPassword = password.length >= 12 && password.length <= 1024 && Boolean(password.trim()) && password === confirmation;
  const exportSettings = async () => {
    if (busy.current || !validPassword) return;
    busy.current = true;
    setStatus('working');
    let proof: Awaited<ReturnType<typeof verifyRecoveryWallet>> | undefined;
    const ensureCurrent = () => {
      if (!active.current || latest.current !== fingerprint) throw new Error('Wallet or settings changed during export');
    };
    try {
      // Read explicit wallet-owned fields and validate a copy. No localStorage enumeration.
      assertNoRecoveryPending(walletSettingsKey(wallet));
      const local = await readLocalData(wallet);
      ensureCurrent();
      const data = validateRecoveryData({ version: 1, source: 'chirpy', wallet, createdAt: Date.now(),
        contacts: local.contacts, notes: local.notes, preferences });
      proof = await verifyRecoveryWallet(wallet, ensureCurrent);
      const archive = await encryptRecoveryArchive(data, password);
      if ((await readLocalData(wallet)).revision !== local.revision) throw new Error('Local data changed during export');
      await proof.assertCurrent();
      ensureCurrent();
      assertNoRecoveryPending(walletSettingsKey(wallet));
      download('chat-local-data-recovery.json', archive);
      setStatus('prepared');
    } catch { if (active.current) setStatus('failed'); }
    finally {
      proof?.dispose(); busy.current = false;
      if (active.current) { setPassword(''); setConfirmation(''); }
    }
  };
  return <section className="card" data-insights-ignore="true" aria-label={t('recovery.settingsTitle')}>
    <h2>{t('recovery.settingsTitle')}</h2>
    <p className="muted">{t('recovery.settingsScope')}</p>
    <p className="muted">{t('recovery.passwordHelp')}</p>
    <div className="grid2 recovery-fields">
      <Field label={t('recovery.password')}><input className="input" type="password" autoComplete="new-password"
        maxLength={1024} value={password} disabled={status === 'working'} onChange={event => { setPassword(event.target.value); setStatus('idle'); }} /></Field>
      <Field label={t('recovery.confirmPassword')}><input className="input" type="password" autoComplete="new-password"
        maxLength={1024} value={confirmation} disabled={status === 'working'} onChange={event => { setConfirmation(event.target.value); setStatus('idle'); }} /></Field>
    </div>
    <Button variant="ghost" disabled={!validPassword || status === 'working'} onClick={() => { void exportSettings(); }}>
      {t(status === 'working' ? 'recovery.preparing' : 'recovery.exportSettings')}
    </Button>
    {status === 'prepared' && <p role="status">{t('recovery.prepared')}</p>}
    {status === 'failed' && <p role="alert">{t('recovery.failed')}</p>}
  </section>;
}
