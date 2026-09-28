import React, { useEffect, useRef, useState } from 'react';
import { useI18n } from '../i18n';

export function ConversationRecoveryView({ recover }: { recover: (conversationId: string, invitationId: string) => Promise<void> }) {
  const { t } = useI18n();
  const [conversation, setConversation] = useState(''), [invitation, setInvitation] = useState('');
  const [state, setState] = useState<'idle' | 'busy' | 'done' | 'failed'>('idle');
  const alive = useRef(true), pending = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const valid = /^(?:[a-f0-9]{2}){1,128}$/.test(conversation.trim()) && /^[1-9][0-9]{0,18}$/.test(invitation.trim())
    && BigInt(invitation.trim()) <= 9_223_372_036_854_775_807n;
  const run = async () => {
    if (!valid || pending.current) return;
    pending.current = true; setState('busy');
    try { await recover(conversation.trim(), invitation.trim()); if (alive.current) setState('done'); }
    catch { if (alive.current) setState('failed'); }
    finally { pending.current = false; }
  };
  return <details className="card">
    <summary>{t('settings.recoverConversation')}</summary>
    <p className="muted">{t('settings.recoverConversationHelp')}</p>
    <label>{t('settings.recoveryConversationId')}<input className="input" value={conversation} disabled={state === 'busy'} maxLength={256}
      onChange={event => { setConversation(event.target.value); setState('idle'); }} /></label>
    <label>{t('settings.recoveryInvitationId')}<input className="input" value={invitation} disabled={state === 'busy'} inputMode="numeric" maxLength={19}
      onChange={event => { setInvitation(event.target.value); setState('idle'); }} /></label>
    <button className="btn btn-ghost btn-sm" disabled={!valid || state === 'busy' || state === 'done'} onClick={() => { void run(); }}>
      {t(state === 'busy' ? 'settings.recoveringConversation' : 'settings.recoverConversationAction')}
    </button>
    {state === 'done' && <p role="status">{t('settings.recoverConversationDone')}</p>}
    {state === 'failed' && <p role="alert">{t('settings.recoverConversationFailed')}</p>}
  </details>;
}
