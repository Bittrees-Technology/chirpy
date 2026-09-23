import {afterEach,describe,expect,it} from 'vitest';
import {execFile} from 'node:child_process';import {promisify} from 'node:util';import {randomBytes} from 'node:crypto';
import {createPublicProfiles,PROFILE_CAS} from '../public-profile.js';
const container=process.env.CHIRPY_TEST_REDIS_CONTAINER,exec=promisify(execFile);
describe.skipIf(!container)('real Redis public profile authority',()=>{
 const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/profile',keys=new Set<string>();
 const kv=async(args:any[])=>{if(args[0]==='EVAL')keys.add(args[3]);const {stdout}=await exec('docker',['exec',container!,'redis-cli','--json',...args.map(String)]);const value=JSON.parse(stdout);if(typeof value==='string'&&value.startsWith('ERR '))throw Error(value);return value;};
 afterEach(async()=>{if(keys.size)await kv(['DEL',...keys]);keys.clear();});
 it('atomically admits one conflicting publication, withdraws, and preserves a permanent replay fence',async()=>{
  const config={service,prefix:'chat:profiles:test:'+randomBytes(8).toString('hex')+':'},api=createPublicProfiles(config,kv),command={version:1,wallet,service,revision:0,label:'Public name',expiresAt:Date.now()+60000};
  const results=await Promise.all([api.write(command),api.write({...command,label:'Other'})]);expect(results.map(r=>r.status).sort()).toEqual(['conflict','saved']);
  expect((await api.write({...command,revision:1,label:null})).status).toBe('saved');expect((await api.write(command)).status).toBe('conflict');
  expect(await api.read(wallet)).toMatchObject({revision:2,label:null});expect(await kv(['TTL',config.prefix+wallet])).toBe(-1);expect(await kv(['GET',config.prefix+wallet])).not.toContain('Public name');
 });
 it('preserves JSON null, escaped labels and the full safe-integer revision through Redis storage',async()=>{
  const config={service,prefix:'chat:profiles:test:'+randomBytes(8).toString('hex')+':'},key=config.prefix+wallet,api=createPublicProfiles(config,kv);
  keys.add(key);await kv(['SET',key,JSON.stringify({version:1,wallet,revision:9007199254740980,label:null,updatedAt:1})]);
  const label='Literal "quote" \\ slash 🐦 %1',command={version:1,wallet,service,revision:9007199254740980,label,expiresAt:Date.now()+60000};
  const saved=await api.write(command);expect(saved).toMatchObject({status:'saved',profile:{label,revision:9007199254740981}});
  const withdrawn=await api.write({...command,revision:9007199254740981,label:null});expect(withdrawn).toMatchObject({status:'saved',profile:{label:null,revision:9007199254740982}});
  const raw=await kv(['GET',key]);expect(raw).toContain('"label":null');expect(raw).toContain('"revision":9007199254740982');
  expect(await api.read(wallet)).toEqual(withdrawn.profile);expect(await api.write(command)).toEqual({status:'conflict'});
 });
 it('recovers only the old missing-null shape while fencing stale and concurrent authorized writes against exact old bytes',async()=>{
  const config={service,prefix:'chat:profiles:test:'+randomBytes(8).toString('hex')+':'},key=config.prefix+wallet,api=createPublicProfiles(config,kv);
  const raw=JSON.stringify({version:1,wallet,revision:2,updatedAt:123});keys.add(key);await kv(['SET',key,raw]);
  expect(await api.readMany([wallet])).toEqual([{version:1,wallet,revision:2,updatedAt:123,label:null}]);expect(await kv(['GET',key])).toBe(raw);
  const command={version:1,wallet,service,revision:2,label:null,expiresAt:Date.now()+60000};
  expect(await api.write({...command,revision:1,label:'Old publication'})).toEqual({status:'conflict'});
  const results=await Promise.all([api.write(command),api.write({...command,label:'New name'})]);expect(results.map(r=>r.status).sort()).toEqual(['conflict','saved']);
  expect((await api.read(wallet)).revision).toBe(3);expect(await kv(['TTL',key])).toBe(-1);
  expect(await api.write({...command,label:'Old recovered revision'})).toEqual({status:'conflict'});
 });
 it('uses Redis time to reject a signature that expires after verification without changing storage',async()=>{
  const key='chat:profiles:test:'+randomBytes(8).toString('hex');
  const result=await kv(['EVAL',PROFILE_CAS,'1',key,'',String(Date.now()-1),JSON.stringify({version:1,wallet,revision:1,label:'Too late'})]);expect(result).toEqual([-2]);expect(await kv(['GET',key])).toBeNull();
 });
 it('compares the exact stored record and never overwrites another committed edit',async()=>{
  const key='chat:profiles:test:'+randomBytes(8).toString('hex'),current=JSON.stringify({version:1,wallet,revision:1,label:null,updatedAt:1});await kv(['SET',key,current]);keys.add(key);
  expect(await kv(['EVAL',PROFILE_CAS,'1',key,'',String(Date.now()+60000),JSON.stringify({version:1,wallet,revision:1,label:'Stale'})])).toEqual([0]);expect(await kv(['GET',key])).toBe(current);
 });
});
