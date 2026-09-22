import { describe,it,expect,vi } from 'vitest';
import { inboundMailConfig,handleInboundMail,resolveInboundMail } from '../inbound-mail.js';
import { inboundMailId,inboundMailScope,signInboundMail,INBOUND_MAIL_SOURCE,INBOUND_MAIL_SERVICE } from '../inbound-mail-contract.js';
import { inboundEnv,inboundEvent,inboundRequest,identityResponse } from './helpers/inbound-mail-fixture.js';
describe('inbound mail ingress',()=>{
 it('requires independent complete configuration and never enables previews',()=>{
  expect(inboundMailConfig(inboundEnv)).not.toBeNull();expect(inboundMailConfig({})).toBeNull();
  for(const key of Object.keys(inboundEnv))expect(inboundMailConfig({...inboundEnv,[key]:''})).toBeNull();
  for(const patch of [{VERCEL_ENV:'preview'},{CHAT_MAIL_INBOUND_DATA_KEY:inboundEnv.CHAT_MAIL_INBOUND_SOURCE_SECRET},{CHAT_MAIL_INBOUND_IDENTITY_URL:'https://wallet.example/api/service/inbound?x=1'},{CHAT_MAIL_INBOUND_MAILBOXES:'invalid'},{CHAT_MAIL_INBOUND_IDENTITY_SECRET:'x'.repeat(32)+'\n'}])expect(inboundMailConfig({...inboundEnv,...patch})).toBeNull();
 });
 it('denies disabled, browser, wrong-host and unsigned requests before storage or identity',async()=>{
  const kv=vi.fn(),identity=vi.fn();expect((await handleInboundMail(inboundRequest(),{},kv,identity)).status).toBe(503);
  for(const req of [inboundRequest(undefined,{origin:'https://chat.bittrees.org'}),inboundRequest(undefined,{cookie:'session=x'}),inboundRequest(undefined,{},'https://chirpy.bittrees.org/api/mail-inbound')])expect((await handleInboundMail(req,inboundEnv,kv,identity)).status).toBe(403);
  expect((await handleInboundMail(inboundRequest(undefined,{'x-chat-mail-signature':'00'.repeat(32)}),inboundEnv,kv,identity)).status).toBe(401);
  expect((await handleInboundMail(inboundRequest(undefined,{'content-length':'65537'}),inboundEnv,kv,identity)).status).toBe(400);
  expect(kv).not.toHaveBeenCalled();expect(identity).not.toHaveBeenCalled();
 });
 it('rejects mailboxes outside the pilot allowlist before any lookup',async()=>{
  const kv=vi.fn(),identity=vi.fn();const r=await handleInboundMail(inboundRequest(),{...inboundEnv,CHAT_MAIL_INBOUND_MAILBOXES:'other@example.com'},kv,identity);expect(r.status).toBe(403);expect(kv).not.toHaveBeenCalled();expect(identity).not.toHaveBeenCalled();
 });
 it('checks exact recipient scope, live expiry and bounded response bytes',async()=>{
  const config=inboundMailConfig(inboundEnv),scope=inboundMailScope(inboundEvent());
  expect((await resolveInboundMail(config,scope,async()=>identityResponse(scope)))?.wallet).toBe('0x'+'3'.repeat(40));
  for(const patch of [{bindingId:'other'},{version:2},{mailbox:'other@example.com'},{deliveryId:'other'},{contentHash:'other'},{wallet:'invalid'},{expiresAt:0},{expiresAt:Date.now()+24*3600000}])expect(await resolveInboundMail(config,scope,async()=>identityResponse(scope,patch))).toBeNull();
  await expect(resolveInboundMail(config,scope,async()=>new Response('x'.repeat(4097)))).rejects.toThrow();
 });
 it('denied or unavailable authority cannot enqueue or expose private errors',async()=>{
  const kv=vi.fn().mockResolvedValue(null);
  const denied=await handleInboundMail(inboundRequest(),inboundEnv,kv,async()=>new Response('',{status:403}));expect(denied.status).toBe(403);
  const failed=await handleInboundMail(inboundRequest(),inboundEnv,kv,async()=>{throw Error('secret transport detail');});expect(failed.status).toBe(503);expect(await failed.text()).not.toContain('secret');
  expect(kv.mock.calls.every(([cmd])=>cmd[0]==='GET')).toBe(true);
 });
});
