import React, { useEffect, useRef, useState } from 'react';
import type { MessagingDevices } from '@app/transport';
import { useI18n } from '../i18n';

export function MessagingDevicesView({ inspect, initiallyOpen = false }: {
  inspect: () => Promise<MessagingDevices>; initiallyOpen?: boolean;
}) {
  const { t, lang } = useI18n();
  const [result, setResult] = useState<MessagingDevices | null>(null);
  const [busy, setBusy] = useState(false); const [failed, setFailed] = useState(false);
  const active = useRef(true); const pending = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  const run = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setFailed(false); setResult(null);
    try { const value = await inspect(); if (active.current) setResult(value); }
    catch { if (active.current) setFailed(true); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  };
  return <details className="card" open={initiallyOpen}>
    <summary>{t('settings.messagingDevices')}</summary>
    <p className="muted">{t('settings.messagingDevicesHelp')}</p>
    <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => { void run(); }}>
      {t(busy ? 'settings.devicesReading' : 'settings.devicesRead')}
    </button>
    {failed && <p role="alert">{t('settings.devicesFailed')}</p>}
    {result && <div>
      {!result.inboxId ? <p role="status">{t('settings.devicesNoInbox')}</p> : <>
        <p role="status">{t('settings.devicesCount', undefined, { count: result.installations.length })}</p>
        <p className="muted">{t('settings.devicesDates')}</p>
        {!result.localInstallationId && <p>{t('settings.devicesLocalUnknown')}</p>}
        {result.localInstallationId && !result.installations.some(i => i.id === result.localInstallationId) && <p>{t('settings.devicesLocalMissing')}</p>}
        {!result.installations.length && <p>{t('settings.devicesEmpty')}</p>}
        <ul>
          {result.installations.map((device, index) => <li key={device.id} style={{ marginBlock: '0.75rem' }}>
            <strong>{t('settings.deviceNumber', undefined, { count: index + 1 })}</strong>
            {device.id === result.localInstallationId && <> · {t('settings.deviceThisBrowser')}</>}
            <div>{t('settings.deviceCreated')} {device.createdAtMs === null ? t('settings.deviceDateUnknown') :
              <time dateTime={new Date(device.createdAtMs).toISOString()}>{new Date(device.createdAtMs).toLocaleString(lang)}</time>}</div>
            <details><summary>{t('settings.deviceId')} · {device.id.slice(0, 8)}…{device.id.slice(-8)}</summary>
              <code style={{ overflowWrap: 'anywhere' }}>{device.id}</code>
            </details>
          </li>)}
        </ul>
      </>}
    </div>}
  </details>;
}
