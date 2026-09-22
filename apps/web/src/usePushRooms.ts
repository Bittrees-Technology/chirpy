import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { PushRoomSession, PushRooms, type PushRoomsSnapshot, type PushSource, type PushWalletProvider } from '@app/transport';
import { getActiveKind, getActiveProvider, getProviderRevision, subscribeProvider } from './walletProviders';
const empty = (): PushRoomsSnapshot => ({ rooms: [], status: 'idle', revision: 0, loading: false });
/** The adapter belongs to one live wallet/provider/org/source binding, even if the address stays the same. */
export function usePushRooms(owner: string, walletMode: boolean, organization: string, onInvalidate: () => void) {
  const connectionRevision = useSyncExternalStore(subscribeProvider, getProviderRevision);
  const [source, setSource] = useState<PushSource | null>(null);
  const [snapshot, setSnapshot] = useState<PushRoomsSnapshot>(empty);
  const [error, setError] = useState<string | null>(null);
  const binding = useMemo(() => ({ owner, walletMode, organization, source, connectionRevision }), [owner, walletMode, organization, source, connectionRevision]);
  const live = useRef(binding); live.current = binding;
  const adapter = useRef<PushRooms | null>(null);
  const adapterBinding = useRef(binding);
  useEffect(() => {
    let disposed = false;
    onInvalidate(); setSnapshot(empty()); setError(null); adapter.current = null;
    if (!source) return;
    const provider = walletMode ? getActiveProvider() : null;
    let session: PushRoomSession | null = null;
    try {
      if (provider && getActiveKind()) session = new PushRoomSession(owner, provider as PushWalletProvider,
        () => !disposed && live.current === binding && getActiveProvider() === provider && getActiveKind() !== null);
    } catch (error) { setError(error instanceof Error ? error.message : 'This wallet cannot enable Push rooms.'); }
    const rooms = new PushRooms(source, owner, session); adapterBinding.current = binding; adapter.current = rooms;
    let previousStatus = rooms.getSnapshot().status;
    const stop = rooms.subscribe(() => {
      if (disposed || live.current !== binding) return;
      const next = rooms.getSnapshot();
      if (previousStatus === 'ready' && next.status !== 'ready') onInvalidate();
      previousStatus = next.status; setSnapshot(next);
    });
    void rooms.discover().catch(() => {}); // The preserved-catalog error is part of the snapshot.
    return () => { disposed = true; if (adapter.current === rooms) adapter.current = null; stop(); rooms.dispose(); };
  }, [binding, onInvalidate]);
  const getAdapter = useCallback(() => adapterBinding.current === live.current ? adapter.current : null, []);
  const changeSource = useCallback((value: PushSource | null) => {
    if (value === source) return;
    if (value !== null && value !== 'governance' && value !== 'research') return;
    // Invalidate synchronously, before React commits the new source selection.
    adapter.current?.dispose(); adapter.current = null; onInvalidate(); setSource(value); setError(null);
  }, [onInvalidate, source]);
  const enable = useCallback(async () => {
    const rooms = adapter.current; if (!rooms) throw new Error('Choose a room source first.');
    setError(null);
    try { await rooms.enable(); }
    catch (error) {
      if (adapter.current === rooms) setError(error instanceof Error ? error.message : 'Push rooms could not be enabled.');
      throw error;
    }
  }, []);
  const refresh = useCallback(async () => { const rooms = adapter.current; if (rooms) await rooms.discover(); }, []);
  return { source, changeSource, snapshot: adapterBinding.current === binding ? snapshot : empty(), error, enable, refresh, getAdapter, connectionRevision };
}
