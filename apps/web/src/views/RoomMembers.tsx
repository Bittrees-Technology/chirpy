import React, { useEffect, useRef, useState } from 'react';
import type { Conversation } from '@app/transport';
import { useChat } from '../state';
import { usePublicProfiles } from '../usePublicProfiles';
import { useI18n } from '../i18n';
import { translateStatus } from '../i18n/statusMessages';

export function RoomMembers({ conversation }: { conversation: Conversation }) {
  const { addRoomMember, transportId } = useChat();
  const { t } = useI18n();
  const [expanded, setExpanded] = useState(false);
  const profiles = usePublicProfiles(expanded ? conversation.peers : [], transportId === 'xmtp');
  const [address, setAddress] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const busy = useRef(false); const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const savedRoster = Boolean(conversation.deviceAccess && conversation.deviceAccess !== "active");
  const title = t(savedRoster ? "roomMembers.savedTitle" : "roomMembers.title");
  const canAdd = conversation.leaveState !== 'pending' && conversation.leaveState !== 'removed' && (!conversation.deviceAccess || conversation.deviceAccess === "active") && !conversation.pending && !conversation.blocked && conversation.canAddMembers === true && conversation.isAdmin === true && !conversation.configurationError && !conversation.gate?.rules.length;
  return <details className="join-banner room-members" onToggle={event => setExpanded(event.currentTarget.open)}>
    <summary>{title}</summary>
    {savedRoster && <p>{t('roomMembers.savedHint')}</p>}
    <ul aria-label={title}>{conversation.peers.map(peer => <li key={peer}>{profiles.get(peer.toLowerCase())?.label && <span>{profiles.get(peer.toLowerCase())!.label} · </span>}<code>{peer}</code></li>)}</ul>
    {canAdd && <form onSubmit={async event => {
      event.preventDefault();
      if (busy.current || !/^0x[a-fA-F0-9]{40}$/.test(address.trim())) return;
      busy.current = true; setPending(true); setStatus(null);
      try {
        await addRoomMember(address.trim());
        if (mounted.current) { setAddress(''); setStatus({ ok: true, message: t(transportId === 'mock' ? 'roomMembers.demoAdded' : 'roomMembers.added') }); }
      } catch (error) {
        if (mounted.current) setStatus({ ok: false, message: error instanceof Error ? translateStatus(t, error.message) : t('thread.actionFailed') });
      } finally { busy.current = false; if (mounted.current) setPending(false); }
    }}>
      <p>{t(transportId === 'mock' ? 'roomMembers.demoHint' : 'roomMembers.hint')}</p>
      <label>{t('roomMembers.wallet')}<input className="input" required value={address} disabled={pending} pattern="0x[a-fA-F0-9]{40}" maxLength={42} autoComplete="off" spellCheck={false} onChange={e => setAddress(e.target.value)} /></label>
      <button className="btn btn-ghost" type="submit" disabled={pending || !/^0x[a-fA-F0-9]{40}$/.test(address.trim())}>{t(pending ? 'roomMembers.adding' : 'roomMembers.add')}</button>
    </form>}
    {status && <p role={status.ok ? 'status' : 'alert'}>{status.message}</p>}
  </details>;
}
