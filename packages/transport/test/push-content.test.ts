import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
import { readPushHistory } from '../src/pushMessages';
import { pushConversationId } from '../src/pushRegistry';
const { validateMessageObj } = createRequire(import.meta.url)('@pushprotocol/restapi/src/lib/validations/messageObject.js');
const room = 'a'.repeat(64), conversation = pushConversationId('governance',room);
const wire = (messageType: string, content: unknown) => ({messageType,messageObj:{content}});
const file = (content = 'AQID') => wire('File',JSON.stringify({name:'original.bin',content:'data:application/octet-stream;base64,'+content}));
const row = (messageType: string, messageObj: unknown, cid='QmReplyMessage',link: string|null=null) => ({cid,link,messageType,messageObj,messageContent:'MessageType Not Supported by this sdk version. Plz upgrade !!!',fromDID:'eip155:0x'+'1'.repeat(40),toDID:room,timestamp:1});
const parse = (type: string, content: unknown) => readPushHistory([row(type,content)],conversation).messages[0];
describe('Push structured history', () => {
  it('uses SDK-valid stored reply shape rather than the legacy unsupported string', () => {
    const object={content:wire('Text','Original reply'),reference:'QmParentMessage'};
    expect(()=>validateMessageObj(object,'Reply')).not.toThrow();
    expect(parse('Reply',object)).toMatchObject({body:'Original reply',replyTo:'QmParentMessage'});
  });
  it('preserves SDK-valid composite ordering and exact binary content', () => {
    const object={content:[wire('Text','Before'),file(),wire('MediaEmbed','https://example.org/media'),wire('Text','After')]};
    expect(()=>validateMessageObj(object,'Composite')).not.toThrow();
    const message=parse('Composite',object);
    expect(message.pushParts?.map(p=>p.body)).toEqual(['Before','original.bin','https://example.org/media','After']);
    expect(message.pushParts?.[1].pushAttachment).toMatchObject({base64:'AQID',bytes:3});
    expect(message.body).toBe('Before\noriginal.bin\nhttps://example.org/media\nAfter');
  });
  it('supports replies containing files without creating an untrusted quoted parent preview', () => {
    expect(parse('Reply',{content:file(),reference:'QmParentMessage'})).toMatchObject({replyTo:'QmParentMessage',pushAttachment:{base64:'AQID'}});
    expect(parse('Reply',{content:file(),reference:'QmParentMessage'}).replyPreview).toBeUndefined();
  });
  it('does not follow malformed, URL or self references', () => {
    for (const reference of ['https://example.org/parent','../other','QmReplyMessage','short','x'.repeat(129),null]) {
      const result=parse('Reply',{content:wire('Text','do not interpret'),reference});
      expect(result.replyTo).toBeUndefined();expect(result.body).toContain('not supported');
    }
  });
  it('rejects send-input shape, recursive envelopes, unknown parts and excessive part counts', () => {
    for (const content of [[],Array(2),Array(9).fill(wire('Text','x')),[{type:'Text',content:'send-input'}],[wire('Reply',{content:wire('Text','nested'),reference:'QmParentMessage'})],[wire('Composite',[wire('Text','nested')])],[wire('Meta','not an action')],[{messageType:'Text',messageObj:{content:'x',reference:'QmParentMessage'}}],[null]]) {
      const result=parse('Composite',{content});expect(result.pushParts).toBeUndefined();expect(result.body).toContain('not supported');
    }
    expect(parse('Composite',{content:Array(8).fill(wire('Text','x'))}).pushParts).toHaveLength(8);
    expect(parse('Reply',{content:wire('Text','x'),reference:'QmParentMessage',replyPreview:'spoofed'}).replyTo).toBeUndefined();
  });
  it('never reveals structured parts when decryption failed', () => {
    const result=readPushHistory([{...row('Composite',{content:[file()]}),messageContent:'Unable to Decrypt Message'}],conversation).messages[0];
    expect(result.pushParts).toBeUndefined();expect(result.body).toContain('could not be decrypted');
    expect(parse('Reply','Unable to Decrypt Message').body).toContain('could not be decrypted');
  });
  it('detects changed references and attachment bytes in duplicate message IDs', () => {
    const reply=row('Reply',{content:wire('Text','same'),reference:'QmParentMessage'});
    expect(()=>readPushHistory([reply,row('Reply',{content:wire('Text','same'),reference:'QmDifferentParent'})],conversation)).toThrow();
    expect(()=>readPushHistory([row('Composite',{content:[file()]}),row('Composite',{content:[file('AQIE')]})],conversation)).toThrow();
  });
  it('applies original text and page media limits to parts without retaining oversized payloads', () => {
    expect(parse('Composite',{content:[wire('Text','x'.repeat(16_001)),file()]}).pushParts?.[0].body).toContain('too large');
    const large=file(Buffer.alloc(1_000_000).toString('base64'));
    expect(()=>parse('Composite',{content:Array(7).fill(large)})).toThrow('No messages were replaced');
    expect(parse('Composite',{content:Array(6).fill(large)}).pushParts).toHaveLength(6);
    const rows=Array.from({length:5},(_,i)=>row('Composite',{content:Array(8).fill(wire('Text','x'.repeat(16_000)))},'QmMessageIndex'+i,i===4?null:'QmMessageIndex'+(i+1)));
    expect(()=>readPushHistory(rows,conversation)).toThrow('No messages were replaced');
  });
});
