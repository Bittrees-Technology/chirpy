import React, { useEffect, useRef, useState } from 'react';
import { Button } from '../ui';
import { useI18n } from '../i18n';

/** Mount with a wallet/org key so an old request cannot carry status into a new session. */
export function HistoryRecovery({ request }: { request: () => Promise<void> }) {
  const { t } = useI18n();
  const [status, setStatus] = useState<'idle' | 'requesting' | 'requested' | 'failed'>('idle');
  const active = useRef(true);
  const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const recover = async () => {
    if (pending.current) return;
    pending.current = true;
    setStatus('requesting');
    try { await request(); if (active.current) setStatus('requested'); }
    catch { if (active.current) setStatus('failed'); }
    finally { pending.current = false; }
  };
  return <section className="card" aria-label={t('settings.historyRecovery')}>
    <h2>{t('settings.historyRecovery')}</h2>
    <p className="muted">{t('settings.historyRecoveryHelp')}</p>
    <Button variant="ghost" onClick={() => { void recover(); }} disabled={status === 'requesting'}>
      {t(status === 'requesting' ? 'settings.historyRequesting' : 'settings.historyRequest')}
    </Button>
    {status === 'requested' && <p role="status">{t('settings.historyRequested')}</p>}
    {status === 'failed' && <p role="alert">{t('settings.historyFailed')}</p>}
  </section>;
}
