import React, { createContext, useContext, useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  PERSONAL_ORG, type Identity, type OrgConfig,
} from "@app/core";
import {
  createTransport, type ChatMessage, type Conversation, type StartRoomInput, type Transport,
} from "@app/transport";
import { DEFAULT_TRANSPORT } from "./app.config";

// ---------- storage helpers ----------
const LS = {
  get<T>(k: string, fallback: T): T {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) as T : fallback; } catch { return fallback; }
  },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* */ } },
};
const randAddr = () => {
  const hex = "0123456789abcdef"; let s = "0x";
  for (let i = 0; i < 40; i++) s += hex[Math.floor(Math.random() * 16)];
  return s;
};

// ====================================================================
// Identity
// ====================================================================
interface IdentityCtx { identity: Identity; setHandle: (h: string) => void; reset: () => void; }
const IdentityContext = createContext<IdentityCtx | null>(null);
const IDENTITY_KEY = "chat:identity:v1";

export function IdentityProvider({ children }: { children: React.ReactNode }) {
  const [identity, setIdentity] = useState<Identity>(() =>
    LS.get<Identity>(IDENTITY_KEY, { address: randAddr(), handle: "you" }));
  useEffect(() => { LS.set(IDENTITY_KEY, identity); }, [identity]);
  const value = useMemo<IdentityCtx>(() => ({
    identity,
    setHandle: (h) => setIdentity((p) => ({ ...p, handle: h.trim() || "you" })),
    reset: () => setIdentity({ address: randAddr(), handle: "you" }),
  }), [identity]);
  return <IdentityContext.Provider value={value}>{children}</IdentityContext.Provider>;
}
export const useIdentity = () => {
  const c = useContext(IdentityContext);
  if (!c) throw new Error("useIdentity outside provider");
  return c;
};

// ====================================================================
// Orgs  (org-agnostic: Personal is always present; everything else imported/created)
// ====================================================================
interface OrgCtx {
  orgs: OrgConfig[];
  activeOrg: OrgConfig;
  activeOrgId: string;
  setActiveOrg: (id: string) => void;
  addOrg: (org: OrgConfig) => void;
  removeOrg: (id: string) => void;
}
const OrgContext = createContext<OrgCtx | null>(null);
const ORGS_KEY = "chat:orgs:v1";
const ACTIVE_KEY = "chat:activeOrg:v1";

export function OrgProvider({ children }: { children: React.ReactNode }) {
  const [userOrgs, setUserOrgs] = useState<OrgConfig[]>(() => LS.get<OrgConfig[]>(ORGS_KEY, []));
  const [activeOrgId, setActiveOrgId] = useState<string>(() => LS.get<string>(ACTIVE_KEY, PERSONAL_ORG.id));

  useEffect(() => { LS.set(ORGS_KEY, userOrgs); }, [userOrgs]);
  useEffect(() => { LS.set(ACTIVE_KEY, activeOrgId); }, [activeOrgId]);

  const orgs = useMemo(() => [PERSONAL_ORG, ...userOrgs], [userOrgs]);
  const activeOrg = useMemo(
    () => orgs.find((o) => o.id === activeOrgId) ?? PERSONAL_ORG,
    [orgs, activeOrgId],
  );

  // Apply org branding to the document theme.
  useEffect(() => {
    document.documentElement.style.setProperty("--accent", activeOrg.branding.accent || "#6366f1");
    document.title = `${activeOrg.branding.name} · Parley`;
  }, [activeOrg]);

  const addOrg = useCallback((org: OrgConfig) => {
    setUserOrgs((p) => {
      const without = p.filter((o) => o.id !== org.id);
      return [...without, org];
    });
    setActiveOrgId(org.id);
  }, []);

  const removeOrg = useCallback((id: string) => {
    if (id === PERSONAL_ORG.id) return;
    setUserOrgs((p) => p.filter((o) => o.id !== id));
    setActiveOrgId((cur) => (cur === id ? PERSONAL_ORG.id : cur));
  }, []);

  const value = useMemo<OrgCtx>(() => ({
    orgs, activeOrg, activeOrgId, setActiveOrg: setActiveOrgId, addOrg, removeOrg,
  }), [orgs, activeOrg, activeOrgId, addOrg, removeOrg]);

  return <OrgContext.Provider value={value}>{children}</OrgContext.Provider>;
}
export const useOrgs = () => {
  const c = useContext(OrgContext);
  if (!c) throw new Error("useOrgs outside provider");
  return c;
};

// ====================================================================
// Chat  (binds a Transport to the active org + identity)
// ====================================================================
interface ChatCtx {
  transportId: string;
  conversations: Conversation[];
  activeId: string | null;
  activeConversation: Conversation | null;
  messages: ChatMessage[];
  select: (id: string | null) => void;
  send: (body: string, replyTo?: string) => Promise<void>;
  react: (messageId: string, emoji: string) => Promise<void>;
  startDm: (address: string, handle?: string) => Promise<void>;
  createRoom: (input: StartRoomInput) => Promise<void>;
}
const ChatContext = createContext<ChatCtx | null>(null);

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const { identity } = useIdentity();
  const { activeOrg } = useOrgs();
  const transportRef = useRef<Transport | null>(null);
  const [transportId, setTransportId] = useState("mock");
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  const reloadConversations = useCallback(async () => {
    const t = transportRef.current; if (!t) return;
    setConversations(await t.listConversations());
  }, []);

  const reloadMessages = useCallback(async (id: string | null) => {
    const t = transportRef.current;
    if (!t || !id) { setMessages([]); return; }
    setMessages(await t.listMessages(id));
  }, []);

  // (Re)build the transport whenever the org or identity changes.
  useEffect(() => {
    let unsub = () => {};
    let cancelled = false;
    (async () => {
      const t = createTransport(DEFAULT_TRANSPORT, activeOrg, identity);
      await t.init();
      if (cancelled) return;
      transportRef.current = t;
      setTransportId(t.id);
      setActiveId(null);
      setMessages([]);
      await reloadConversations();
      unsub = t.subscribe(() => {
        reloadConversations();
        setActiveId((cur) => { reloadMessages(cur); return cur; });
      });
    })();
    return () => { cancelled = true; unsub(); };
  }, [activeOrg.id, identity.address]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { reloadMessages(activeId); }, [activeId, reloadMessages]);

  const select = useCallback((id: string | null) => {
    setActiveId(id);
    if (id) transportRef.current?.markRead(id);
  }, []);

  const send = useCallback(async (body: string, replyTo?: string) => {
    if (!activeId || !body.trim()) return;
    await transportRef.current?.send(activeId, body, { replyTo });
    await reloadMessages(activeId);
  }, [activeId, reloadMessages]);

  const react = useCallback(async (messageId: string, emoji: string) => {
    if (!activeId) return;
    await transportRef.current?.react(activeId, messageId, emoji);
    await reloadMessages(activeId);
  }, [activeId, reloadMessages]);

  const startDm = useCallback(async (address: string, handle?: string) => {
    const conv = await transportRef.current?.startDm(address, handle);
    await reloadConversations();
    if (conv) select(conv.id);
  }, [reloadConversations, select]);

  const createRoom = useCallback(async (input: StartRoomInput) => {
    const conv = await transportRef.current?.createRoom(input);
    await reloadConversations();
    if (conv) select(conv.id);
  }, [reloadConversations, select]);

  const activeConversation = useMemo(
    () => conversations.find((c) => c.id === activeId) ?? null,
    [conversations, activeId],
  );

  const value = useMemo<ChatCtx>(() => ({
    transportId, conversations, activeId, activeConversation, messages,
    select, send, react, startDm, createRoom,
  }), [transportId, conversations, activeId, activeConversation, messages, select, send, react, startDm, createRoom]);

  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}
export const useChat = () => {
  const c = useContext(ChatContext);
  if (!c) throw new Error("useChat outside provider");
  return c;
};
