import React from 'react';
import type { ChatMessage } from '@app/transport';
import { MessageBody } from './MessageBody';
import { PushAttachment } from './PushAttachment';
import { useI18n } from '../i18n';
export function PushMessageBody({ message }: { message: ChatMessage }) {
  const { t } = useI18n();
  return <div className="push-message-parts">{(message.pushParts ?? [message]).map((part, index) => <div key={index}>
    {part.pushAttachment ? <PushAttachment file={part.pushAttachment}/> : part.pushMediaUrl
      ? <div className="push-attachment"><span>{t('push.externalMedia')}</span><a href={part.pushMediaUrl} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{part.pushMediaUrl}</a></div>
      : <MessageBody body={part.body}/>}
  </div>)}</div>;
}
