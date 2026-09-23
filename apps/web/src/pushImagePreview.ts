import { PUSH_FILE_BYTES, type PushAttachment } from '@app/transport';
const MAX_PIXELS = 4_000_000, MAX_SIDE = 4096;
const invalid = (): never => { throw new Error('This image cannot be previewed. Download the original instead.'); };
function dimensions(width: number, height: number) {
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) invalid();
  return { width, height };
}
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n; for (let i = 0; i < 8; i++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0;
});
function crc(bytes: Uint8Array) {
  let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0;
}
// PNG-3 chunk framing/CRC and IHDR, not a pixel decoder. Preview copies omit
// ancillary metadata (including compressed profiles/text); downloads are unchanged.
function png(bytes: Uint8Array) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || signature.some((b, i) => bytes[i] !== b)) invalid();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const parts = [bytes.subarray(0, 8)]; let offset = 8, count = 0, size = 8;
  let width = 0, height = 0, color = -1, depth = 0, palette = 0, transparency = false, data = 0, seenData = false, dataEnded = false, ended = false;
  while (offset < bytes.length) {
    if (++count > 2048 || offset + 12 > bytes.length) invalid();
    const length = view.getUint32(offset), end = offset + 12 + length;
    if (end > bytes.length) invalid();
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!/^[A-Za-z]{4}$/.test(type) || type[2] !== type[2].toUpperCase()
      || crc(bytes.subarray(offset + 4, end - 4)) !== view.getUint32(end - 4)) invalid();
    if (count === 1 && type !== 'IHDR') invalid();
    if (['acTL', 'fcTL', 'fdAT'].includes(type)) invalid(); // No animated PNG decode.
    if (type === 'IHDR') {
      if (count !== 1 || length !== 13) invalid();
      width = view.getUint32(offset + 8); height = view.getUint32(offset + 12); dimensions(width, height);
      depth = bytes[offset + 16]; color = bytes[offset + 17];
      const depths: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
      if (!depths[color]?.includes(depth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] > 1) invalid();
    } else if (type === 'PLTE') {
      if (palette || seenData || transparency || color === 0 || color === 4 || !length || length > 768 || length % 3) invalid();
      palette = length / 3; if (color === 3 && palette > 2 ** depth) invalid();
    } else if (type === 'tRNS') {
      if (transparency || seenData || !((color === 0 && length === 2) || (color === 2 && length === 6) || (color === 3 && palette && length > 0 && length <= palette))) invalid();
      transparency = true;
    } else if (type === 'IDAT') {
      if (dataEnded || (color === 3 && !palette)) invalid(); seenData = true; data += length;
    } else if (type === 'IEND') {
      if (length || !data || end !== bytes.length) invalid(); ended = true;
    } else if (type[0] === type[0].toUpperCase()) invalid(); // Unknown critical semantics.
    if (seenData && type !== 'IDAT') dataEnded = true;
    if (['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND'].includes(type)) { parts.push(bytes.subarray(offset, end)); size += end - offset; }
    offset = end;
  }
  if (!ended) invalid();
  const output = new Uint8Array(size); let cursor = 0;
  for (const part of parts) { output.set(part, cursor); cursor += part.length; }
  return { width, height, bytes: output, mediaType: 'image/png' as const };
}
// T.81 marker framing, including stuffed/restart markers inside scans. Reject
// multiple frames and DNL rather than trusting an early small frame header.
function jpeg(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 255 || bytes[1] !== 216) invalid();
  let offset = 2, width = 0, height = 0, scans = 0, entropy = false, markers = 0;
  while (offset < bytes.length) {
    if (entropy) {
      while (offset < bytes.length && bytes[offset] !== 255) offset++;
      if (offset === bytes.length) invalid();
    }
    if (++markers > 8192 || bytes[offset++] !== 255) invalid();
    while (bytes[offset] === 255) offset++;
    const marker = bytes[offset++];
    if (entropy && (marker === 0 || (marker >= 208 && marker <= 215))) continue;
    entropy = false;
    if (marker === 217) {
      if (!width || !scans || offset !== bytes.length) invalid();
      return { width, height, bytes: new Uint8Array(bytes), mediaType: 'image/jpeg' as const };
    }
    if (marker === undefined || marker === 0 || marker === 1 || marker === 216 || marker === 220 || (marker >= 208 && marker <= 215) || offset + 2 > bytes.length) invalid();
    if (![192, 193, 194, 196, 218, 219, 221, 254].includes(marker) && !(marker >= 224 && marker <= 239)) invalid();
    const length = bytes[offset] * 256 + bytes[offset + 1], end = offset + length;
    if (length < 2 || end > bytes.length) invalid();
    if (marker >= 192 && marker <= 207 && ![196, 200, 204].includes(marker)) {
      if (![192, 193, 194].includes(marker) || width || length < 8 || bytes[offset + 2] !== 8) invalid();
      height = bytes[offset + 3] * 256 + bytes[offset + 4]; width = bytes[offset + 5] * 256 + bytes[offset + 6];
      const components = bytes[offset + 7];
      if (![1, 3, 4].includes(components) || length !== 8 + 3 * components) invalid(); dimensions(width, height);
    }
    if (marker === 218) {
      if (!width || length < 6 || ++scans > 256) invalid();
      entropy = true;
    }
    offset = end;
  }
  return invalid();
}
export function preparePushImagePreview(file: PushAttachment) {
  if (!['image/png', 'image/jpeg'].includes(file.mediaType) || !Number.isSafeInteger(file.bytes) || file.bytes < 1 || file.bytes > PUSH_FILE_BYTES
    || typeof file.base64 !== 'string' || file.base64.length > 1_333_336) invalid();
  let binary: string; try { binary = atob(file.base64); if (btoa(binary) !== file.base64) invalid(); } catch { return invalid(); }
  if (binary.length !== file.bytes) invalid();
  const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
  return file.mediaType === 'image/png' ? png(bytes) : jpeg(bytes);
}
