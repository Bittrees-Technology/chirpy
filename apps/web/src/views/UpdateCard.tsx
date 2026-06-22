import React, { useState } from "react";
import { Button } from "../ui";
import { APP_VERSION } from "../app.config";
import { isDesktopApp, runUpdate, relaunchApp, type UpdateStatus } from "../update";

export function UpdateCard() {
  const [status, setStatus] = useState<UpdateStatus>({ state: isDesktopApp() ? "idle" : "unsupported" });
  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";

  const label = (() => {
    switch (status.state) {
      case "unsupported": return "In-app updates run in the desktop app. The web app updates on reload; iOS updates via the App Store.";
      case "idle": return "Up to date as far as we know — check for a new version.";
      case "checking": return "Checking for updates…";
      case "available": return `Update available: v${status.version}${status.notes ? ` — ${status.notes}` : ""}`;
      case "uptodate": return "You're on the latest version.";
      case "downloading": return `Downloading…${status.pct != null ? ` ${status.pct}%` : ""}`;
      case "installing": return "Installing…";
      case "ready": return "Update installed. Restart to apply.";
      case "error": return `Update error: ${status.message}`;
    }
  })();

  return (
    <section className="card">
      <h2>Software update</h2>
      <p className="muted">
        Current version <span className="pill">v{APP_VERSION}</span> · channel <span className="pill">stable</span>
      </p>
      <p className="muted">{label}</p>
      <div className="row-end gate-add">
        {status.state !== "unsupported" && status.state !== "ready" && (
          <Button variant="ghost" disabled={busy} onClick={() => runUpdate(setStatus)}>
            {status.state === "checking" ? "Checking…" : "Check for updates"}
          </Button>
        )}
        {status.state === "available" && (
          <Button variant="primary" disabled={busy} onClick={() => runUpdate(setStatus, { autoInstall: true })}>
            Download &amp; install
          </Button>
        )}
        {status.state === "ready" && (
          <Button variant="primary" onClick={() => relaunchApp()}>Restart to update</Button>
        )}
      </div>
    </section>
  );
}
