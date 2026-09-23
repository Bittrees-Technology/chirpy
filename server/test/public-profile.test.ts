import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {profileSignMessage,validProfileCommand,validPublicProfile} from '../../packages/core/src/publicProfile.js';
import {createPublicProfiles,publicProfileConfig,verifyProfileSignature} from '../public-profile.js';
import handler from '../../api/profile.js';
import {resetRateLimits} from '../server-utils.js';
const signer=privateKeyToAccount(`0x${'3'.repeat(64)}`),other=privateKeyToAccount(`0x${'4'.repeat(64)}`),wallet=signer.address.toLowerCase();
const service='https://chat.example/api/profile';
const command=(patch={})=>({version:1 as const,service,wallet,revision:0,label:'My name',expiresAt:Date.now()+60000,...patch});
let records:Map<string,string>;
beforeEach(()=>{
 vi.spyOn(console,'error').mockImplementation(()=>{});resetRateLimits();records=new Map();vi.stubEnv('VERCEL_ENV','production');vi.stubEnv('CHIRPY_SYNC_SERVICE_URL','https://chat.example/api/usersync');vi.stubEnv('KV_REST_API_URL','https://kv.example');vi.stubEnv('KV_REST_API_TOKEN','synthetic');vi.stubEnv('MAINNET_RPC_URL','');
 vi.stubGlobal('fetch',vi.fn(async(_url,init)=>{const cmd=JSON.parse(init.body);let result;
  if(cmd[0]==='GET')result=records.get(cmd[1])??null;
  else if(cmd[0]==='MGET')result=cmd.slice(1).map(k=>records.get(k)??null);
  else if(cmd[0]==='EVAL'){const key=cmd[3],raw=cmd[4],expiry=Number(cmd[5]),next=JSON.parse(cmd[6]);
   if(Date.now()>=expiry)result=[-2];else if((records.get(key)??'')!==raw)result=[0];else{next.updatedAt=Date.now();records.set(key,JSON.stringify(next));result=[1,JSON.stringify(next)];}
  }else throw Error('Unexpected Redis command');return Response.json({result});}));
});
afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals();vi.unstubAllEnvs();});
async function call(body:any={},method='POST',query:any={wallet},headers:any={}){
 const res={code:0,body:null as any,headers:{} as Record<string,string>,setHeader(k,v){this.headers[k]=v;},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};
 await handler({method,body,query,headers:{'content-type':'application/json',...headers}},res);return res;
}
async function signed(c=command(),account=signer){return {command:c,signature:await account.signMessage({message:profileSignMessage(c)})};}
it('publishes and withdraws only the signing wallet name, retaining a replay fence without old names or signatures',async()=>{
 const first=await signed();expect((await call(first)).code).toBe(200);
 expect((await call({},'GET')).body.profiles[0]).toMatchObject({wallet,label:'My name',revision:1});
 expect((await call(await signed(command({revision:1,label:null})))).code).toBe(200);
 expect((await call(first)).code).toBe(409);expect((await call({},'GET')).body.profiles[0]).toMatchObject({label:null,revision:2});
 expect(JSON.stringify([...records])).not.toContain('My name');expect(JSON.stringify([...records])).not.toContain(first.signature);
});
it('rejects a different signer, changed name, changed revision and wrong service before writes',async()=>{
 const request=await signed();for(const c of [{...request,signature:(await signed(command(),other)).signature},{...request,command:{...request.command,label:'Changed'}},{...request,command:{...request.command,revision:1}},{...request,command:{...request.command,service:'https://other.example/api/profile'}}])expect((await call(c)).code).toBe(401);
 expect(records.size).toBe(0);
});
it('does not grant profile authority to a recovery or mail signature',async()=>{
 for(const message of ['Chat local data export','Chirpy email request'])expect(await verifyProfileSignature(publicProfileConfig(),command(),await signer.signMessage({message}))).toBe(false);
});
it('bounds schemas and authorization duration',()=>{
 vi.spyOn(Date,'now').mockReturnValue(1800000000000);
 for(const patch of [{expiresAt:Date.now()-1},{expiresAt:Date.now()+300001},{label:'x'.repeat(81)},{label:'\nspoof'},{label:'spoof\u202ename'},{label:''},{label:' padded '},{revision:-1},{revision:Number.MAX_SAFE_INTEGER},{extra:'secret'},{wallet:other.address}])expect(validProfileCommand(command(patch),service)).toBe(false);
 expect(validPublicProfile({version:1,wallet,revision:0,label:'injected',updatedAt:0},wallet)).toBe(false);
});
it('preserves invalid stored data and stops edits instead of resetting the replay fence',async()=>{
 const config=publicProfileConfig();records.set(config.prefix+wallet,'broken');expect((await call({},'GET')).code).toBe(503);expect((await call(await signed())).code).toBe(503);expect(records.get(config.prefix+wallet)).toBe('broken');
});
it('serializes different writes at one revision and rejects expired signatures after verification',async()=>{
 const results=await Promise.all([call(await signed()),call(await signed(command({label:'Another'})))]);expect(results.map(r=>r.code).sort()).toEqual([200,409]);
 const kv=vi.fn();const profiles=createPublicProfiles(publicProfileConfig(),kv);expect(await profiles.write(command({expiresAt:Date.now()-1}))).toEqual({status:'expired'});expect(kv).not.toHaveBeenCalled();
});
it('caps read batches, denies malformed methods/content/bodies and untrusted origins',async()=>{
 for(const query of [{wallet:[wallet]},{wallet:wallet+','+wallet},{wallet:'bad'},{wallet,extra:'x'},{wallet:Array.from({length:51},(_,i)=>'0x'+i.toString(16).padStart(40,'0')).join(',')}])expect((await call({},'GET',query)).code).toBe(400);
 expect((await call({},'DELETE')).code).toBe(405);expect((await call({},'POST',{wallet},{'content-type':'text/plain'})).code).toBe(415);expect((await call({padding:'x'.repeat(12001)})).code).toBe(413);
 expect((await call({},'GET',{wallet},{origin:'https://attacker.example'})).code).toBe(403);
 vi.stubEnv('CHIRPY_SYNC_MIGRATION_ORIGINS','https://new.example');const response=await call({},'GET',{wallet},{origin:'https://new.example'});expect(response.code).toBe(200);expect(response.headers['Cache-Control']).toBe('no-store');
});
it('disables previews and invalid configuration, and enforces rate limits',async()=>{
 vi.stubEnv('VERCEL_ENV','preview');expect((await call({},'GET')).code).toBe(503);vi.stubEnv('VERCEL_ENV','production');vi.stubEnv('CHIRPY_RATE_LIMIT_MAX','1');expect((await call({},'GET')).code).toBe(200);expect((await call({},'GET')).code).toBe(429);
 for(const patch of [{CHIRPY_SYNC_SERVICE_URL:'http://bad/api/usersync'},{CHIRPY_SYNC_SERVICE_URL:'https://bad/wrong'},{KV_REST_API_URL:'https://user:pass@kv.example'}])expect(publicProfileConfig({...process.env,...patch})).toBeNull();
});

it('verifies contract signatures only against the configured Ethereum mainnet and fails closed on bad RPC results',async()=>{
 const config={...publicProfileConfig(),rpc:'https://rpc.example'};let chain='0x1',valid='0x1';const calls:string[]=[];
 vi.mocked(fetch).mockImplementation(async(_url,init)=>{const request=JSON.parse(init!.body as string);calls.push(request.method);return Response.json({jsonrpc:'2.0',id:request.id,result:request.method==='eth_chainId'?chain:valid});});
 expect(await verifyProfileSignature(config,command(),'0x1234')).toBe(true);expect(calls).toContain('eth_call');
 chain='0x89';calls.length=0;expect(await verifyProfileSignature(config,command(),'0x1234')).toBe(false);expect(calls).toEqual(['eth_chainId']);
 chain='0x1';valid='0x0';expect(await verifyProfileSignature(config,command(),'0x1234')).toBe(false);
 vi.mocked(fetch).mockRejectedValue(Error('unavailable'));expect(await verifyProfileSignature(config,command(),'0x1234')).toBe(false);
});

it('logs only fixed schema diagnostics for invalid storage without leaking stored values or identity',async()=>{
 const config=publicProfileConfig(),key=config.prefix+wallet;
 const invalid={version:1,wallet,revision:2,updatedAt:123};records.set(key,JSON.stringify(invalid));
 expect((await call({},'GET')).code).toBe(503);
 expect(console.error).toHaveBeenLastCalledWith('chat_profile_storage_invalid',{reason:'schema',object:true,fields:false,version:true,wallet:true,revision:true,labelKind:'missing',label:false,updatedAt:true});
 records.set(key,JSON.stringify({...invalid,label:'Private test name',unexpectedPrivateKey:'Private test value'}));
 expect((await call({},'GET')).code).toBe(503);
 records.set(key,'malformed Private test name');expect((await call({},'GET')).code).toBe(503);
 const logs=JSON.stringify(vi.mocked(console.error).mock.calls);
 for(const forbidden of [wallet,'Private test name','Private test value','unexpectedPrivateKey'])expect(logs).not.toContain(forbidden);
 expect(records.get(key)).toBe('malformed Private test name');
});
