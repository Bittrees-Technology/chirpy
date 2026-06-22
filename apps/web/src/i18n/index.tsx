import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import en from "./langs/en.json";
import es from "./langs/es.json";

// Lightweight, file-based i18n — community-contributed `langs/*.json`. Add a
// language by dropping in a JSON file and registering it here; missing keys
// fall back to English, then the key.

type Dict = Record<string, string>;
export const LANGS: Record<string, { label: string; dict: Dict }> = {
  en: { label: "English", dict: en as Dict },
  es: { label: "Español", dict: es as Dict },
};
export type LangCode = keyof typeof LANGS;

const KEY = "chat:lang:v1";

interface I18nCtx { lang: LangCode; setLang: (l: LangCode) => void; t: (key: string, fallback?: string) => string; }
const I18nContext = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(() => {
    try { const v = localStorage.getItem(KEY); if (v && v in LANGS) return v as LangCode; } catch { /* */ }
    return "en";
  });
  useEffect(() => { try { localStorage.setItem(KEY, lang); } catch { /* */ } }, [lang]);

  const t = useCallback((key: string, fallback?: string) => {
    return LANGS[lang]?.dict[key] ?? LANGS.en.dict[key] ?? fallback ?? key;
  }, [lang]);

  const value = useMemo<I18nCtx>(() => ({ lang, setLang: setLangState, t }), [lang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useI18n outside provider");
  return c;
}
