export interface EnsRecord {
  address?: string | null;
  name?: string | null;
  displayName?: string | null;
  avatar?: string | null;
}

const ENS_API = "https://api.ensideas.com/ens/resolve";

export const isAddress = (value: string) => /^0x[a-fA-F0-9]{40}$/.test(value.trim());
export const isEnsName = (value: string) => /^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.eth$/i.test(value.trim());

export async function resolveEns(input: string): Promise<EnsRecord> {
  const res = await fetch(`${ENS_API}/${encodeURIComponent(input.trim())}`);
  if (!res.ok) throw new Error("ENS lookup failed");
  return await res.json() as EnsRecord;
}
