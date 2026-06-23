import { useEffect, useState } from "react";
import { isAddress, resolveEns, type EnsRecord } from "./ens";
import { shortAddr } from "./ui";

// App-wide ENS profile cache (name + avatar), keyed by lowercased address. Resolutions
// are shared and de-duplicated so the conversation list, thread header, and message
// bubbles all reuse one lookup per address instead of refetching.
const cache = new Map<string, EnsRecord>();
const inflight = new Map<string, Promise<EnsRecord>>();

function fetchProfile(address: string): Promise<EnsRecord> {
  const key = address.toLowerCase();
  const cached = cache.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = inflight.get(key);
  if (pending) return pending;
  const p = resolveEns(key)
    .then((rec) => { const out = rec ?? {}; cache.set(key, out); return out; })
    .catch(() => { const empty: EnsRecord = {}; cache.set(key, empty); return empty; })
    .finally(() => { inflight.delete(key); });
  inflight.set(key, p);
  return p;
}

/** Resolve a set of wallet addresses to their ENS profile, cached across the app.
 *  Returns a map keyed by lowercased address; entries fill in as lookups resolve and
 *  the calling component re-renders. Non-address inputs are ignored. */
export function useEnsProfiles(addresses: Array<string | undefined>): Map<string, EnsRecord> {
  const wanted = [...new Set(
    addresses.filter((a): a is string => typeof a === "string" && isAddress(a)).map((a) => a.toLowerCase()),
  )];
  const key = wanted.slice().sort().join(",");
  const [, bump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const todo = wanted.filter((a) => !cache.has(a));
    if (!todo.length) return undefined;
    void Promise.all(todo.map(fetchProfile)).then(() => { if (!cancelled) bump((n) => n + 1); });
    return () => { cancelled = true; };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const out = new Map<string, EnsRecord>();
  for (const a of wanted) { const rec = cache.get(a); if (rec) out.set(a, rec); }
  return out;
}

/** Best display label for a wallet: a user-entered custom name if present, else the
 *  resolved ENS name, else a shortened address. */
export function nameFor(address: string, record?: EnsRecord, custom?: string): string {
  const customName = custom && custom.trim() && !isAddress(custom) ? custom.trim() : undefined;
  const ens = record?.displayName || record?.name || undefined;
  return customName || ens || shortAddr(address);
}
