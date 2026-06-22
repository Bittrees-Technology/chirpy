import React from "react";
import type { ConversationKind } from "@app/transport";
import { useChat } from "../state";
import { Avatar, Empty, fmtTime } from "../ui";

export function ConversationColumn(
  { kind, title, onNew, newLabel }:
  { kind: ConversationKind; title: string; onNew: () => void; newLabel: string },
) {
  const { conversations, activeId, select } = useChat();
  const items = conversations.filter((c) => c.kind === kind);

  return (
    <div className="list-col">
      <div className="list-head">
        <h1>{title}</h1>
        <button className="btn btn-primary btn-sm" onClick={onNew}>{newLabel}</button>
      </div>
      <div className="list-scroll">
        {items.length === 0 && <Empty icon={kind === "room" ? "🏛️" : "📭"} title={`No ${kind === "room" ? "rooms" : "chats"} yet`} hint={newLabel} />}
        {items.map((c) => {
          const peerLabel = kind === "room" ? `# ${c.title}` : c.title;
          return (
            <button
              key={c.id}
              className={`list-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => select(c.id)}
            >
              <Avatar id={c.id} label={c.title} />
              <div className="list-item-main">
                <div className="list-item-top">
                  <span className="list-item-title">{peerLabel}</span>
                  {c.lastMessage && <span className="list-item-time">{fmtTime(c.lastMessage.sentAt)}</span>}
                </div>
                <div className="list-item-bottom">
                  <span className="list-item-preview">{c.lastMessage?.body ?? c.description ?? "—"}</span>
                  {c.unread > 0 && <span className="badge">{c.unread}</span>}
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
