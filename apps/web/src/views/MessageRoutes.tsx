import { WalletEmail } from "./WalletEmail";
import React from "react";
import { useIdentity, useChat } from "../state";
import { useI18n } from "../i18n";
import { Button, Field } from "../ui";
import { walletChatLink } from "../messageRouting";

export function MessageRoutes({ onCompose }: { onCompose: () => void }) {
  const { t } = useI18n();
  const { identity } = useIdentity();
  const { transportId, transportStatus } = useChat();
  const link = transportId === "xmtp" && transportStatus === "ready" && import.meta.env.VITE_XMTP_ENV !== "dev"
    ? walletChatLink("https://chirpy.bittrees.org/", identity.address) : null;
  return <section className="settings" aria-label={t("routing.title")}>
    <h1>{t("routing.title")}</h1>
    <p>{t("routing.intro")}</p>
    <div className="card">
      <h2>{t("routing.walletTitle")}</h2>
      <p>{t("routing.walletDescription")}</p>
      <Button variant="primary" onClick={onCompose}>{t("routing.compose")}</Button>
      {link ? <Field label={t("routing.shareLabel")} hint={t("routing.shareHint")}>
        <input className="input" readOnly value={link} onFocus={e => e.target.select()} />
      </Field> : <p>{t("routing.enableHint")}</p>}
    </div>
    <div className="card">
      <h2>{t("routing.emailTitle")}</h2>
      <p>{t("routing.emailNotice")}</p>
    </div>
    <WalletEmail key={identity.address} />
    <div className="card">
      <h2>{t("routing.bridgeTitle")}</h2>
      <p>{t("routing.bridgeNotice")}</p>
      <p>{t("routing.bridgePrivacy")}</p>
    </div>
  </section>;
}
