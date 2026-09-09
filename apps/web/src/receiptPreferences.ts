export type ReceiptOverrides = Record<string, boolean>;

export function receiptPreferenceKey(conversationId: string) {
  const transport = import.meta.env.VITE_TRANSPORT === "xmtp" ? "xmtp" : "mock";
  const network = import.meta.env.VITE_XMTP_ENV === "dev" ? "dev" : "production";
  return `${transport}:${network}:${conversationId}`;
}

export function normalizeReceiptOverrides(value: unknown): ReceiptOverrides {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, on]) =>
    /^(mock|xmtp):(dev|production):[a-zA-Z0-9_-]{1,256}$/.test(key) && typeof on === "boolean",
  ));
}

export function receiptOverride(overrides: ReceiptOverrides | undefined, conversationId: string): boolean | undefined {
  const key = receiptPreferenceKey(conversationId);
  return overrides && Object.hasOwn(overrides, key) && typeof overrides[key] === "boolean" ? overrides[key] : undefined;
}
