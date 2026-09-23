import React, { useContext, useEffect, useId, useRef, useState } from 'react';
import { preparePushImagePreview } from '../pushImagePreview';
import { PushImagePreviewContext } from './PushImagePreviewScope';
import type { ChatMessage } from '@app/transport';
import { Button } from '../ui';
import { useI18n } from '../i18n';
export function PushAttachment({ file }: { file: NonNullable<ChatMessage['pushAttachment']> }) {
  const { t } = useI18n(), [failed, setFailed] = useState(false);
  const scope = useContext(PushImagePreviewContext), id = useId();
  const [chosen, setChosen] = useState<{ base64: string; mediaType: string; bytes: number } | null>(null);
  const active = scope?.active === id && chosen?.base64 === file.base64 && chosen.mediaType === file.mediaType && chosen.bytes === file.bytes;
  const [preview, setPreview] = useState<{ url: string; width: number; height: number; base64: string; mediaType: string; bytes: number } | null>(null);
  const [previewFailed, setPreviewFailed] = useState(false);
  useEffect(() => {
    setPreview(null); setPreviewFailed(false);
    if (!active) return;
    try {
      const image = preparePushImagePreview(file);
      const url = URL.createObjectURL(new Blob([image.bytes], { type: image.mediaType }));
      setPreview({ url, width: image.width, height: image.height, base64: file.base64, mediaType: file.mediaType, bytes: file.bytes });
      return () => { URL.revokeObjectURL(url); };
    } catch { setPreviewFailed(true); }
  }, [active, file.base64, file.mediaType, file.bytes]);
  const visible = active && preview?.base64 === file.base64 && preview.mediaType === file.mediaType && preview.bytes === file.bytes ? preview : null;
  const visibleUrl = useRef<string | null>(null); visibleUrl.current = visible?.url ?? null;
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
    {scope && ['image/png', 'image/jpeg'].includes(file.mediaType) && <Button onClick={() => { if (active) scope.setActive(null); else { setChosen({ base64: file.base64, mediaType: file.mediaType, bytes: file.bytes }); scope.setActive(id); } }}>{t(active ? 'push.hidePreview' : 'push.previewImage')}</Button>}
    {visible && !previewFailed && <img key={visible.url} className="push-image-preview" src={visible.url} width={visible.width} height={visible.height} alt={file.filename} decoding="async" referrerPolicy="no-referrer" onError={() => { if (visibleUrl.current === visible.url) { URL.revokeObjectURL(visible.url); setPreviewFailed(true); } }}/>}
    {active && previewFailed && <p role="alert">{t('push.previewFailed')}</p>}
    <Button onClick={save}>{t('push.downloadFile')}</Button><small>{t('push.fileHint')}</small>{failed && <p role="alert">{t('push.downloadFailed')}</p>}
  </div>;
}
