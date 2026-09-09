import React, { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import en from "./langs/en.json";
import es from "./langs/es.json";

// Lightweight, file-based i18n — community-contributed `langs/*.json`. Add a
// language by dropping in a JSON file and registering it here; missing keys
// fall back to English, then the key.

type Dict = Record<string, string>;
export const LANGS = {
  en: { label: "English", dict: en as Dict },
  es: { label: "Español", dict: es as Dict },
};
export type LangCode = keyof typeof LANGS;
function isLanguage(value: unknown): value is LangCode {
  return typeof value === "string" && Object.hasOwn(LANGS, value);
}

const KEY = "chat:lang:v1";

interface I18nCtx { lang: LangCode; setLang: (l: LangCode) => void; t: (key: string, fallback?: string, values?: Record<string, string | number>) => string; }
const I18nContext = createContext<I18nCtx | null>(null);

export function I18nProvider({ children }: { children: React.ReactNode }) {
  const [lang, setLangState] = useState<LangCode>(() => {
    try { const v = localStorage.getItem(KEY); if (isLanguage(v)) return v; } catch { /* */ }
    return "en";
  });
  const setLang = useCallback((value: LangCode) => {
    if (isLanguage(value)) setLangState(value);
  }, []);
  useEffect(() => {
    document.documentElement.lang = lang;
    try { localStorage.setItem(KEY, lang); } catch { /* */ }
  }, [lang]);

  const t = useCallback((key: string, fallback?: string, values?: Record<string, string | number>) => {
    const dictionary = LANGS[lang].dict;
    const template = (Object.hasOwn(dictionary, key) ? dictionary[key] : undefined)
      ?? (Object.hasOwn(LANGS.en.dict, key) ? LANGS.en.dict[key] : undefined) ?? fallback ?? key;
    return template.replace(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g, (placeholder, name) =>
      values && Object.hasOwn(values, name) ? String(values[name]) : placeholder);
  }, [lang]);

  const value = useMemo<I18nCtx>(() => ({ lang, setLang, t }), [lang, setLang, t]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const c = useContext(I18nContext);
  if (!c) throw new Error("useI18n outside provider");
  return c;
}
