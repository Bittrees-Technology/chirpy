import { describe, it, expect } from 'vitest';
import { readPushAttachment, readPushMediaLink, PUSH_FILE_BYTES, preparePushFile, writePushFile } from '../src/pushMedia';
import { readPushHistory } from '../src/pushMessages';
import { pushConversationId } from '../src/pushRegistry';
const data = (bytes: number, mime = 'application/octet-stream') => `data:${mime};base64,${Buffer.alloc(bytes, 31).toString('base64')}`;
const room = 'a'.repeat(64), conversation = pushConversationId('governance',room);
const row = (cid: string, link: string | null, content: string, type = 'File') => ({cid,link,messageType:type,messageObj:{content},fromDID:'eip155:0x'+'1'.repeat(40),toDID:room,timestamp:1});
describe('Push attachment parsing', () => {
  it('preserves exact bytes in direct and JSON file formats without trusting declared size', () => {
    const content = data(PUSH_FILE_BYTES);
    for (const value of [content, JSON.stringify({content,name:'report.bin',size:1})]) {
      const parsed = readPushAttachment('File', value)!;
      expect(parsed.bytes).toBe(PUSH_FILE_BYTES);
      // Native equality still compares every byte without a million JS assertion entries.
      expect(Buffer.from(parsed.base64,'base64').equals(Buffer.alloc(PUSH_FILE_BYTES,31))).toBe(true);
    }
    expect(readPushAttachment('File', data(0))?.bytes).toBe(0);
  });
  it('preserves image/audio/video MIME information but requires matching inline content', () => {
    for (const [type, mime, ext] of [['Image','image/png','png'],['Audio','audio/mpeg','mp3'],['Video','video/mp4','mp4']]) expect(readPushAttachment(type, data(5,mime))).toMatchObject({bytes:5,mediaType:mime,filename:`push-attachment.${ext}`});
    expect(readPushAttachment('Image',data(5,'text/html'))).toBeUndefined();
    expect(readPushAttachment('Image','https://example.org/tracker.png')).toBeUndefined();
    expect(readPushAttachment('File',data(1,'application/'+'x'.repeat(128)))).toBeUndefined();
  });
  it('rejects oversize, noncanonical base64, extra data URI attributes and malformed file JSON', () => {
    for (const value of [data(PUSH_FILE_BYTES+1), 'data:text/plain;base64,AB==','data:text/plain;base64,A===','data:text/plain;base64,Y Q==','data:text/plain;base64,YQ','data:text/plain;charset=utf-8;base64,YQ==','data:text/html,<script>alert(1)</script>','{"content":{}}','{"content":','[]']) expect(readPushAttachment('File',value)).toBeUndefined();
  });
  it('neutralizes paths, controls, bidi overrides and excessive filenames', () => {
    const parsed = readPushAttachment('File',JSON.stringify({content:data(1),name:'../../unsafe\\\u202ename\u0000.txt'}))!;
    expect(parsed.filename).not.toMatch(/[\/\\\u202e\x00]/); expect(parsed.filename.startsWith('.')).toBe(false);
    expect(readPushAttachment('File',JSON.stringify({content:data(1),name:'x'.repeat(200)}))!.filename.length).toBe(120);
  });
  it('allows only explicit HTTPS external links without credentials or concealed separators', () => {
    expect(readPushMediaLink('https://example.org/media?a=1#clip')).toBe('https://example.org/media?a=1#clip');
    for (const value of ['javascript:alert(1)','data:text/html,x','file:///etc/passwd','http://example.org','https://user:pass@example.org','https://example.org/\ntrack','https://example.org/\u202etrack','//example.org','https://example.org/\\track','https://example.org/'+'x'.repeat(2048)]) expect(readPushMediaLink(value)).toBeUndefined();
  });
  it('binds full file content to history duplicates and retains safe placeholders', () => {
    const original=row('QmFileMessage',null,JSON.stringify({content:data(3),name:'test.bin'}));
    expect(readPushHistory([original,original],conversation).messages[0]).toMatchObject({body:'test.bin',pushAttachment:{bytes:3}});
    expect(()=>readPushHistory([original,row('QmFileMessage',null,data(4))],conversation)).toThrow();
    expect(readPushHistory([{...original,messageContent:'Unable to Decrypt Message'}],conversation).messages[0].pushAttachment).toBeUndefined();
    expect(readPushHistory([row('QmFileMessage',null,'javascript:alert(1)','MediaEmbed')],conversation).messages[0].pushMediaUrl).toBeUndefined();
  });
  it('bounds aggregate media memory and includes external destination in duplicate comparisons', () => {
    const rows=Array.from({length:7},(_,i)=>row('QmFileMessage'+i,i===6?null:'QmFileMessage'+(i+1),data(PUSH_FILE_BYTES)));
    expect(()=>readPushHistory(rows,conversation)).toThrow('No messages were replaced');
    expect(readPushHistory(rows.slice(0,6),conversation).messages).toHaveLength(6);
    expect(()=>readPushHistory([row('QmMediaMessage',null,'https://example.org/a','MediaEmbed'),row('QmMediaMessage',null,'https://example.org/b','MediaEmbed')],conversation)).toThrow();
  });
});

describe('Push file preparation and dispatch validation', () => {
  it('round trips the full limit with a safe filename, normalized MIME and original bytes', () => {
    const bytes = Uint8Array.from({ length: PUSH_FILE_BYTES }, (_, i) => i % 256);
    const file = preparePushFile('../report\u202e.bin', 'Application/Octet-Stream', bytes);
    expect(file.filename).toBe('__report_.bin');
    const decoded = readPushAttachment('File', writePushFile(file))!;
    expect(decoded).toEqual(file); expect(Buffer.from(decoded.base64, 'base64').equals(Buffer.from(bytes))).toBe(true);
  });
  it('allows empty files and defaults absent or unsafe MIME to a binary download', () => {
    for (const mime of ['', 'text/html;charset=utf-8', 'image/svg+xml\ntracking', 'x'.repeat(128)]) {
      expect(preparePushFile('', mime, new Uint8Array())).toEqual({ filename: 'attachment.bin', bytes: 0, mediaType: 'application/octet-stream', base64: '' });
    }
    expect(() => preparePushFile('large.bin', '', new Uint8Array(PUSH_FILE_BYTES + 1))).toThrow('at most 1 MB');
  });
  it.each([
    { bytes: 0 }, { filename: '../bad.bin' }, { mediaType: 'TEXT/PLAIN' }, { base64: 'AB==' }, { base64: 'A'.repeat(1_340_004) },
    { mediaType: 'text/html;charset=utf8' }, { base64: {} },
  ])('rejects altered metadata or invalid encoded contents %#', change => {
    const file = preparePushFile('good.txt', 'text/plain', Uint8Array.of(1));
    expect(() => writePushFile({ ...file, ...change } as any)).toThrow('invalid');
  });
});
