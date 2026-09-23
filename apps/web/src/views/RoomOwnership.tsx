import React, { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@app/transport';
import { useChat } from '../state';
import { useI18n } from '../i18n';
import { translateStatus } from '../i18n/statusMessages';
import { Button, Modal } from '../ui';

export function RoomOwnership({ conversation }: { conversation: Conversation }) {
  const { updateRoomOwnership } = useChat();
  const { t } = useI18n();
  const [address, setAddress] = useState('');
  const [confirmation, setConfirmation] = useState<{ action: 'appoint' | 'step-down'; address?: string } | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const working = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  if (conversation.blocked || conversation.pending || conversation.deviceAccess !== 'active' || conversation.leaveState !== 'owner' || conversation.configurationError) return null;
  if (conversation.gate?.rules.length) return <p className="join-banner">{t('ownership.managed')}</p>;
  return <details className="join-banner room-ownership">
    <summary>{t('ownership.title')}</summary>
    <p>{t('ownership.hint')}</p>
    <form onSubmit={event => {
      event.preventDefault();
      if (working.current || !/^0x[a-fA-F0-9]{40}$/.test(address.trim())) return;
      setError(null); setSuccess(false); setConfirmation({ action: 'appoint', address: address.trim() });
    }}>
      <label>{t('ownership.wallet')}<input className="input" required value={address} disabled={busy} pattern="0x[a-fA-F0-9]{40}" maxLength={42} autoComplete="off" spellCheck={false} onChange={event => setAddress(event.target.value)} /></label>
      <Button type="submit" disabled={busy || !/^0x[a-fA-F0-9]{40}$/.test(address.trim())}>{t('ownership.appoint')}</Button>
    </form>
    <Button variant="ghost" disabled={busy} onClick={() => { setError(null); setSuccess(false); setConfirmation({ action: 'step-down' }); }}>{t('ownership.stepDown')}</Button>
    {success && <p role="status">{t('ownership.appointed')}</p>}
    {confirmation && <Modal title={t(confirmation.action === 'appoint' ? 'ownership.appointTitle' : 'ownership.stepDownTitle')} onClose={() => { if (!working.current) setConfirmation(null); }}>
      <p>{t(confirmation.action === 'appoint' ? 'ownership.appointHint' : 'ownership.stepDownHint')}</p>
      {confirmation.address && <code>{confirmation.address}</code>}
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => setConfirmation(null)}>{t('dialog.cancel')}</Button>
        <Button variant="danger" disabled={busy} onClick={async () => {
          if (working.current) return;
          const selected = confirmation;
          working.current = true; setBusy(true); setError(null);
          try {
            await updateRoomOwnership(selected.action, selected.address);
            if (mounted.current) { setConfirmation(null); setSuccess(selected.action === 'appoint'); setAddress(''); }
          } catch (failure) {
            if (mounted.current) setError(failure instanceof Error ? translateStatus(t, failure.message) : t('ownership.failed'));
          } finally { working.current = false; if (mounted.current) setBusy(false); }
        }}>{t(busy ? 'ownership.changing' : 'ownership.confirm')}</Button>
      </div>
      {error && <div role="alert"><p>{error}</p><p>{t('ownership.retryHint')}</p></div>}
    </Modal>}
  </details>;
}
