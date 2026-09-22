import {afterEach,beforeEach,describe,it,expect} from 'vitest';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {randomBytes} from 'node:crypto';
import {privateKeyToAccount} from 'viem/accounts';
import {connectedMailConfig,createConnectedMail,CONNECTION_CAS} from '../connected-mail.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,socket=process.env.CHAT_TEST_REDIS_SOCKET,exec=promisify(execFile);
const signer=privateKeyToAccount(`0x${'2'.repeat(64)}`),wallet=signer.address.toLowerCase();
describe.skipIf(!container&&!socket)('real Redis connected Mail lifecycle',{timeout:30000},()=>{
 let config:any,api:any,calls:string[],grant:any;const keys=new Set<string>();
 const redis=async(args:any[])=>{
  if(args[0]==='SET')keys.add(args[1]);if(args[0]==='EVAL')args.slice(3,3+Number(args[2])).forEach(k=>keys.add(k));
  const {stdout}=await exec(container?'docker':'redis-cli',container?['exec',container,'redis-cli','--json',...args.map(String)]:['-s',socket!,'--json',...args.map(String)],{maxBuffer:2000000});
  const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;
 };
 beforeEach(()=>{
  config=connectedMailConfig({CHAT_CONNECTED_MAIL_ENABLED:'1',CHAT_CONNECTED_MAIL_KEY:'ab'.repeat(32),KV_REST_API_URL:'https://fixture.test',KV_REST_API_TOKEN:'fixture'});config.prefix+='test-'+randomBytes(8).toString('hex')+':';calls=[];
  grant={token:'a'.repeat(64),grantId:'b'.repeat(64),wallet,mailbox:'fixture@bittrees.org',scopes:['read'],audience:'https://chat.bittrees.org',expiresAt:new Date(Date.now()+600000).toISOString()};
  api=createConnectedMail(config,{kv:redis,request:async(url)=>{calls.push(String(url));return Response.json(String(url).endsWith('/exchange')?grant:{ok:true});}});
 });
 afterEach(async()=>{if(keys.size)await redis(['DEL',...keys]);keys.clear();});
 async function login(){const c=await api.challenge(wallet);return api.verify(c.token,{wallet,message:c.message,signature:await signer.signMessage({message:c.message})});}
 it('atomically consumes one callback and stores only authenticated ciphertext with bounded TTL',async()=>{
  const session=await login(),start=await api.start(session.token,wallet),state=new URLSearchParams(new URL(start.url).hash.slice(1)).get('state');
  const result=await Promise.allSettled([api.callback(session.token,{wallet,state,code:'c'.repeat(64)}),api.callback(session.token,{wallet,state,code:'c'.repeat(64)})]);
  expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(calls.filter(c=>c.endsWith('/exchange'))).toHaveLength(1);
  const k=[...keys].find(k=>k.includes(':session:'))!,raw=await redis(['GET',k]);expect(raw).not.toContain(grant.token);expect(raw).not.toContain(grant.mailbox);expect(raw).not.toContain(wallet);
  const ttl=await redis(['PTTL',k]);expect(ttl).toBeGreaterThan(0);expect(ttl).toBeLessThanOrEqual(3600000);
  await api.disconnect(session.token);expect(await redis(['GET',k])).toBeNull();await expect(api.status(session.token,wallet)).rejects.toMatchObject({status:401});
 });
 it('prevents expired or stale compare-and-swap from reviving a session',async()=>{
  await login();const k=[...keys].find(k=>k.includes(':session:'))!,raw=await redis(['GET',k]);
  expect(await redis(['EVAL',CONNECTION_CAS,'1',k,raw,'replacement',String(Date.now()-1)])).toBe(0);
  expect(await redis(['EVAL',CONNECTION_CAS,'1',k,'stale','replacement',String(Date.now()+60000)])).toBe(0);
  await redis(['DEL',k]);expect(await redis(['EVAL',CONNECTION_CAS,'1',k,raw,'replacement',String(Date.now()+60000)])).toBe(0);expect(await redis(['GET',k])).toBeNull();
 });
 it('ciphertext copied to another session fails authentication',async()=>{
  const first=await login(),second=await login(),sessionKeys=[...keys].filter(k=>k.includes(':session:'));
  await redis(['SET',sessionKeys[1],await redis(['GET',sessionKeys[0]]),'PX','60000']);
  await expect(api.status(second.token,wallet)).rejects.toMatchObject({status:401});expect((await api.status(first.token,wallet)).wallet).toBe(wallet);
 });
});
