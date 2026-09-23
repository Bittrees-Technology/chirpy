import { describe, it, expect } from 'vitest';
import { deflateSync } from 'node:zlib';
import { preparePushImagePreview } from '../src/pushImagePreview';
const crc = (bytes: Uint8Array) => {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
};
function chunk(type: string, data = Buffer.alloc(0)) {
  const header = Buffer.alloc(8); header.writeUInt32BE(data.length); header.write(type, 4);
  const trailer = Buffer.alloc(4); trailer.writeUInt32BE(crc(Buffer.concat([header.subarray(4), data])));
  return Buffer.concat([header, data, trailer]);
}
const signature = Buffer.from([137,80,78,71,13,10,26,10]);
const header = (width = 1, height = 1) => { const b = Buffer.alloc(13); b.writeUInt32BE(width); b.writeUInt32BE(height,4); b[8] = 8; b[9] = 6; return chunk('IHDR', b); };
const pixels = () => chunk('IDAT', deflateSync(Buffer.from([0,255,0,0,255])));
const png = (extras: Buffer[] = [], width = 1, height = 1) => Buffer.concat([signature, header(width,height), ...extras, pixels(), chunk('IEND')]);
const file = (bytes: Uint8Array, mediaType = 'image/png') => ({ filename: 'test-image', bytes: bytes.length, mediaType, base64: Buffer.from(bytes).toString('base64') });
const jpeg = (width = 3, height = 2, type = 192) => Buffer.from([255,216,255,type,0,11,8,height >> 8,height & 255,width >> 8,width & 255,1,1,17,0,255,218,0,8,1,1,0,0,63,0,11,255,0,22,255,208,33,255,217]);
describe('bounded Push raster previews', () => {
  it('keeps static PNG pixels while stripping metadata only from the preview copy', () => {
    const original = png([chunk('tEXt', Buffer.from('label\0private metadata')),chunk('zTXt',Buffer.from('compressed profile-like text'))]);
    const selected = file(original), snapshot = { ...selected };
    const result = preparePushImagePreview(selected);
    expect(result).toMatchObject({ width:1, height:1, mediaType:'image/png' });
    expect(Buffer.from(result.bytes).equals(png())).toBe(true); expect(selected).toEqual(snapshot);
  });
  it.each([[0,1],[1,0],[4097,1],[1,4097],[2001,2000],[0xffffffff,1]])('rejects PNG dimension %s x %s before pixel decode', (width,height) => {
    expect(() => preparePushImagePreview(file(png([],width,height)))).toThrow('cannot be previewed');
  });
  it('accepts the pixel limit and rejects APNG, duplicate headers and critical extensions', () => {
    expect(preparePushImagePreview(file(png([],2000,2000))).width).toBe(2000);
    for (const type of ['acTL','fcTL','fdAT','ABCD','IHDR']) expect(() => preparePushImagePreview(file(png([chunk(type)])))).toThrow();
  });
  it('rejects CRC changes, truncation, unsafe chunk lengths, trailing data and nonconsecutive IDATs', () => {
    const original = png(), crcChanged = Buffer.from(original); crcChanged[crcChanged.length-1] ^= 1;
    const badLength = Buffer.from(original); badLength.writeUInt32BE(0xffffffff,8);
    for (const bytes of [crcChanged,badLength,original.subarray(0,-1),Buffer.concat([original,Buffer.from('hidden')]),Buffer.concat([signature,header(),chunk('IDAT'),chunk('tEXt'),pixels(),chunk('IEND')])]) expect(() => preparePushImagePreview(file(bytes))).toThrow();
  });
  it('bounds PNG chunk count even within the input byte limit', () => {
    expect(() => preparePushImagePreview(file(png(Array.from({length:2048},()=>chunk('tEXt')))))).toThrow();
  });
  it('validates JPEG frame dimensions through entropy, stuffing, restart markers and progressive scans', () => {
    for (const type of [192,193,194]) {
      const bytes=jpeg(3,2,type), result=preparePushImagePreview(file(bytes,'image/jpeg'));
      expect(result).toMatchObject({width:3,height:2,mediaType:'image/jpeg'}); expect(Buffer.from(result.bytes).equals(bytes)).toBe(true);
    }
  });
  it('rejects huge or deferred JPEG dimensions, conflicting later frames and malformed framing', () => {
    const bytes=jpeg();
    const duplicate=Buffer.concat([bytes.subarray(0,-2),jpeg(4096,4096).subarray(2)]);
    const dnl=Buffer.concat([bytes.subarray(0,-2),Buffer.from([255,220,0,4,255,255,255,217])]);
    for (const b of [jpeg(4097,1),jpeg(2001,2000),jpeg(1,0),jpeg(1,1,195),duplicate,dnl,bytes.subarray(0,-1),Buffer.concat([bytes,Buffer.from('trailing')]),Buffer.from([255,216,255,217])]) expect(() => preparePushImagePreview(file(b,'image/jpeg'))).toThrow();
  });
  it('rejects active formats, MIME spoofing, noncanonical base64 and incorrect byte counts', () => {
    for (const type of ['image/svg+xml','text/html','image/gif','image/webp']) expect(()=>preparePushImagePreview(file(png(),type))).toThrow();
    for (const f of [file(png(),'image/jpeg'),file(jpeg(),'image/png'),file(Buffer.from('<svg/>'),'image/png'),{...file(png()),bytes:0},{...file(png()),bytes:1_000_001},{...file(png()),base64:'AB=='},{...file(png()),base64:'A'.repeat(1_333_340)}]) expect(()=>preparePushImagePreview(f)).toThrow();
  });
  it('rejects deterministic byte mutations and truncations without rendering malformed PNG data', () => {
    const original=png();
    for (let i=0;i<original.length;i++) {
      const changed=Buffer.from(original); changed[i]^=1;
      expect(()=>preparePushImagePreview(file(changed))).toThrow();
      expect(()=>preparePushImagePreview(file(original.subarray(0,i)))).toThrow();
    }
  });
});
