import React, { useEffect, useRef, useState } from "react";
import { policySummary, type Policy } from "@app/core";
import { useChat, useIdentity } from "../state";
import { Avatar, Button, Empty, fmtTime, shortAddr } from "../ui";
import { nameFor, useEnsProfiles } from "../useEns";
import { useI18n } from "../i18n";

const EMOJIS = ["👍", "❤️", "😂", "🎉", "🤝"];

export function Thread({ showBack = false, onBack }: { showBack?: boolean; onBack?: () => void }) {
  const { activeConversation, messages, send, react, setRoomPolicy, requestRoomJoin } = useChat();
  const { identity } = useIdentity();
  const { t } = useI18n();
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [joinStatus, setJoinStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [joinPending, setJoinPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);
  const selfAddress = identity.address.toLowerCase();

  const isRoomConv = activeConversation?.kind === "room";
  const peerAddress = activeConversation && !isRoomConv
    ? (activeConversation.peers.find((p) => p.toLowerCase() !== selfAddress) ?? activeConversation.peers[0])
    : undefined;
  // Resolve the peer + every message sender to ENS (name + avatar), cached app-wide.
  const profiles = useEnsProfiles([peerAddress, ...messages.map((m) => m.sender)]);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, activeConversation?.id]);
  useEffect(() => { setReplyTo(null); setDraft(""); setJoinStatus(null); }, [activeConversation?.id]);

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
    const body = draft;
    setDraft(""); setReplyTo(null);
    await send(body, replyTo ?? undefined);
  };

  const replyTarget = replyTo ? messages.find((m) => m.id === replyTo) : null;
  const isRoom = activeConversation.kind === "room";
  const policy: Policy | null = isRoom ? (activeConversation.policy ?? null) : null;
  const readOnly = policy?.mode === "read-only";
  const isGatedRoom = isRoom && Boolean(activeConversation.gate?.rules.length);
  const isMember = activeConversation.peers.some((peer) => peer.toLowerCase() === identity.address.toLowerCase());
  const toggleFreeze = () => {
    if (!policy) return;
    void setRoomPolicy({ ...policy, mode: readOnly ? "active" : "read-only" });
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
          <button className="thread-back" onClick={onBack} aria-label="Back to chats">
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
            {isRoom && policy && (
              <Button variant={readOnly ? "primary" : "ghost"} onClick={toggleFreeze}>
                {readOnly ? t("thread.unfreeze", "Unfreeze") : t("thread.freeze", "Freeze")}
              </Button>
            )}
          </div>
        ) : null}
      </header>

      {joinStatus && (
        <div className={`join-banner ${joinStatus.ok ? "ok" : "error"}`}>
          {joinStatus.message}
        </div>
      )}

      <div className={`messages ${messages.length ? "has-msgs" : ""}`}>
        {messages.length === 0 && <Empty icon="✍️" title={t("thread.noMessagesTitle", "No messages yet")} hint={t("thread.noMessagesHint", "Say hello")} />}
        {messages.map((m) => {
          const mine = m.sender.toLowerCase() === selfAddress;
          const senderRecord = profiles.get(m.sender.toLowerCase());
          const parent = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
          return (
            <div key={m.id} className={`msg-row ${mine ? "mine" : ""}`}>
              {!mine && <Avatar id={m.sender} size={28} label={nameFor(m.sender, senderRecord)} src={senderRecord?.avatar ?? undefined} />}
              <div className="msg-bubble-wrap">
                {parent && (
                  <div className="msg-reply-ref">↩ {parent.body.slice(0, 60)}</div>
                )}
                <div className="msg-bubble">
                  <span className="msg-body">{m.body}</span>
                  <span className="msg-time">{fmtTime(m.sentAt)}</span>
                </div>
                <div className="msg-tools">
                  {EMOJIS.map((e) => (
                    <button key={e} className="react-btn" onClick={() => react(m.id, e)}>{e}</button>
                  ))}
                  <button className="react-btn" onClick={() => setReplyTo(m.id)}>↩</button>
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

      {replyTarget && (
        <div className="reply-banner">
          {t("thread.replyingTo", "Replying to:")} <em>{replyTarget.body.slice(0, 80)}</em>
          <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {readOnly ? (
        <div className="composer readonly-note">{t("thread.readOnly", "🔒 This room is read-only. Posting is frozen.")}</div>
      ) : (
        <form className="composer" onSubmit={submit}>
          <input
            className="composer-input"
            placeholder={`${t("thread.messagePrefix", "Message")} ${isRoom ? "#" + activeConversation.title : activeConversation.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>{t("thread.send", "Send")}</button>
        </form>
      )}
    </div>
  );
}
