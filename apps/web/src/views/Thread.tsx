import React, { useEffect, useRef, useState } from "react";
import { policySummary, type Policy } from "@app/core";
import { useChat, useIdentity } from "../state";
import { Avatar, Button, Empty, fmtTime, shortAddr } from "../ui";

const EMOJIS = ["👍", "❤️", "😂", "🎉", "🤝"];

export function Thread() {
  const { activeConversation, messages, send, react, setRoomPolicy, requestRoomJoin } = useChat();
  const { identity } = useIdentity();
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [joinStatus, setJoinStatus] = useState<{ ok: boolean; message: string } | null>(null);
  const [joinPending, setJoinPending] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages.length, activeConversation?.id]);
  useEffect(() => { setReplyTo(null); setDraft(""); setJoinStatus(null); }, [activeConversation?.id]);

  if (!activeConversation) {
    return <div className="thread"><Empty icon="💬" title="Select a conversation" hint="or start a new one from the left" /></div>;
  }

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
        <Avatar id={activeConversation.id} label={activeConversation.title} size={34} />
        <div className="thread-head-meta">
          <div className="thread-title">
            {isRoom ? `# ${activeConversation.title}` : activeConversation.title}
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
                {joinPending ? "Requesting..." : "Request to join"}
              </Button>
            )}
            {isRoom && policy && (
              <Button variant={readOnly ? "primary" : "ghost"} onClick={toggleFreeze}>
                {readOnly ? "Unfreeze" : "Freeze"}
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

      <div className="messages">
        {messages.length === 0 && <Empty icon="✍️" title="No messages yet" hint="Say hello" />}
        {messages.map((m) => {
          const mine = m.sender === identity.address;
          const parent = m.replyTo ? messages.find((x) => x.id === m.replyTo) : null;
          return (
            <div key={m.id} className={`msg-row ${mine ? "mine" : ""}`}>
              {!mine && <Avatar id={m.sender} size={28} />}
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
          Replying to: <em>{replyTarget.body.slice(0, 80)}</em>
          <button className="icon-btn" onClick={() => setReplyTo(null)}>✕</button>
        </div>
      )}

      {readOnly ? (
        <div className="composer readonly-note">🔒 This room is read-only. Posting is frozen.</div>
      ) : (
        <form className="composer" onSubmit={submit}>
          <input
            className="composer-input"
            placeholder={`Message ${isRoom ? "#" + activeConversation.title : activeConversation.title}`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            autoFocus
          />
          <button className="btn btn-primary" type="submit" disabled={!draft.trim()}>Send</button>
        </form>
      )}
    </div>
  );
}
