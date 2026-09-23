import {mailSignMessage} from '../../packages/core/src/mailAuth.js';
import {afterEach,it,expect,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {INBOUND_HISTORY_SERVICE,inboundHistorySignMessage,parseInboundHistoryRecord} from '../../packages/core/src/inboundHistory.js';
import {inboundHistoryOwner,readInboundHistory,verifyInboundHistoryCommand} from '../inbound-history.js';
import {inboundMailConfig} from '../inbound-mail.js';
import handler from '../../api/mail/[action].js';
import {inboundEnv} from './helpers/inbound-mail-fixture.js';
const wallet=privateKeyToAccount(`0x${'3'.repeat(64)}`),query=()=>({action:'history' as const,service:INBOUND_HISTORY_SERVICE,wallet:wallet.address.toLowerCase(),id:'a'.repeat(32),cursor:null,expiresAt:Date.now()+300000});
const receipt=()=>({id:'a'.repeat(64),status:'queued',createdAt:1700000000000,updatedAt:1700000000000,deadline:1700000060000,attempts:0});
const response=()=>({code:0,body:null as any,headers:{},setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}});
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
it('binds read-only incoming history to each signed scope field',async()=>{
 const c=query(),signature=await wallet.signMessage({message:inboundHistorySignMessage(c)});expect(await verifyInboundHistoryCommand(c,signature)).toBe(true);
 for(const patch of [{wallet:'0x'+'1'.repeat(40)},{service:'https://other.test/api/mail/inbound-history'},{action:'send'},{id:'b'.repeat(32)},{cursor:'f'.repeat(64)},{expiresAt:c.expiresAt-1},{extra:true}])expect(await verifyInboundHistoryCommand({...c,...patch},signature)).toBe(false);
 expect(await verifyInboundHistoryCommand(c,signature,c.expiresAt)).toBe(false);expect(await verifyInboundHistoryCommand(c,await wallet.signMessage({message:mailSignMessage(c)}))).toBe(false);
});
it('derives opaque wallet ownership tags isolated by key and wallet',()=>{
 const config=inboundMailConfig(inboundEnv)!,tag=inboundHistoryOwner(config,query().wallet);expect(tag).toMatch(/^[a-f0-9]{64}$/);expect(tag).not.toContain(query().wallet);expect(inboundHistoryOwner(config,'0x'+'1'.repeat(40))).not.toBe(tag);expect(inboundHistoryOwner({...config,key:Buffer.alloc(32)},query().wallet)).not.toBe(tag);
});
it('returns only retained receipt fields and rejects a foreign owner or corrupt stored state',async()=>{
 const config=inboundMailConfig(inboundEnv)!,c=query(),key=config.prefix+'job:'+'b'.repeat(64),job={...receipt(),historyOwner:inboundHistoryOwner(config,c.wallet),mailbox:'private@example.test',digest:'private',identityService:'private'};
 const kv=vi.fn().mockResolvedValueOnce(['history',key]).mockResolvedValueOnce([JSON.stringify(job)]);expect((await readInboundHistory(config,c,kv)).records).toEqual([receipt()]);expect(kv.mock.calls.map(c=>c[0][0])).toEqual(['EVAL','MGET']);
 for(const patch of [{historyOwner:'c'.repeat(64)},{status:'delivered'},{attempts:-1},{updatedAt:1}]){
  const invalid=vi.fn().mockResolvedValueOnce(['history',key]).mockResolvedValueOnce([JSON.stringify({...job,...patch})]);await expect(readInboundHistory(config,c,invalid)).rejects.toThrow();
 }
});
it('bounds pages and omits expired records without inventing publication evidence',async()=>{
 const config=inboundMailConfig(inboundEnv)!,c=query(),key=config.prefix+'job:'+'b'.repeat(64),kv=vi.fn().mockResolvedValueOnce(['history',key]).mockResolvedValueOnce([null]);expect((await readInboundHistory(config,c,kv)).records).toEqual([]);
 for(const result of [['history',...Array(27).fill(key)],['history','foreign:key'],['history',key,key]])await expect(readInboundHistory(config,c,async()=>result)).rejects.toThrow();
});
it.each([{status:'published'},{createdAt:0},{deadline:1700090000000},{id:'x'},{attempts:0.5},{private:'value'}])('rejects malformed public receipt projections',patch=>{expect(()=>parseInboundHistoryRecord({...receipt(),...patch})).toThrow();});
it('authenticates the new HTTP action without requiring or weakening a mailbox session',async()=>{
 for(const [key,value]of Object.entries(inboundEnv))vi.stubEnv(key,value);const fetcher=vi.fn().mockResolvedValue(Response.json({result:['history']}));vi.stubGlobal('fetch',fetcher);
 const c=query(),req={method:'POST',query:{action:'inbound-history'},headers:{origin:'https://chat.bittrees.org','content-type':'application/json'},body:{command:c,signature:'0x00'}};
 const denied=response();await handler(req,denied);expect(denied.code).toBe(401);expect(fetcher).not.toHaveBeenCalled();
 const cross=response();await handler({...req,headers:{...req.headers,origin:'https://evil.test'}},cross);expect(cross.code).toBe(403);
 const allowed=response();await handler({...req,body:{command:c,signature:await wallet.signMessage({message:inboundHistorySignMessage(c)})}},allowed);expect(allowed.code).toBe(200);expect(allowed.body.records).toEqual([]);expect(allowed.headers['Cache-Control']).toBe('no-store');expect(fetcher).toHaveBeenCalledOnce();
 const old=response();await handler({...req,query:{action:'status'},method:'GET',headers:{host:'chirpy.bittrees.org'}},old);expect(old.code).toBe(403);
});
it('refuses disabled and preview history before storage, and advertises only the fixed service',async()=>{
 const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const req={method:'GET',query:{action:'inbound-history'},headers:{}};
 expect((await handler(req,response())).code).toBe(503);
 for(const [key,value]of Object.entries(inboundEnv))vi.stubEnv(key,value);const enabled=await handler(req,response());expect(enabled.body).toEqual({enabled:true,service:INBOUND_HISTORY_SERVICE,version:1});
 vi.stubEnv('VERCEL_ENV','preview');expect((await handler(req,response())).code).toBe(503);expect(fetcher).not.toHaveBeenCalled();
});

it('scopes native/Chirpy origins explicitly and rejects malformed requests before storage',async()=>{
 for(const [key,value]of Object.entries(inboundEnv))vi.stubEnv(key,value);const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
 const preflight={method:'OPTIONS',query:{action:'inbound-history'},headers:{origin:'https://chirpy.bittrees.org','access-control-request-method':'POST','access-control-request-headers':'content-type'}};
 expect((await handler(preflight,response())).code).toBe(403);vi.stubEnv('CHAT_MAIL_INBOUND_HISTORY_ALLOWED_ORIGINS','https://chirpy.bittrees.org');expect((await handler(preflight,response())).code).toBe(204);
 const req={method:'POST',query:{action:'inbound-history'},headers:{origin:'https://chat.bittrees.org','content-type':'application/json',cookie:'__Host-chat_mail_session=synthetic'},body:{command:query(),signature:'0x00'}};
 expect((await handler(req,response())).code).toBe(401);expect((await handler({...req,body:{extra:'x'.repeat(4097)}},response())).code).toBe(413);
 vi.stubEnv('CHAT_MAIL_INBOUND_HISTORY_ALLOWED_ORIGINS','http://evil.test');expect((await handler(preflight,response())).code).toBe(503);expect(fetcher).not.toHaveBeenCalled();
});
