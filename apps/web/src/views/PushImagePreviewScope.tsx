import React, { createContext, useMemo, useState } from 'react';
export const PushImagePreviewContext = createContext<{ active: string | null; setActive(id: string | null): void } | null>(null);
/** One decoded preview per visible conversation, independent of file count. */
export function PushImagePreviewScope({ children }: { children: React.ReactNode }) {
  const [active, setActive] = useState<string | null>(null);
  const value = useMemo(() => ({ active, setActive }), [active]);
  return <PushImagePreviewContext.Provider value={value}>{children}</PushImagePreviewContext.Provider>;
}
