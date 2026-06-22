import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { IdentityProvider, OrgProvider, ChatProvider } from "./state";
import "./styles.css";

const root = document.getElementById("root")!;
createRoot(root).render(
  <React.StrictMode>
    <IdentityProvider>
      <OrgProvider>
        <ChatProvider>
          <App />
        </ChatProvider>
      </OrgProvider>
    </IdentityProvider>
  </React.StrictMode>,
);
