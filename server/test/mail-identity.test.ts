import { describe,it,expect,vi } from 'vitest';
import { mailIdentityConfig,mailIdentityScope,resolveMailIdentity } from '../mail-identity.js';
const config={url:'https://wallet.example/api/service/delivery',credential:'x'.repeat(32)};
const scope={bindingId:'binding-1',expectedVersion:2,senderWallet:'0x'+'3'.repeat(40),deliveryId:'ab'.repeat(32),contentHash:'cd'.repeat(32)};
const result=()=>({...scope,version:scope.expectedVersion,email:'test@example.com',expiresAt:Date.now()+10000});
describe('Wallet email authorization client',()=>{
 it('requires a complete exact HTTPS endpoint configuration',()=>{
  expect(mailIdentityConfig({})).toBeNull();
  const env={CHIRPY_MAIL_IDENTITY_URL:config.url,CHIRPY_MAIL_IDENTITY_SECRET:config.credential};expect(mailIdentityConfig(env)).toEqual(config);
  for(const patch of [{CHIRPY_MAIL_IDENTITY_SECRET:''},{CHIRPY_MAIL_IDENTITY_URL:''},...['http://wallet.example/api/service/delivery','https://user:pass@wallet.example/api/service/delivery','https://wallet.example/api/service/delivery?x=1','https://wallet.example/other'].map(url=>({CHIRPY_MAIL_IDENTITY_URL:url}))])expect(()=>mailIdentityConfig({...env,...patch})).toThrow();
 });
 it('requires a private versioned binding reference',()=>{
  for(const identity of [null,{}, {bindingId:'b',version:0},{bindingId:1,version:1}])expect(mailIdentityScope({identity},scope.senderWallet,scope.deliveryId,scope.contentHash)).toBeNull();
 });
 it('checks the entire response scope and exact destination',async()=>{
  const fetcher=vi.fn(async()=>Response.json(result()));expect(await resolveMailIdentity(config,scope,'test@example.com',fetcher)).toBe(true);
  expect(fetcher.mock.calls[0][1]).toMatchObject({redirect:'error'});
  for(const patch of [{bindingId:'other'},{version:3},{senderWallet:'other'},{deliveryId:'other'},{contentHash:'ef'.repeat(32)},{email:'other@example.com'},{expiresAt:0},{expiresAt:Date.now()+24*3600000}])expect(await resolveMailIdentity(config,scope,'test@example.com',async()=>Response.json({...result(),...patch}))).toBe(false);
 });
 it('distinguishes denial from transient failure and bounds response bytes',async()=>{
  for(const status of [400,401,403,404,409,410])expect(await resolveMailIdentity(config,scope,'test@example.com',async()=>new Response('',{status}))).toBe(false);
  for(const status of [429,500,503])await expect(resolveMailIdentity(config,scope,'test@example.com',async()=>new Response('',{status}))).rejects.toThrow();
  await expect(resolveMailIdentity(config,scope,'test@example.com',async()=>new Response('x'.repeat(4097)))).rejects.toThrow('too large');
  await expect(resolveMailIdentity(config,scope,'test@example.com',async()=>new Response('not json'))).rejects.toThrow();
 });
});
