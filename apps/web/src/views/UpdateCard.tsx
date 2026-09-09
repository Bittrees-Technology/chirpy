import React, { useState } from "react";
import { Button } from "../ui";
import { useI18n } from "../i18n";
import { APP_VERSION } from "../app.config";
import { isDesktopApp, runUpdate, relaunchApp, type UpdateStatus } from "../update";

export function UpdateCard() {
  const { t } = useI18n();
  const [status, setStatus] = useState<UpdateStatus>({ state: isDesktopApp() ? "idle" : "unsupported" });
  const busy = status.state === "checking" || status.state === "downloading" || status.state === "installing";

  const label = (() => {
    switch (status.state) {
      case "unsupported": return t("update.unsupported");
      case "idle": return t("update.idle");
      case "checking": return t("update.checking");
      case "available": return t("update.available", undefined, { version: status.version }) + (status.notes ? ` — ${status.notes}` : "");
      case "uptodate": return t("update.latest");
      case "downloading": return t("update.downloading") + (status.pct != null ? ` ${status.pct}%` : "");
      case "installing": return t("update.installing");
      case "ready": return t("update.ready");
      case "error": return t("update.error", undefined, { message: status.message });
    }
  })();

  return (
    <section className="card">
      <h2>{t("update.title")}</h2>
      <p className="muted">
        {t("update.version")} <span className="pill">v{APP_VERSION}</span> · {t("update.channel")} <span className="pill">{t("update.stable")}</span>
      </p>
      <p className="muted">{label}</p>
      <div className="row-end gate-add">
        {status.state !== "unsupported" && status.state !== "ready" && (
          <Button variant="ghost" disabled={busy} onClick={() => runUpdate(setStatus)}>
            {status.state === "checking" ? t("update.checkingShort") : t("update.check")}
          </Button>
        )}
        {status.state === "available" && (
          <Button variant="primary" disabled={busy} onClick={() => runUpdate(setStatus, { autoInstall: true })}>
            {t("update.install")}
          </Button>
        )}
        {status.state === "ready" && (
          <Button variant="primary" onClick={() => relaunchApp()}>{t("update.restart")}</Button>
        )}
      </div>
    </section>
  );
}
