import React, { useState } from 'react';
import type { ChatMessage } from '@app/transport';
import { Button } from '../ui';
import { useI18n } from '../i18n';
export function PushAttachment({ file }: { file: NonNullable<ChatMessage['pushAttachment']> }) {
  const { t } = useI18n(), [failed, setFailed] = useState(false);
  const save = () => {
    setFailed(false);
    try {
      const bytes = Uint8Array.from(atob(file.base64), c => c.charCodeAt(0));
      if (bytes.length !== file.bytes) throw Error('Changed attachment');
      const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
      const anchor = document.createElement('a'); anchor.href = url; anchor.download = file.filename;
      document.body.append(anchor);
      try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000); }
    } catch { setFailed(true); }
  };
  return <div className="push-attachment"><strong>{file.filename}</strong><span>{file.bytes.toLocaleString()} B · {file.mediaType}</span>
    <Button onClick={save}>{t('push.downloadFile')}</Button><small>{t('push.fileHint')}</small>{failed && <p role="alert">{t('push.downloadFailed')}</p>}
  </div>;
}
