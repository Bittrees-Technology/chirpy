import React, { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@app/transport';
import { useChat } from '../state';
import { useI18n } from '../i18n';
import { translateStatus } from '../i18n/statusMessages';
import { Button, Modal } from '../ui';

export function RoomLeave({ conversation }: { conversation: Conversation }) {
  const { requestRoomLeave } = useChat();
  const { t } = useI18n();
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requested, setRequested] = useState(false);
  const working = useRef(false), mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => { if (conversation.leaveState !== 'available') setRequested(false); }, [conversation.leaveState]);
  if (conversation.blocked || conversation.pending || !conversation.leaveState) return null;
  const state = requested && conversation.leaveState === 'available' ? 'pending' : conversation.leaveState;
  return <section className="join-banner" aria-label={t('roomLeave.title')}>
    {state !== 'available' && <p role="status">{t(`roomLeave.${state}`)}</p>}
    {state === 'available' && <Button variant="ghost" onClick={() => { setError(null); setConfirm(true); }}>{t('roomLeave.action')}</Button>}
    {confirm && state === 'available' && <Modal title={t('roomLeave.confirmTitle')} onClose={() => { if (!working.current) setConfirm(false); }}>
      <p>{t('roomLeave.confirmHint')}</p>
      <div className="modal-actions">
        <Button disabled={busy} onClick={() => setConfirm(false)}>{t('dialog.cancel')}</Button>
        <Button variant="danger" disabled={busy} onClick={async () => {
          if (working.current) return;
          working.current = true; setBusy(true); setError(null);
          try {
            await requestRoomLeave();
            if (mounted.current) { setRequested(true); setConfirm(false); }
          } catch (failure) {
            if (mounted.current) setError(failure instanceof Error ? translateStatus(t, failure.message) : t('roomLeave.failed'));
          } finally { working.current = false; if (mounted.current) setBusy(false); }
        }}>{t(busy ? 'roomLeave.requesting' : 'roomLeave.confirm')}</Button>
      </div>
      {error && <p role="alert">{error}</p>}
    </Modal>}
  </section>;
}
