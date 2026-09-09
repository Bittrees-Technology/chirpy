/** Debounce bursts and serialize refreshes, retaining one trailing invalidation. */
export function createRefreshQueue(refresh: () => Promise<void>, onError: (error: unknown) => void, delay = 150) {
  let pending = false;
  let running = false;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (stopped || running || timer !== null) return;
    timer = setTimeout(async () => {
      timer = null;
      if (stopped || !pending) return;
      pending = false;
      running = true;
      try { await refresh(); }
      catch (error) { if (!stopped) onError(error); }
      finally { running = false; if (pending) schedule(); }
    }, delay);
  };
  return {
    notify() { if (!stopped) { pending = true; schedule(); } },
    cancel() { stopped = true; pending = false; if (timer !== null) clearTimeout(timer); timer = null; },
  };
}
