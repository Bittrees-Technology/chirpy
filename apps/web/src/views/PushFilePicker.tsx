import React, { useEffect, useRef, useState } from 'react';
import { PUSH_FILE_BYTES, PUSH_MAX_FILES, preparePushFile, type PushAttachment } from '@app/transport';
import { useI18n } from '../i18n';
import { translateStatus } from '../i18n/statusMessages';

export function PushFilePicker({ files = [], replying, disabled, onChange, onReading }: {
  files?: PushAttachment[]; replying: boolean; disabled: boolean; onChange(files: PushAttachment[]): void; onReading(value: boolean): void;
}) {
  const { t } = useI18n();
  const input = useRef<HTMLInputElement>(null), request = useRef(0), busy = useRef(false);
  const [error, setError] = useState<string | null>(null), [reading, setReading] = useState(false);
  useEffect(() => () => { request.current++; }, []);
  const choose = async (chosen: File[]) => {
    if (!chosen.length || disabled || busy.current) return;
    const current = ++request.current; busy.current = true; setError(null); setReading(true); onReading(true);
    try {
      // Reject the entire batch before reading any bytes. Never keep only part of it.
      if (files.length + chosen.length > PUSH_MAX_FILES) throw new Error('Choose at most 6 files, up to 1 MB each.');
      for (const file of chosen) {
        if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > PUSH_FILE_BYTES) throw new Error('Choose a file of at most 1 MB.');
      }
      const prepared: PushAttachment[] = [];
      for (const file of chosen) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (request.current !== current) return;
        if (bytes.byteLength !== file.size) throw new Error('The selected file is invalid. Choose it again.');
        prepared.push(preparePushFile(file.name, file.type, bytes));
      }
      onChange([...files, ...prepared]);
    } catch (cause) {
      if (request.current === current) setError(cause instanceof Error ? cause.message : 'The selected file could not be read. Choose it again.');
    } finally {
      if (request.current === current) { busy.current = false; setReading(false); onReading(false); }
    }
  };
  return <div className="push-file-compose">
    <input ref={input} type="file" multiple hidden aria-label={t('push.attachFile')} disabled={disabled || reading}
      onChange={event => { const chosen = Array.from(event.target.files ?? []); event.target.value = ''; void choose(chosen); }}/>
    <button className="btn btn-ghost" type="button" disabled={disabled || reading} onClick={() => input.current?.click()}>{t(reading ? 'push.preparingFile' : 'push.attachFile')}</button>
    <small>{t('push.fileSendLimit')}</small>
    {files.length > 0 && <small className="push-file-count">{t('push.selectedFiles')} ({files.length}/{PUSH_MAX_FILES})</small>}
    {files.length > 0 && <ol className="push-file-selection" aria-label={t('push.selectedFiles')}>
      {files.map((file, index) => <li key={index}>
        <span><strong>{file.filename}</strong> · {file.bytes.toLocaleString()} B</span>
        <button className="btn btn-ghost" type="button" disabled={disabled || reading}
          aria-label={files.length > 1 ? `${t('push.removeFile')}: ${file.filename} (${index + 1})` : t('push.removeFile')}
          onClick={() => { setError(null); onChange(files.filter((_, position) => position !== index)); }}>{t('push.removeFile')}</button>
      </li>)}
    </ol>}
    {replying && files.length === 1 && <small>{t('push.fileReplyHint')}</small>}
    {error && <p role="alert">{translateStatus(t, error)}</p>}
  </div>;
}
