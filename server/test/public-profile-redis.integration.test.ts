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
 it('uses Redis time to reject a signature that expires after verification without changing storage',async()=>{
  const key='chat:profiles:test:'+randomBytes(8).toString('hex');
  const result=await kv(['EVAL',PROFILE_CAS,'1',key,'',String(Date.now()-1),JSON.stringify({version:1,wallet,revision:1,label:'Too late',updatedAt:0})]);expect(result).toEqual([-2]);expect(await kv(['GET',key])).toBeNull();
 });
 it('compares the exact stored record and never overwrites another committed edit',async()=>{
  const key='chat:profiles:test:'+randomBytes(8).toString('hex'),current=JSON.stringify({version:1,wallet,revision:1,label:null,updatedAt:1});await kv(['SET',key,current]);keys.add(key);
  expect(await kv(['EVAL',PROFILE_CAS,'1',key,'',String(Date.now()+60000),JSON.stringify({version:1,wallet,revision:1,label:'Stale',updatedAt:0})])).toEqual([0]);expect(await kv(['GET',key])).toBe(current);
 });
});
