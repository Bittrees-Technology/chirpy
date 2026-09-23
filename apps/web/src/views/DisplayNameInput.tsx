import React, { useEffect, useRef, useState } from 'react';

/** Keep typing independent of asynchronous persistence; identity reflects committed values only. */
export function DisplayNameInput({ value, save }: { value: string; save: (value: string) => Promise<void> }) {
  const [draft, setDraft] = useState(value);
  const committed = useRef(value); committed.current = value;
  const pending = useRef(0); const active = useRef(true); const editing = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  useEffect(() => { if (!pending.current && !editing.current) setDraft(value); }, [value]);
  const change = async (next: string) => {
    setDraft(next); pending.current++;
    try { await save(next); }
    finally {
      pending.current--;
      if (active.current && !pending.current && !editing.current) setDraft(committed.current);
    }
  };
  return <input className="input" maxLength={80} value={draft}
    onFocus={() => { editing.current = true; }}
    onBlur={() => { editing.current = false; if (!pending.current) setDraft(committed.current); }}
    onChange={event => { void change(event.target.value); }} />;
}
