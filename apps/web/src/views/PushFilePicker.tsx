import React, { useEffect, useRef, useState } from 'react';
import { PUSH_FILE_BYTES, preparePushFile, type PushAttachment } from '@app/transport';
import { useI18n } from '../i18n';
import { translateStatus } from '../i18n/statusMessages';

export function PushFilePicker({ file, replying, disabled, onChange, onReading }: {
  file?: PushAttachment; replying: boolean; disabled: boolean; onChange(file?: PushAttachment): void; onReading(value: boolean): void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null), request = useRef(0);
  const [error, setError] = useState<string | null>(null), [reading, setReading] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  const choose = async (chosen?: File) => {
    if (!chosen || disabled) return;
    const current = ++request.current; setError(null); setReading(true); onReading(true);
    try {
      if (!Number.isSafeInteger(chosen.size) || chosen.size < 0 || chosen.size > PUSH_FILE_BYTES) throw new Error('Choose a file of at most 1 MB.');
      const bytes = new Uint8Array(await chosen.arrayBuffer());
      if (request.current !== current) return;
      if (bytes.byteLength !== chosen.size) throw new Error('The selected file is invalid. Choose it again.');
      onChange(preparePushFile(chosen.name, chosen.type, bytes));
    } catch (cause) {
      if (request.current === current) setError(cause instanceof Error ? cause.message : 'The selected file could not be read. Choose it again.');
    } finally {
      if (request.current === current) { setReading(false); onReading(false); }
    }
  };
  return <div className="push-file-compose">
    <input ref={input} type="file" hidden aria-label={t('push.attachFile')} disabled={disabled || reading}
      onChange={event => { const chosen = event.target.files?.[0]; event.target.value = ''; void choose(chosen); }}/>
    <button className="btn btn-ghost" type="button" disabled={disabled || reading} onClick={() => input.current?.click()}>{t(reading ? 'push.preparingFile' : 'push.attachFile')}</button>
    {file ? <><span><strong>{file.filename}</strong> · {file.bytes.toLocaleString()} B</span><button className="btn btn-ghost" type="button" disabled={disabled || reading} onClick={() => { setError(null); onChange(); }}>{t('push.removeFile')}</button><small>{t(replying ? 'push.fileReplyHint' : 'push.fileSendLimit')}</small></> : <small>{t('push.fileSendLimit')}</small>}
    {error && <p role="alert">{translateStatus(t, error)}</p>}
  </div>;
}
