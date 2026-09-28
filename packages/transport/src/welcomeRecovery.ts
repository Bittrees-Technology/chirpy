/** Bounded V3 invitation lookup. Crypto and membership validation remain in WASM.
 * Wire fields match xmtp.mls.api.v1 QueryWelcomeMessages/WelcomeMessage.V1.
 */
const MAX_ENVELOPE = 1_048_576;
const MAX_RESPONSE = MAX_ENVELOPE + 65_536;
const MAX_ID = 9_223_372_036_854_775_807n;
const unavailable = () => new Error('The selected invitation could not be verified. No recovery was performed.');

export function validateRecoverySelection(conversationId: string, invitationId: string): bigint {
  if (!/^(?:[a-f0-9]{2}){1,128}$/.test(conversationId) || !/^[1-9][0-9]{0,18}$/.test(invitationId)) throw unavailable();
  const id = BigInt(invitationId);
  if (id > MAX_ID) throw unavailable();
  return id;
}

function varint(value: bigint): number[] {
  const bytes: number[] = [];
  do { const byte = Number(value & 127n); value >>= 7n; bytes.push(byte | (value ? 128 : 0)); } while (value);
  return bytes;
}
function readVarint(bytes: Uint8Array, position: { at: number }): bigint {
  let value = 0n;
  for (let index = 0; index < 10; index++) {
    const byte = bytes[position.at++];
    if (byte === undefined || (index === 9 && byte > 1)) throw unavailable();
    value |= BigInt(byte & 127) << BigInt(index * 7);
    if (!(byte & 128)) return value;
  }
  throw unavailable();
}
type Field = { tag: number; value: bigint | Uint8Array };
function fields(bytes: Uint8Array): Field[] {
  const position = { at: 0 }, result: Field[] = [];
  while (position.at < bytes.length) {
    if (result.length >= 64) throw unavailable();
    const key = readVarint(bytes, position);
    if (key > 0xffff_ffffn || key < 8n) throw unavailable();
    const tag = Number(key >> 3n), wire = Number(key & 7n);
    if (wire === 0) result.push({ tag, value: readVarint(bytes, position) });
    else if (wire === 1 || wire === 2 || wire === 5) {
      const length = wire === 2 ? readVarint(bytes, position) : BigInt(wire === 1 ? 8 : 4);
      if (length > BigInt(bytes.length - position.at)) throw unavailable();
      const end = position.at + Number(length);
      result.push({ tag, value: bytes.slice(position.at, end) }); position.at = end;
    } else throw unavailable();
  }
  return result;
}
function only(input: Field[], tag: number): bigint | Uint8Array {
  const matches = input.filter(field => field.tag === tag);
  if (matches.length !== 1) throw unavailable();
  return matches[0].value;
}
function bytes(input: bigint | Uint8Array): Uint8Array {
  if (!(input instanceof Uint8Array)) throw unavailable();
  return input;
}
function frame(payload: Uint8Array): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(payload.length + 5);
  new DataView(data.buffer).setUint32(1, payload.length); data.set(payload, 5); return data;
}
function decodeResponse(data: Uint8Array, headerStatus: string | null): Uint8Array {
  let at = 0, message: Uint8Array | undefined, trailerSeen = false;
  let status = headerStatus;
  while (at < data.length) {
    if (data.length - at < 5 || trailerSeen) throw unavailable();
    const flag = data[at], length = new DataView(data.buffer, data.byteOffset + at, 5).getUint32(1); at += 5;
    if (length > data.length - at) throw unavailable();
    const payload = data.slice(at, at + length); at += length;
    if (flag === 0 && !message) message = payload;
    else if (flag === 128) {
      trailerSeen = true;
      const entries = new TextDecoder('utf-8', { fatal: true }).decode(payload).split('\r\n').filter(line => /^grpc-status:/i.test(line));
      if (entries.length !== 1) throw unavailable();
      const next = entries[0].slice(entries[0].indexOf(':') + 1).trim();
      if (status !== null && status !== next) throw unavailable();
      status = next;
    } else throw unavailable();
  }
  if (status !== '0' || !message) throw unavailable();
  return message;
}

export async function fetchRecoveryWelcome(network: 'dev' | 'production', installationId: string, invitationId: bigint,
  fetcher: typeof fetch = fetch): Promise<Uint8Array> {
  if (!['dev', 'production'].includes(network) || !/^[a-f0-9]{64}$/.test(installationId) || invitationId <= 0n || invitationId > MAX_ID) throw unavailable();
  const installation = Uint8Array.from(installationId.match(/../g)!, hex => parseInt(hex, 16));
  const paging = [8, 1, 16, 1, 24, ...varint(invitationId - 1n)]; // ascending, one result, exact predecessor
  const request = frame(new Uint8Array([10, 32, ...installation, 18, ...varint(BigInt(paging.length)), ...paging]));
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetcher(`https://api.${network}.xmtp.network:5558/xmtp.mls.api.v1.MlsApi/QueryWelcomeMessages`, {
      method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store', signal: controller.signal,
      headers: { 'content-type': 'application/grpc-web+proto', 'x-grpc-web': '1' }, body: request,
    });
    if (!response.ok || !/^application\/grpc-web(?:\+proto)?(?:;|$)/i.test(response.headers.get('content-type') ?? '') || !response.body) throw unavailable();
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const result = await reader.read(); if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_RESPONSE) { controller.abort(); await reader.cancel(); throw unavailable(); }
        chunks.push(result.value);
      }
    } finally { reader.releaseLock(); }
    const combined = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { combined.set(chunk, offset); offset += chunk.length; }
    const responseFields = fields(decodeResponse(combined, response.headers.get('grpc-status')));
    const envelope = bytes(only(responseFields, 1));
    if (envelope.length > MAX_ENVELOPE) throw unavailable();
    const version = fields(envelope);
    if (version.length !== 1 || version[0].tag !== 1) throw unavailable();
    const welcome = fields(bytes(version[0].value));
    if (only(welcome, 1) !== invitationId) throw unavailable();
    const recipient = bytes(only(welcome, 3));
    if (recipient.length !== installation.length || !recipient.every((byte, index) => byte === installation[index])) throw unavailable();
    return envelope;
  } finally { clearTimeout(timer); }
}
