import React, { useMemo, useState } from "react";
import type { ConversationKind } from "@app/transport";
import { useChat } from "../state";
import { Avatar, Empty, fmtTime } from "../ui";

export function ConversationColumn(
  { kind, title, onNew, newLabel, needsConnect, onOpenSettings }:
  {
    kind: ConversationKind;
    title: string;
    onNew: () => void;
    newLabel: string;
    needsConnect: boolean;
    onOpenSettings: () => void;
  },
) {
  const { conversations, activeId, select } = useChat();
  const [query, setQuery] = useState("");
  const items = conversations.filter((c) => c.kind === kind);
  const normalizedQuery = query.trim().toLowerCase();
  const filteredItems = useMemo(() => {
    if (!normalizedQuery) return items;
    return items.filter((c) => {
      const text = [
        c.title,
        c.description,
        c.lastMessage?.body,
        ...c.peers,
      ].filter(Boolean).join(" ").toLowerCase();
      return text.includes(normalizedQuery);
    });
  }, [items, normalizedQuery]);
  const showConnectEmpty = needsConnect && items.length === 0;

  return (
    <div className="list-col">
      <div className="list-head-wrap">
        <div className="list-head">
          <h1>{title}</h1>
          <button className="btn btn-primary btn-sm" onClick={onNew}>{newLabel}</button>
        </div>
        <input
          className="input list-search"
          value={query}
          placeholder={`Search ${title.toLowerCase()}`}
          aria-label={`Search ${title.toLowerCase()}`}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="list-scroll">
        {showConnectEmpty && (
          <div className="empty">
            <div className="empty-icon">💬</div>
            <div className="empty-title">Start messaging</div>
            <div className="empty-hint">Connect your wallet in Settings to enable encrypted chats.</div>
            <button className="empty-link" onClick={onOpenSettings}>Open Settings →</button>
          </div>
        )}
        {!showConnectEmpty && items.length === 0 && (
          <Empty
            icon={kind === "room" ? "🏛️" : "📭"}
            title={`No ${kind === "room" ? "rooms" : "chats"} yet`}
            hint={newLabel}
          />
        )}
        {items.length > 0 && filteredItems.length === 0 && (
          <Empty icon="🔎" title="No results" hint="Try another search" />
        )}
        {filteredItems.map((c) => {
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
