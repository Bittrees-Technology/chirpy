import React, { useEffect, useRef, useState } from 'react';
import { useIdentity } from '../state';
import { useI18n } from '../i18n';
import { Button, Field, Modal } from '../ui';
import { changeLocalData, LocalDataConflict, readLocalData, subscribeLocalData,
  type Contact, type LocalChange, type LocalData, type LocalNote } from '../localData';

/** Local labels never publish a profile or establish another wallet's identity. */
export function LocalLibrary({ kind, onClose, onPick }: {
  kind: 'contacts' | 'notes'; onClose: () => void; onPick: (contact: Contact) => void;
}) {
  const { identity, mode } = useIdentity();
  const wallet = identity.address.toLowerCase();
  const { t, lang } = useI18n();
  const [data, setData] = useState<LocalData | null>(null);
  const [error, setError] = useState<'read' | 'write' | 'conflict' | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [address, setAddress] = useState('');
  const [label, setLabel] = useState('');
  const [text, setText] = useState('');
  const [editing, setEditing] = useState<Contact | LocalNote | null>(null);
  const [saved, setSaved] = useState(false);
  const lifetime = useRef(0);
  const pending = useRef(false);
  const latest = useRef({ wallet, mode }); latest.current = { wallet, mode };
  const reload = useRef<() => void>(() => {});
  useEffect(() => {
    const generation = ++lifetime.current;
    let request = 0;
    setData(null); setError(null);
    const refresh = () => {
      if (mode !== 'wallet') return;
      const id = ++request;
      void readLocalData(wallet).then(value => {
        if (generation === lifetime.current && id === request) {
          setData(value); setError(previous => previous === 'read' ? null : previous);
        }
      }, () => {
        if (generation === lifetime.current && id === request) { setData(null); setError('read'); }
      });
    };
    reload.current = refresh;
    refresh();
    const unsubscribe = subscribeLocalData(refresh);
    return () => { lifetime.current++; unsubscribe(); };
  }, [wallet, mode]);
  const reset = () => { setEditing(null); setAddress(''); setLabel(''); setText(''); setSaved(false); };
  const save = async (change: LocalChange, clearDraft = true) => {
    if (pending.current || !data || mode !== 'wallet') return;
    pending.current = true; setBusy(true); setError(null); setSaved(false);
    const generation = lifetime.current;
    const ensureCurrent = () => {
      if (lifetime.current !== generation || latest.current.wallet !== wallet || latest.current.mode !== 'wallet') {
        throw new Error('Local data session changed');
      }
    };
    try {
      await changeLocalData(wallet, change, ensureCurrent);
      ensureCurrent(); if (clearDraft) reset(); setSaved(true); reload.current();
    } catch (err) {
      if (generation === lifetime.current) { setError(err instanceof LocalDataConflict ? 'conflict' : 'write'); reload.current(); }
    } finally {
      pending.current = false;
      if (generation === lifetime.current) setBusy(false);
    }
  };
  const isContacts = kind === 'contacts';
  const all = isContacts ? data?.contacts ?? [] : data?.notes ?? [];
  const filtered = all.filter(item => ('address' in item ? `${item.label} ${item.address}` : item.text).toLowerCase().includes(query.trim().toLowerCase()));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 25));
  const currentPage = Math.min(page, pageCount - 1);
  const valid = isContacts ? /^0x[0-9a-fA-F]{40}$/.test(address.trim()) : Boolean(text.trim());
  return <Modal title={t(isContacts ? 'local.contacts' : 'local.notes')} onClose={onClose} wide>
    <div data-insights-ignore="true">
      <p className="muted">{t(isContacts ? 'local.contactsHelp' : 'local.notesHelp')}</p>
      <p className="field-hint">{t('local.storageHelp')}</p>
      {mode !== 'wallet' ? <p role="status">{t('local.connect')}</p> : <>
        {error && <p role="alert">{t(`local.${error}Error`)}</p>}
        {!data && <Button onClick={() => reload.current()}>{t('local.retry')}</Button>}
        {data && <>
          <form onSubmit={event => {
            event.preventDefault();
            if (!valid || busy) return;
            void save(isContacts
              ? { kind: 'contact', before: editing as Contact | null, after: { address: address.trim().toLowerCase(), label: label.trim() } }
              : { kind: 'note', before: editing as LocalNote | null, after: { id: editing ? (editing as LocalNote).id : crypto.randomUUID(), text, sentAtMs: editing ? (editing as LocalNote).sentAtMs : Date.now() } });
          }}>
            {isContacts ? <>
              <Field label={t('local.address')}><input className="input" value={address} maxLength={42} disabled={busy || !!editing} onChange={event => { setAddress(event.target.value); setSaved(false); }} /></Field>
              <Field label={t('local.label')}><input className="input" value={label} maxLength={200} disabled={busy} onChange={event => { setLabel(event.target.value); setSaved(false); }} /></Field>
            </> : <Field label={t('local.noteText')}><textarea className="input local-note-input" value={text} maxLength={50000} disabled={busy} onChange={event => { setText(event.target.value); setSaved(false); }} /></Field>}
            <div className="local-actions">
              <Button type="submit" variant="primary" disabled={!valid || busy}>{t(busy ? 'local.saving' : editing ? 'local.saveChanges' : isContacts ? 'local.addContact' : 'local.addNote')}</Button>
              {editing && <Button type="button" disabled={busy} onClick={reset}>{t('dialog.cancel')}</Button>}
            </div>
          </form>
          {saved && <p role="status">{t('local.saved')}</p>}
          <Field label={t(isContacts ? 'local.searchContacts' : 'local.searchNotes')}><input className="input" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></Field>
          {filtered.length === 0 && <p className="muted">{t('local.empty')}</p>}
          <ul className="local-items">
            {filtered.slice(currentPage * 25, (currentPage + 1) * 25).map(item => <li key={'address' in item ? item.address : item.id}>
              {'address' in item ? <><strong>{item.label || item.address}</strong>{item.label && <div className="muted local-address">{item.address}</div>}</>
                : <><p className="local-note-text">{item.text}</p><small className="muted">{new Date(item.sentAtMs).toLocaleString(lang)}</small></>}
              <div className="local-actions">
                {'address' in item && <Button disabled={busy} onClick={() => onPick(item)}>{t('local.message')}</Button>}
                <Button disabled={busy} onClick={() => {
                  setEditing(item); setSaved(false); setError(null);
                  if ('address' in item) { setAddress(item.address); setLabel(item.label); } else setText(item.text);
                }}>{t('local.edit')}</Button>
                <Button variant="danger" disabled={busy} onClick={() => {
                  if (window.confirm(t('local.deleteConfirm'))) void save('address' in item
                    ? { kind: 'contact', before: item, after: null } : { kind: 'note', before: item, after: null },
                    !editing || ('address' in editing && 'address' in item ? editing.address === item.address : 'id' in editing && 'id' in item && editing.id === item.id));
                }}>{t('local.delete')}</Button>
              </div>
            </li>)}
          </ul>
          {pageCount > 1 && <nav className="local-actions" aria-label={t('local.pages')}>
            <Button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>{t('list.previous')}</Button>
            <span>{currentPage + 1} / {pageCount}</span>
            <Button disabled={currentPage === pageCount - 1} onClick={() => setPage(currentPage + 1)}>{t('list.next')}</Button>
          </nav>}
        </>}
      </>}
    </div>
  </Modal>;
}
