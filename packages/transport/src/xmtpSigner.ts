import type { IdentifierKind, Signer } from "@xmtp/browser-sdk";

interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] }): Promise<unknown>;
}

const textEncoder = new TextEncoder();

const bytesToHex = (bytes: Uint8Array) =>
  `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;

const hexToBytes = (hex: string) => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (!clean || clean.length % 2 !== 0 || /[^a-fA-F0-9]/.test(clean)) {
    throw new Error("Wallet returned an invalid signature.");
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
};

export function makeInjectedSigner(
  provider: Eip1193Provider,
  address: string,
  identifierKind: IdentifierKind = 0 as IdentifierKind,
): Signer {
  const identifier = { identifier: address.toLowerCase(), identifierKind };
  return {
    type: "EOA",
    getIdentifier: () => identifier,
    signMessage: async (message: string): Promise<Uint8Array> => {
      const signature = await provider.request({
        method: "personal_sign",
        params: [bytesToHex(textEncoder.encode(message)), address],
      });
      if (typeof signature !== "string") throw new Error("Wallet did not return a signature.");
      return hexToBytes(signature);
    },
  };
}
