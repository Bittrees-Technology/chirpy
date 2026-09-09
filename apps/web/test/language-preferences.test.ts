import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { I18nProvider, useI18n } from "../src/i18n";

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.lang = ""; });
it.each(["constructor", "__proto__", "toString", "unknown", "es"])(
  "validates stored language %s and keeps screen-reader language synchronized",
  async (stored) => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    let saved = stored;
    vi.stubGlobal("localStorage", { getItem: () => saved, setItem: (_, value) => { saved = value; } });
    let current: ReturnType<typeof useI18n>;
    function Probe() { current = useI18n(); return React.createElement("span", null, current.t("nav.settings")); }
    const container = document.createElement("div");
    const root = createRoot(container);
    try {
      await act(async () => root.render(React.createElement(I18nProvider, null, React.createElement(Probe))));
      expect(container.textContent).toBe(stored === "es" ? "Ajustes" : "Settings");
      expect(document.documentElement.lang).toBe(stored === "es" ? "es" : "en");
      await act(async () => current.setLang("es"));
      expect(container.textContent).toBe("Ajustes");
      expect(document.documentElement.lang).toBe("es");
      expect(saved).toBe("es");
      await act(async () => current.setLang("constructor" as any));
      expect(container.textContent).toBe("Ajustes");
      expect(saved).toBe("es");
      await act(async () => current.setLang("en"));
      expect(document.documentElement.lang).toBe("en");
    } finally { await act(async () => root.unmount()); }
  },
);
