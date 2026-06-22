import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IdentityProvider, OrgProvider, ChatProvider, SettingsPrefsProvider } from "./state";
import { I18nProvider } from "./i18n";
import { ErrorBoundary } from "./ErrorBoundary";
import "./styles.css";

const root = document.getElementById("root")!;
createRoot(root).render(
  <React.StrictMode>
    <ErrorBoundary>
      <I18nProvider>
        <IdentityProvider>
          <SettingsPrefsProvider>
            <OrgProvider>
              <ChatProvider>
                <App />
              </ChatProvider>
            </OrgProvider>
          </SettingsPrefsProvider>
        </IdentityProvider>
      </I18nProvider>
    </ErrorBoundary>
  </React.StrictMode>,
);
