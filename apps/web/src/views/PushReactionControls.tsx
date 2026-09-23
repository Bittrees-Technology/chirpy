import React, { useEffect, useRef, useState } from 'react';
import { PUSH_REACTIONS } from '@app/transport';
import { useI18n } from '../i18n';

export function PushReactionControls({ messageId, owner, reactions, react }: {
  messageId: string; owner: string; reactions?: Record<string, string[]>;
  react(messageId: string, emoji: string): Promise<void>;
}) {
  const { t } = useI18n();
  const alive = useRef(true), busy = useRef(false);
  const [pending, setPending] = useState(false), [failed, setFailed] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const add = async (emoji: string) => {
    if (busy.current || reactions?.[emoji]?.includes(owner)) return;
    busy.current = true; setPending(true); setFailed(false);
    try { await react(messageId, emoji); }
    catch { if (alive.current) setFailed(true); }
    finally { if (alive.current) { busy.current = false; setPending(false); } }
  };
  return <div className="push-reaction-controls"><details>
    <summary>{t('push.addReaction')}</summary>
    <div className="push-reaction-picker" role="group" aria-label={t('push.addReaction')}>
      {PUSH_REACTIONS.map(emoji => <button type="button" className="react-btn" key={emoji}
        aria-label={`${t('thread.reactWith')} ${emoji}`} title={reactions?.[emoji]?.includes(owner) ? t('push.reactionAdded') : undefined}
        disabled={pending || reactions?.[emoji]?.includes(owner)} onClick={() => void add(emoji)}>{emoji}</button>)}
    </div>
    <small>{t('push.reactionAddOnly')}</small>
  </details>{pending && <span role="status">{t('push.reactionPending')}</span>}{failed && <p role="alert">{t('push.reactionFailed')}</p>}</div>;
}
