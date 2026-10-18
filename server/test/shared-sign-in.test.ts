import {describe,it,expect,vi} from 'vitest';
import {chatSsoHandler} from '../shared-sign-in.js';
import {createProjectAdministration} from '../../shared/project-administration/portal.mjs';
const origin='https://chat.bittrees.org',issuer='https://roles.bittrees.org',wallet='0x'+'1'.repeat(40);
const env={CHAT_CONNECTED_MAIL_ENABLED:'1',CHAT_CONNECTED_MAIL_KEY:'ab'.repeat(32),KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'fixture',BITTREES_SSO_ENABLED:'1',BITTREES_SSO_CLIENT_SECRET:'s'.repeat(32)};
function fixture(proof={}){
 const service={sharedIdentity:vi.fn(async()=>null),establishSharedIdentity:vi.fn(async()=>({token:'t'.repeat(64),expiresAt:Date.now()+3600000}))};
 const fetcher=vi.fn(async()=>Response.json({issuer,audience:'chat',identity:wallet,auth_time:Date.now()-1000,...proof}));
 const handle=chatSsoHandler({env,service,fetcher});
 async function start(){const r=await handle(new Request(origin+'/api/sso/start?mode=resume&return_to=/email'));return {cookie:r.headers.getSetCookie()[0].split(';')[0],state:new URL(r.headers.get('location')!).searchParams.get('state')};}
 return {service,fetcher,handle,start};
}
describe('Chat shared identity handoff',()=>{
 it('stays disabled until Mail and SSO are configured',async()=>{
  for(const override of [{BITTREES_SSO_ENABLED:'0'},{CHAT_CONNECTED_MAIL_ENABLED:'0'},{BITTREES_SSO_CLIENT_SECRET:''},{VERCEL_ENV:'preview'}]){
   const h=chatSsoHandler({env:{...env,...override}});expect(await (await h(new Request(origin+'/api/sso/status'))).json()).toEqual({configured:false});
  }
 });
 it('binds resume to browser state and preserves the original authentication time',async()=>{
  const time=Date.now()-5000,f=fixture({auth_time:time}),s=await f.start();
  expect(s.cookie).toMatch(/^__Host-bt-sso-chat-flow=/);
  await f.handle(new Request(origin+'/api/sso/callback?code=one&state=wrong',{headers:{cookie:s.cookie}}));expect(f.fetcher).not.toHaveBeenCalled();
  const result=await f.handle(new Request(origin+'/api/sso/callback?code=one&state='+s.state,{headers:{cookie:s.cookie}}));
  expect(result.headers.get('location')).toBe(origin+'/email');expect(f.service.establishSharedIdentity).toHaveBeenCalledWith(wallet,time,'');
  expect(JSON.parse(f.fetcher.mock.calls[0][1].body)).toMatchObject({client_id:'chat',redirect_uri:origin+'/api/sso/callback',code:'one'});
  expect(result.headers.getSetCookie().find(c=>c.startsWith('__Host-chat_mail_session='))).toContain('HttpOnly; Secure; SameSite=Strict');
 });
 it('rejects wrong audience and expired identities before establishing a session',async()=>{
  for(const proof of [{audience:'chat-admin'},{issuer:'https://evil.test'},{auth_time:Date.now()-604800001}]){
   const f=fixture(proof),s=await f.start();await f.handle(new Request(origin+'/api/sso/callback?code=one&state='+s.state,{headers:{cookie:s.cookie}}));expect(f.service.establishSharedIdentity).not.toHaveBeenCalled();
  }
 });
 it('does not replace a session established while the handoff was in progress',async()=>{
  const f=fixture(),s=await f.start();f.service.sharedIdentity.mockResolvedValue({key:'existing',identity:wallet,authTime:Date.now()} as never);
  await f.handle(new Request(origin+'/api/sso/callback?code=one&state='+s.state,{headers:{cookie:s.cookie+'; __Host-chat_mail_session=existing'}}));expect(f.fetcher).not.toHaveBeenCalled();expect(f.service.establishSharedIdentity).not.toHaveBeenCalled();
 });
 it('keeps administration registration and cookies separate',async()=>{
  const h=createProjectAdministration('chat',{env:{BITTREES_ADMIN_SSO_CLIENT_SECRET:'a'.repeat(32)}});
  const r=await h(new Request(origin+'/api/project-admin/sso/start?mode=resume'));
  const url=new URL(r.headers.get('location')!);expect(url.searchParams.get('client_id')).toBe('chat-admin');expect(url.searchParams.get('redirect_uri')).toBe(origin+'/api/project-admin/sso/callback');expect(r.headers.getSetCookie()[0]).toMatch(/^__Host-project-admin-bt-sso-flow=/);
 });
});
