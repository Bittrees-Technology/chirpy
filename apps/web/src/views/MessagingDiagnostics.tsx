import React, { useEffect, useRef, useState } from 'react';
import type { MessagingDiagnostics } from '@app/transport';
import { useI18n } from '../i18n';

export function MessagingDiagnosticsView({ inspect }: { inspect: (id?: string) => Promise<MessagingDiagnostics> }) {
  const { t } = useI18n();
  const [id, setId] = useState('');
  const [result, setResult] = useState<MessagingDiagnostics | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const active = useRef(true); const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setResult(null);
    try { const value = await inspect(id.trim() || undefined); if (active.current) setResult(value); }
    catch { if (active.current) setFailed(true); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return <details className="card">
    <summary>{t('settings.messagingDiagnostics')}</summary>
    <p className="muted">{t('settings.messagingDiagnosticsHelp')}</p>
    <label>{t('settings.diagnosticConversation')}<input className="input" value={id} disabled={busy} onChange={e => { setId(e.target.value); setResult(null); setFailed(false); }} /></label>
    <button className="btn btn-ghost btn-sm" disabled={busy || Boolean(id.trim() && !/^[a-f0-9]{32,64}$/.test(id.trim()))} onClick={() => { void run(); }}>{t(busy ? 'settings.diagnosticReading' : 'settings.diagnosticRead')}</button>
    {failed && <p role="alert">{t('settings.diagnosticFailed')}</p>}
    {result && <div role="status"><p>{t('settings.diagnosticResult')}</p><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{JSON.stringify(result, null, 2)}</pre></div>}
  </details>;
}
