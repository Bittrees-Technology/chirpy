import { isAddress, isEnsName } from "./ens";

export type Recipient = { kind: "wallet" | "ens" | "email"; value: string };
/** A single recipient only. Never interpret URL schemes, headers or display names. */
export function parseRecipient(raw: string): Recipient | null {
  if (raw.length > 254 || /[\r\n\x00-\x1f\x7f]/.test(raw)) return null;
  const value = raw.trim();
  if (isAddress(value)) return { kind: "wallet", value };
  if (isEnsName(value)) return { kind: "ens", value: value.toLowerCase() };
  const parts = value.split("@");
  if (parts.length !== 2) return null;
  const [local, domain] = parts;
  if (!local || local.length > 64 || !/^[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+(?:\.[a-zA-Z0-9!#$&'*+\-/=^_`{|}~]+)*$/.test(local)) return null;
  if (!domain.includes(".") || !domain.split(".").every(p => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(p))) return null;
  return { kind: "email", value: `${local}@${domain.toLowerCase()}` };
}

export function emailComposeUrl(raw: string): string | null {
  const recipient = parseRecipient(raw);
  return recipient?.kind === "email" ? `mailto:${encodeURIComponent(recipient.value)}` : null;
}

/** Fragment stays out of HTTP requests; opening a link never sends or enables an inbox. */
export function walletChatLink(base: string, raw: string): string | null {
  const recipient = parseRecipient(raw);
  if (!recipient || recipient.kind === "email") return null;
  const url = new URL(base);
  if (url.protocol !== "https:" || url.username || url.password) return null;
  url.search = "";
  url.hash = new URLSearchParams({ to: recipient.value }).toString();
  return url.href;
}

export function recipientFromFragment(fragment: string): string | null {
  if (fragment.length > 1024) return null;
  const params = new URLSearchParams(fragment.replace(/^#/, ""));
  if ([...params.keys()].some(key => key !== "to") || params.getAll("to").length !== 1) return null;
  const recipient = parseRecipient(params.get("to") ?? "");
  return recipient && recipient.kind !== "email" ? recipient.value : null;
}
