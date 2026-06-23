import React, { useMemo, useState } from "react";
import type { Conversation } from "@app/transport";
import { useChat, useIdentity } from "../state";
import { Avatar, Empty, fmtTime } from "../ui";

export function ConversationColumn(
  { title, onNewDm, onNewRoom, needsConnect, onOpenSettings, onOpenConversation }:
  {
    title: string;
    onNewDm: () => void;
    onNewRoom: () => void;
    needsConnect: boolean;
    onOpenSettings: () => void;
    onOpenConversation: () => void;
  },
) {
  const { conversations, activeId, select, startDm } = useChat();
  const { identity } = useIdentity();
  const [query, setQuery] = useState("");
  const selfAddress = identity.address.toLowerCase();
  const isSelfConversation = (conversation: Conversation) => {
    if (conversation.kind !== "dm") return false;
    const peers = conversation.peers.map((peer) => peer.toLowerCase());
    return peers.length > 0 && peers.every((peer) => peer === selfAddress);
  };
  const savedConversation = conversations.find(isSelfConversation);
  const items = conversations.filter((conversation) => !isSelfConversation(conversation));
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
  const openSavedMessages = async () => {
    if (savedConversation) {
      select(savedConversation.id);
      onOpenConversation();
      return;
    }
    if (needsConnect) {
      onOpenSettings();
      return;
    }
    await startDm(identity.address, "Saved Messages");
    onOpenConversation();
  };
  const openConversation = (id: string) => {
    select(id);
    onOpenConversation();
  };

  return (
    <div className="list-col">
      <div className="list-head-wrap">
        <div className="list-head">
          <h1>{title}</h1>
          <div className="list-actions">
            <button className="btn btn-primary btn-sm" onClick={onNewDm}>+ Chat</button>
            <button className="btn btn-sm" onClick={onNewRoom}>+ Room</button>
          </div>
        </div>
        <button
          className={`list-item saved-row ${savedConversation?.id === activeId ? "active" : ""}`}
          onClick={() => { void openSavedMessages(); }}
        >
          <Avatar id={savedConversation?.id ?? identity.address} label="Saved Messages" />
          <div className="list-item-main">
            <div className="list-item-top">
              <span className="list-item-title">Saved Messages</span>
              {savedConversation?.lastMessage && <span className="list-item-time">{fmtTime(savedConversation.lastMessage.sentAt)}</span>}
            </div>
            <div className="list-item-bottom">
              <span className="list-item-preview">{savedConversation?.lastMessage?.body ?? "Notes to self"}</span>
            </div>
          </div>
        </button>
        <input
          className="input list-search"
          value={query}
          placeholder="Search chats and rooms"
          aria-label="Search chats and rooms"
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
            icon="📭"
            title="No chats yet"
            hint="+ Chat or + Room"
          />
        )}
        {items.length > 0 && filteredItems.length === 0 && (
          <Empty icon="🔎" title="No results" hint="Try another search" />
        )}
        {filteredItems.map((c) => {
          const peerLabel = c.kind === "room" ? `# ${c.title}` : c.title;
          return (
            <button
              key={c.id}
              className={`list-item ${c.id === activeId ? "active" : ""}`}
              onClick={() => openConversation(c.id)}
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
