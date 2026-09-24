import {describe,it,expect,vi} from 'vitest';
import {walletAccessConfig,walletServiceHeaders} from '../wallet-service-access.js';
import {mailIdentityConfig,resolveMailIdentity} from '../mail-identity.js';
import {inboundMailConfig,resolveInboundMail} from '../inbound-mail.js';
import {inboundSenderIdentity} from '../inbound-xmtp-sender.js';
import {inboundMailScope} from '../inbound-mail-contract.js';
import {inboundEnv,inboundEvent,identityResponse} from './helpers/inbound-mail-fixture.js';

const credential='service-'.repeat(8),secret='deployment-'.repeat(8),origin='https://wallet.example';
const outboundEnv={CHIRPY_MAIL_IDENTITY_URL:origin+'/api/service/delivery',CHIRPY_MAIL_IDENTITY_SECRET:credential};
const accessEnv={CHIRPY_MAIL_IDENTITY_ACCESS_ORIGIN:origin,CHIRPY_MAIL_IDENTITY_ACCESS_SECRET:secret};
const inboundAccessEnv={CHAT_MAIL_INBOUND_IDENTITY_ACCESS_ORIGIN:origin,CHAT_MAIL_INBOUND_IDENTITY_ACCESS_SECRET:secret};
const scope={bindingId:'binding',expectedVersion:1,senderWallet:'0x'+'1'.repeat(40),deliveryId:'2'.repeat(64),contentHash:'3'.repeat(64)};
const result=()=>({...scope,version:1,email:'test@example.com',expiresAt:Date.now()+10000});

describe('protected Wallet service access',()=>{
 it('keeps direct service configuration unchanged and ignores the calling project automation token',()=>{
  const config=mailIdentityConfig({...outboundEnv,VERCEL_AUTOMATION_BYPASS_SECRET:secret});
  expect(config).toEqual({url:outboundEnv.CHIRPY_MAIL_IDENTITY_URL,credential});
  expect(walletServiceHeaders(config,'/api/service/delivery')).toEqual({Authorization:'Bearer '+credential,'Content-Type':'application/json'});
  expect(inboundMailConfig({...inboundEnv,VERCEL_AUTOMATION_BYPASS_SECRET:secret})?.identity.access).toBeUndefined();
 });
 it('requires a complete independent access credential pinned to the exact HTTPS origin',()=>{
  expect(mailIdentityConfig({...outboundEnv,...accessEnv})?.access).toEqual({origin,secret});
  const invalid=[{CHIRPY_MAIL_IDENTITY_ACCESS_ORIGIN:''},{CHIRPY_MAIL_IDENTITY_ACCESS_SECRET:''},
   ...['short',credential,secret+'\n',secret+' ',secret+'\x7f','x'.repeat(513)].map(value=>({CHIRPY_MAIL_IDENTITY_ACCESS_SECRET:value})),
   ...['http://wallet.example','https://different.example','https://wallet.example/path','https://wallet.example?x=1',
    'https://user:pass@wallet.example','https://wallet.example#part','https://wallet.example:8443'].map(value=>({CHIRPY_MAIL_IDENTITY_ACCESS_ORIGIN:value}))];
  for(const patch of invalid)expect(()=>mailIdentityConfig({...outboundEnv,...accessEnv,...patch})).toThrow();
  expect(()=>mailIdentityConfig(accessEnv)).toThrow();
  expect(walletAccessConfig(outboundEnv.CHIRPY_MAIL_IDENTITY_URL,credential,undefined,undefined)).toBeNull();
 });
 it('rejects malformed optional inbound access without weakening the disabled guard',()=>{
  expect(inboundMailConfig({...inboundEnv,...inboundAccessEnv})?.identity.access).toEqual({origin,secret});
  for(const patch of [{CHAT_MAIL_INBOUND_IDENTITY_ACCESS_ORIGIN:''},{CHAT_MAIL_INBOUND_IDENTITY_ACCESS_SECRET:''},
   {CHAT_MAIL_INBOUND_IDENTITY_ACCESS_ORIGIN:'https://another.example'},
   {CHAT_MAIL_INBOUND_IDENTITY_ACCESS_SECRET:inboundEnv.CHAT_MAIL_INBOUND_IDENTITY_SECRET}]){
   expect(inboundMailConfig({...inboundEnv,...inboundAccessEnv,...patch})).toBeNull();
  }
  expect(inboundMailConfig({...inboundEnv,...inboundAccessEnv,CHAT_MAIL_INBOUND_ENABLED:'0'})).toBeNull();
 });
 it('sends deployment access only in a header, alongside the scoped outbound credential',async()=>{
  const config=mailIdentityConfig({...outboundEnv,...accessEnv});
  const request=vi.fn(async()=>Response.json(result()));
  expect(await resolveMailIdentity(config,scope,'test@example.com',request)).toBe(true);
  const [url,options]=request.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe(outboundEnv.CHIRPY_MAIL_IDENTITY_URL);
  expect(options).toMatchObject({method:'POST',redirect:'error',credentials:'omit'});
  const headers=new Headers(options.headers);
  expect(headers.get('authorization')).toBe('Bearer '+credential);
  expect(headers.get('x-vercel-protection-bypass')).toBe(secret);
  expect(headers.has('cookie')).toBe(false);expect(headers.has('x-vercel-set-bypass-cookie')).toBe(false);
  expect(JSON.parse(String(options.body))).toEqual(scope);
  expect(url+options.body).not.toContain(secret);
 });
 it('retains exact recipient consent checks for inbound calls through the protected entry',async()=>{
  const config=inboundMailConfig({...inboundEnv,...inboundAccessEnv}),inboundScope=inboundMailScope(inboundEvent());
  const request=vi.fn(async()=>identityResponse(inboundScope));
  expect((await resolveInboundMail(config,inboundScope,request))?.wallet).toBe('0x'+'3'.repeat(40));
  const [url,options]=request.mock.calls[0] as unknown as [string,RequestInit];
  expect(url).toBe(inboundEnv.CHAT_MAIL_INBOUND_IDENTITY_URL);
  expect(new Headers(options.headers).get('x-vercel-protection-bypass')).toBe(secret);
  expect(options).toMatchObject({redirect:'error',credentials:'omit'});
  expect(JSON.parse(String(options.body))).toEqual(inboundScope);
  expect(await resolveInboundMail(config,inboundScope,async()=>identityResponse(inboundScope,{mailbox:'other@example.com'}))).toBeNull();
  expect(await resolveMailIdentity(mailIdentityConfig({...outboundEnv,...accessEnv}),scope,'other@example.com',async()=>Response.json(result()))).toBe(false);
 });
 it('revalidates the destination before dispatch and never retries without either credential',async()=>{
  const config=mailIdentityConfig({...outboundEnv,...accessEnv})!,request=vi.fn();
  await expect(resolveMailIdentity({...config,url:'https://other.example/api/service/delivery'},scope,'test@example.com',request)).rejects.toThrow();
  expect(request).not.toHaveBeenCalled();
  const refused=vi.fn(async()=>new Response('',{status:403}));
  expect(await resolveMailIdentity(config,scope,'test@example.com',refused)).toBe(false);expect(refused).toHaveBeenCalledTimes(1);
  const redirect=vi.fn(async()=>{throw Error('Redirect refused');});
  await expect(resolveMailIdentity(config,scope,'test@example.com',redirect)).rejects.toThrow();expect(redirect).toHaveBeenCalledTimes(1);
 });
 it('refuses malformed stored access and wrong routes before constructing headers',()=>{
  const config=mailIdentityConfig(outboundEnv)!;
  for(const access of [null,[],{},'token',{origin,secret,extra:true},{origin:'',secret:''}]){
   expect(()=>walletServiceHeaders({...config,access},'/api/service/delivery')).toThrow();
  }
  expect(()=>walletServiceHeaders(config,'/api/service/inbound')).toThrow();
  expect(()=>walletServiceHeaders({...config,credential:credential+'\n'},'/api/service/delivery')).toThrow();
 });
 it('validates private sender access while preserving journal identity across token rotation',()=>{
  const config={network:'production',address:'0x'+'1'.repeat(40),inboxId:'2'.repeat(64),installationId:'3'.repeat(64),
   databaseKey:'4'.repeat(64),directory:'/private/sender',identity:{url:origin+'/api/service/inbound',credential}};
  const identity=inboundSenderIdentity(config);
  expect(inboundSenderIdentity({...config,identity:{...config.identity,access:{origin,secret}}})).toBe(identity);
  expect(inboundSenderIdentity({...config,identity:{...config.identity,access:{origin,secret:'rotated-'.repeat(8)}}})).toBe(identity);
  expect(()=>inboundSenderIdentity({...config,identity:{...config.identity,access:{origin:'https://other.example',secret}}})).toThrow();
 });
});
