import React, { useEffect, useRef, useState } from 'react';
import type { PushMemberPage } from '@app/transport';
import { useChat } from '../state';
import { useI18n } from '../i18n';
import { Button } from '../ui';

/** Mounted with a room/wallet/access key; old requests cannot populate a new scope. */
export function PushMembers({ canModerate }: { canModerate: boolean }) {
  const { loadPushMembers } = useChat(); const { t } = useI18n();
  const [result, setResult] = useState<PushMemberPage | null>(null);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const load = async (page: number, filter = pending) => {
    const request = ++generation.current; setBusy(true); setError(null); setResult(null);
    try { const next = await loadPushMembers(page, filter); if (generation.current === request) setResult(next); }
    catch (error) { if (generation.current === request) setError(error instanceof Error ? error.message : t('thread.actionFailed')); }
    finally { if (generation.current === request) setBusy(false); }
  };
  return <details className="push-members join-banner" onToggle={event => {
    if (!event.currentTarget.open) { generation.current++; setResult(null); setBusy(false); setError(null); }
  }}>
    <summary>{t('push.viewMembers')}</summary>
    <div className="local-actions">
      {canModerate && <label>{t('push.memberView')}<select value={pending ? 'pending' : 'approved'} onChange={event => {
        const next = event.target.value === 'pending'; setPending(next); void load(1, next);
      }}><option value="approved">{t('push.approvedMembers')}</option><option value="pending">{t('push.pendingMembers')}</option></select></label>}
      <Button disabled={busy} onClick={() => void load(result?.page ?? 1)}>{t('push.refreshMembers')}</Button>
    </div>
    {busy && <span role="status">{t('push.loadingMembers')}</span>}
    {error && <div role="alert">{error}</div>}
    {result && <>
      <p>{t('push.memberPage', undefined, { page: result.page })}</p>
      {result.members.length === 0 && <p>{t('push.noMembersPage')}</p>}
      <ul>{result.members.map(member => <li key={member.address}><code>{member.address}</code> · {t(member.role === 'ADMIN' ? 'push.admin' : 'push.membership.member')}</li>)}</ul>
      <div className="local-actions">
        <Button disabled={busy || result.page <= 1} onClick={() => void load(result.page - 1)}>{t('list.previous')}</Button>
        <Button disabled={busy || !result.hasMore} onClick={() => void load(result.page + 1)}>{t('list.next')}</Button>
      </div>
    </>}
  </details>;
}
