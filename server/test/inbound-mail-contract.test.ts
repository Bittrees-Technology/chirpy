import { describe,it,expect } from 'vitest';
import { authenticateInboundMail,signInboundMail,validInboundMail,inboundMailScope,inboundMailText,inboundMailId,INBOUND_MAIL_SOURCE } from '../inbound-mail-contract.js';
const secret='ab'.repeat(32),now=Date.now();
const event=()=>({version:1,source:INBOUND_MAIL_SOURCE,id:inboundMailId('member@example.com','ef'.repeat(32)),mailbox:'member@example.com',bindingId:'binding-1',bindingVersion:1,messageId:'ef'.repeat(32),sourceVersion:'12'.repeat(32),receivedAt:now,from:'External Person <person@example.org>',subject:'Hello',text:'Plain email text',truncated:false,automated:false,bridgeDepth:0});
const signed=(e=event(),time=now)=>{const raw=Buffer.from(JSON.stringify(e));return {raw,time:String(time),signature:signInboundMail(raw,time,secret)};};
describe('authenticated inbound Mail contract',()=>{
 it('authenticates the exact source event and binds all message fields to Wallet scope',()=>{
  const e=event(),s=signed(e);expect(authenticateInboundMail(s.raw,s.time,s.signature,secret,now)).toEqual({event:e,scope:inboundMailScope(e)});
  const reversed=Object.fromEntries(Object.entries(e).reverse());expect(inboundMailScope(reversed)).toEqual(inboundMailScope(e));
  for(const [key,value] of Object.entries(e)){
   const changed={...e,[key]:typeof value==='boolean'?!value:typeof value==='number'?value+1:String(value)+'x'};
   expect(inboundMailScope(changed).contentHash).not.toBe(inboundMailScope(e).contentHash);
  }
 });
 it('rejects modified bytes, signatures, timestamps, keys and expired transport requests',()=>{
  const s=signed();
  for(const args of [[Buffer.concat([s.raw,Buffer.from(' ')]),s.time,s.signature,secret], [s.raw,s.time,'00'.repeat(32),secret],[s.raw,String(now+1),s.signature,secret],[s.raw,s.time,s.signature,'cd'.repeat(32)],[s.raw,'1',s.signature,secret]])expect(authenticateInboundMail(...args,now)).toBeNull();
  for(const time of [now-300001,now+30001]){const old=signed(event(),time);expect(authenticateInboundMail(old.raw,old.time,old.signature,secret,now)).toBeNull();}
 });
 it('allows same-event retry under a fresh transport timestamp without changing delivery identity',()=>{
  const e=event();const first=signed(e),retry=signed(e,now+1000);
  expect(authenticateInboundMail(first.raw,first.time,first.signature,secret,now)?.scope).toEqual(authenticateInboundMail(retry.raw,retry.time,retry.signature,secret,now+1000)?.scope);
  expect(inboundMailScope({...e,mailbox:'other@example.com'}).deliveryId).not.toBe(inboundMailScope(e).deliveryId);
 });
 it.each([{id:'cd'.repeat(32)},{automated:true},{bridgeDepth:1},{source:'https://evil.example'},{bindingVersion:0},{bindingId:'../other'},{mailbox:'a@example.com\nBcc:b@example.com'},{receivedAt:now-23*3600000},{from:'Spoof\nWallet: 0x123'},{subject:'\u202espoof'},{text:'\x00'},{text:'ü'.repeat(8001)},{truncated:'false'},{extra:true}])('rejects unsafe or unsupported source scope %j',patch=>{
  const s=signed({...event(),...patch});expect(authenticateInboundMail(s.raw,s.time,s.signature,secret,now)).toBeNull();
 });
 it('bounds raw bodies and rejects malformed JSON or invalid UTF-8 after authentication',()=>{
  for(const raw of [Buffer.from('{'),Buffer.from([0xff]),Buffer.from('null')])expect(authenticateInboundMail(raw,String(now),signInboundMail(raw,now,secret),secret,now)).toBeNull();
  expect(authenticateInboundMail(Buffer.alloc(65537),String(now),'00'.repeat(32),secret,now)).toBeNull();
 });
 it('renders explicit email provenance and shortened text without a wallet-identity claim',()=>{
  const e={...event(),truncated:true};const text=inboundMailText(e);expect(text).toContain('not verified wallet identity');expect(text).toContain(e.from);expect(text).toContain(e.text);expect(text).toContain('Email text shortened');expect(text).toContain('not the original email sender');
  expect(validInboundMail(event(),now)).toBe(true);
 });
});
