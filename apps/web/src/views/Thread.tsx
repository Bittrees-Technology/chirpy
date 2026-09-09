import { receiptOverride } from "../receiptPreferences";
import React, { useEffect, useRef, useState } from "react";
import { policySummary, type Policy } from "@app/core";
import { useChat, useIdentity, useSettingsPrefs } from "../state";
import { Avatar, Button, Empty, fmtTime, shortAddr } from "../ui";
import { nameFor, useEnsProfiles } from "../useEns";
import { useI18n } from "../i18n";

const EMOJIS = ["👍", "❤️", "😂", "🎉", "🤝"];

export function Thread({ showBack = false, onBack }: { showBack?: boolean; onBack?: () => void }) {
  const { activeConversation, messages, send, react, setRoomPolicy, requestRoomJoin, setConversationConsent, markRead, historyLoading, isHistory, hasOlderMessages, navigateHistory } = useChat();
  const { identity } = useIdentity();
  const { prefs, setChatReadReceipts } = useSettingsPrefs();
  const { t } = useI18n();
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const conversationKey = activeConversation?.id ?? "";
  const currentConversationRef = useRef(conversationKey);
  currentConversationRef.current = conversationKey;
  const draft = drafts[conversationKey] ?? "";
  const setDraft = (value: string) => setDrafts((current) => ({ ...current, [conversationKey]: value }));
  const [sending, setSending] = useState<string | null>(null);
  const sendingRef = useRef(false);
  const [sendError, setSendError] = useState<{ id: string; message: string } | null>(null);
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [joinStatus, setJoinStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [consentPending, setConsentPending] = useState(false);
  const [joinPending, setJoinPending] = useState(false);
  const [policyPending, setPolicyPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const previousConversationRef = useRef<string | null>(null);
  const [hasNewMessages, setHasNewMessages] = useState(false);
  const scrollToLatest = () => { endRef.current?.scrollIntoView({ behavior: "auto" }); nearBottomRef.current = true; setHasNewMessages(false); markVisibleRead(); };
  const selfAddress = identity.address.toLowerCase();
  const latestMessageId = messages.at(-1)?.id;
  const markVisibleRead = () => {
    if (!isHistory && !historyLoading && latestMessageId && messagesRef.current?.getClientRects().length && nearBottomRef.current && !activeConversation?.pending && !activeConversation?.blocked && document.visibilityState === "visible" && document.hasFocus()) {
      void markRead?.(latestMessageId).catch(() => {});
    }
  };
  useEffect(() => {
    markVisibleRead();
    window.addEventListener("focus", markVisibleRead);
    document.addEventListener("visibilitychange", markVisibleRead);
    return () => { window.removeEventListener("focus", markVisibleRead); document.removeEventListener("visibilitychange", markVisibleRead); };
  }, [conversationKey, latestMessageId, markRead, activeConversation?.pending, activeConversation?.blocked, isHistory, historyLoading]);

  const isRoomConv = activeConversation?.kind === "room";
  const peerAddress = activeConversation && !isRoomConv
    ? (activeConversation.peers.find((p) => p.toLowerCase() !== selfAddress) ?? activeConversation.peers[0])
    : undefined;
  // Resolve the peer + every message sender to ENS (name + avatar), cached app-wide.
  const profiles = useEnsProfiles([peerAddress, ...messages.map((m) => m.sender)]);

  useEffect(() => { setDrafts({}); setSendError(null); }, [selfAddress]);
  useEffect(() => {
    const switched = previousConversationRef.current !== conversationKey;
    previousConversationRef.current = conversationKey;
    if (switched || nearBottomRef.current) scrollToLatest();
    else setHasNewMessages(true);
  }, [latestMessageId, conversationKey]);
  useEffect(() => { setReplyTo(null); setJoinStatus(null); }, [activeConversation?.id]);

  if (!activeConversation) {
    return (
      <div className="thread">
        <Empty icon="💬" title={t("thread.selectTitle", "Select a conversation")} hint={t("thread.selectHint", "or start a new one from the left")} />
      </div>
    );
  }

  const peerRecord = peerAddress ? profiles.get(peerAddress.toLowerCase()) : undefined;
  const headerName = isRoomConv
    ? `# ${activeConversation.title}`
    : nameFor(peerAddress ?? activeConversation.title, peerRecord, activeConversation.title);
  const headerAvatar = !isRoomConv ? peerRecord?.avatar ?? undefined : undefined;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (sendingRef.current || !draft.trim()) return;
    const body = draft;
    const id = activeConversation.id;
    sendingRef.current = true;
    setSending(id); setSendError(null);
    try {
      await send(body, replyTo ?? undefined);
      if (currentConversationRef.current === id) scrollToLatest();
      setDrafts((current) => current[id] === body ? { ...current, [id]: "" } : current);
      if (currentConversationRef.current === id) setReplyTo(null);
    } catch (error) {
      setSendError({ id, message: error instanceof Error ? error.message : "Message was not sent. Your draft is saved; try again." });
    } finally { sendingRef.current = false; setSending(null); }
  };

  const replyTarget = replyTo ? messages.find((m) => m.id === replyTo) : null;
  const isRoom = activeConversation.kind === "room";
  const policy: Policy | null = isRoom ? (activeConversation.policy ?? null) : null;
  const readOnly = policy?.mode === "read-only";
  const isAdmin = isRoom && activeConversation.isAdmin === true;
  const postingBlocked = readOnly && !isAdmin;
  const needsConsent = !isRoom && (activeConversation.pending || activeConversation.blocked);
  const changeConsent = async (state: "allowed" | "denied") => {
    setConsentPending(true);
    try { await setConversationConsent(state); setJoinStatus(null); }
    catch (error) { setJoinStatus({ ok: false, message: error instanceof Error ? error.message : "Consent update failed. Try again." }); }
    finally { setConsentPending(false); }
  };
  const isGatedRoom = isRoom && Boolean(activeConversation.gate?.rules.length);
  const isMember = activeConversation.peers.some((peer) => peer.toLowerCase() === identity.address.toLowerCase());
  const toggleFreeze = () => {
    if (!policy || !isAdmin || policyPending) return;
    setPolicyPending(true);
    void setRoomPolicy({ ...policy, mode: readOnly ? "active" : "read-only" }).catch((error) => setJoinStatus({ ok: false, message: error instanceof Error ? error.message : t("thread.actionFailed", "This action failed. Try again.") })).finally(() => setPolicyPending(false));
  };
  const requestJoin = async () => {
    setJoinPending(true);
    const result = await requestRoomJoin(activeConversation.id);
    setJoinStatus(result);
    setJoinPending(false);
  };

  return (
    <div className="thread">
      <header className="thread-head">
        {showBack && (
          <button className="thread-back" onClick={onBack} aria-label={t("thread.back", "Back to chats")}>
            ‹
          </button>
        )}
        <Avatar id={activeConversation.id} label={headerName} src={headerAvatar} size={34} />
        <div className="thread-head-meta">
          <div className="thread-title">
            {headerName}
          </div>
          <div className="thread-sub">
            {isRoom
              ? `${activeConversation.peers.length} member${activeConversation.peers.length === 1 ? "" : "s"}${activeConversation.gate?.rules.length ? " · gated" : " · open"}${policy ? ` · ${policySummary(policy)}` : ""}`
              : shortAddr(activeConversation.peers.find((p) => p !== identity.address) ?? activeConversation.peers[0])}
          </div>
        </div>
        {(isRoom && policy) || isGatedRoom ? (
          <div className="thread-actions">
            {isGatedRoom && !isMember && (
              <Button variant="primary" disabled={joinPending} onClick={requestJoin}>
                {joinPending ? t("thread.requesting", "Requesting...") : t("thread.requestJoin", "Request to join")}
              </Button>
            )}
            {isAdmin && policy && (
              <Button variant={readOnly ? "primary" : "ghost"} disabled={policyPending} onClick={toggleFreeze}>
                {readOnly ? t("thread.unfreeze", "Resume member posting") : t("thread.freeze", "Pause member posting")}
              </Button>
            )}
          </div>
        ) : null}
      </header>

      {!isRoom && peerAddress?.toLowerCase() !== selfAddress && <div className="join-banner dm-controls">
        {!needsConsent && activeConversation.lastReadReceiptAt && <span data-testid="peer-receipt" title={t("thread.receiptMeaning", "The peer sent a read receipt at this time. It does not identify an exact message.")}>
          {t("thread.lastReceipt", "Last read receipt")}: <time dateTime={new Date(activeConversation.lastReadReceiptAt).toISOString()}>{new Date(activeConversation.lastReadReceiptAt).toLocaleString()}</time>
        </span>}
        {activeConversation.blocked ? t("thread.blockedNote", "This conversation is blocked. Messages and receipts are hidden.") : activeConversation.pending ? t("thread.requestNote", "Message request. Accept to reply; no read receipts are sent before acceptance.") : null}
        {needsConsent && <Button disabled={consentPending} onClick={() => void changeConsent("allowed")}>{activeConversation.blocked ? t("thread.unblock", "Unblock conversation") : t("thread.accept", "Accept request")}</Button>}
        {!needsConsent && <label>
          {t("thread.receipts", "Send read receipts")}
          <select aria-label={t("thread.receipts", "Send read receipts")} value={String(receiptOverride(prefs.readReceiptOverrides, activeConversation.id) ?? "inherit")}
            onChange={(event) => setChatReadReceipts(activeConversation.id, event.target.value === "inherit" ? undefined : event.target.value === "true")}>
            <option value="inherit">{t("thread.receiptsDefault", "Use global setting")} ({prefs.readReceiptsDefault ? t("thread.receiptsOn", "On") : t("thread.receiptsOff", "Off")})</option>
            <option value="true">{t("thread.receiptsOn", "On")}</option>
            <option value="false">{t("thread.receiptsOff", "Off")}</option>
          </select>
        </label>}
        {!activeConversation.blocked && <Button variant="ghost" disabled={consentPending} onClick={() => void changeConsent("denied")}>{activeConversation.pending ? t("thread.reject", "Reject and block") : t("thread.block", "Block conversation")}</Button>}
      </div>}
      {joinStatus && (
        <div role="status" className={`join-banner ${joinStatus.ok ? "ok" : "error"}`}>
          {joinStatus.message}
        </div>
      )}

      <nav className="history-controls" aria-label={t("thread.historyNavigation", "Message history navigation")}>
        <Button disabled={historyLoading || !hasOlderMessages} onClick={() => navigateHistory("older")}>{t("thread.older", "Older messages")}</Button>
        {isHistory && <Button disabled={historyLoading} onClick={() => navigateHistory("newer")}>{t("thread.newer", "Newer messages")}</Button>}
        <Button disabled={historyLoading} onClick={() => navigateHistory(isHistory ? "latest" : "refresh")}>{isHistory ? t("thread.latest", "Latest messages") : t("thread.refresh", "Refresh messages")}</Button>
        {historyLoading && <span role="status">{t("thread.loadingHistory", "Loading messages…")}</span>}
      </nav>
      <div ref={messagesRef} role="region" aria-label={t("thread.history", "Message history")} tabIndex={0}
        className={`messages ${messages.length ? "has-msgs" : ""}`} onScroll={() => {
          const element = messagesRef.current;
          if (!element) return;
          nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
          if (nearBottomRef.current) { setHasNewMessages(false); markVisibleRead(); }
        }}>
        {messages.length === 0 && !historyLoading && <Empty icon="✍️" title={t("thread.noMessagesTitle", "No messages yet")} hint={t("thread.noMessagesHint", "Say hello")} />}
        {(activeConversation.blocked ? [] : messages).map((m) => {
          const mine = m.sender.toLowerCase() === selfAddress;
          const senderRecord = profiles.get(m.sender.toLowerCase());
          const parent = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
          return (
            <div key={m.id} className={`msg-row ${mine ? "mine" : ""}`}>
              {!mine && <Avatar id={m.sender} size={28} label={nameFor(m.sender, senderRecord)} src={senderRecord?.avatar ?? undefined} />}
              <div className="msg-bubble-wrap">
                {m.replyTo && (
                  <div className="msg-reply-ref">↩ {(parent?.body ?? m.replyPreview)?.slice(0, 60) ?? t("thread.earlierReply", "Reply to an earlier message")}</div>
                )}
                <div className="msg-bubble">
                  <span className="msg-body">{m.body}</span>
                  <span className="msg-time">{fmtTime(m.sentAt)}</span>
                </div>
                <div className="msg-tools">
                  {EMOJIS.map((e) => (
                    <button key={e} className="react-btn" disabled={Boolean(needsConsent || postingBlocked)} aria-label={`${t("thread.reactWith", "React with")} ${e}`} onClick={() => {
                      void react(m.id, e).catch((error) => setJoinStatus({ ok: false, message: error instanceof Error ? error.message : t("thread.actionFailed", "This action failed. Try again.") }));
                    }}>{e}</button>
                  ))}
                  <button className="react-btn" disabled={Boolean(needsConsent || postingBlocked)} aria-label={t("thread.reply", "Reply")} onClick={() => setReplyTo(m.id)}>↩</button>
                </div>
                {m.reactions && Object.keys(m.reactions).length > 0 && (
                  <div className="msg-reactions">
                    {Object.entries(m.reactions).map(([e, who]) => (
                      <span key={e} className="reaction-chip">{e} {who.length}</span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        <div ref={endRef} />
      </div>

      {hasNewMessages && !isHistory && <button className="btn btn-ghost" onClick={scrollToLatest}>{t("thread.newMessages", "New messages — jump to latest")}</button>}
      {replyTarget && !needsConsent && (
        <div className="reply-banner">
          {t("thread.replyingTo", "Replying to:")} <em>{replyTarget.body.slice(0, 80)}</em>
          <button className="icon-btn" aria-label={t("thread.cancelReply", "Cancel reply")} onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {sendError?.id === conversationKey && <div className="join-banner error" role="alert">{sendError.message} {t("thread.draftKept", "Your draft has been kept.")}</div>}
      {isGatedRoom && <div className="muted">{t("thread.roomId", "Room ID")}: {activeConversation.id}</div>}
      {readOnly && isAdmin && <div className="join-banner">{t("thread.adminPosting", "Member posting is paused in Chirpy. Administrators can still post; other clients may ignore this policy.")}</div>}
      {needsConsent ? <div className="composer readonly-note">{t("thread.acceptToSend", "Accept or unblock this conversation to send messages.")}</div> : isGatedRoom && !isMember ? <div className="composer readonly-note">{t("thread.joinToSend", "Join this room to send messages.")}</div> : postingBlocked ? (
        <div className="composer readonly-note">{t("thread.readOnly", "Member posting is paused in Chirpy. Other clients may still send messages.")}</div>
      ) : (
        <form className="composer" onSubmit={submit}>
          <input
            aria-label={t("thread.compose", "Write a message")}
            className="composer-input"
            placeholder={`${t("thread.messagePrefix", "Message")} ${isRoom ? "#" + activeConversation.title : activeConversation.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={!draft.trim() || sending !== null}>{sending === conversationKey ? t("thread.sending", "Sending…") : t("thread.send", "Send")}</button>
        </form>
      )}
    </div>
  );
}
