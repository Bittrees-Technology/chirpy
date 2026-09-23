import {createHash} from 'node:crypto';
import {createPublicClient,http,recoverMessageAddress} from 'viem';
import {mainnet} from 'viem/chains';
import {profileAddress,profileLabel,validPublicProfile,validProfileCommand,profileSignMessage} from '../packages/core/src/publicProfile.js';
import {mailKv} from './mail-service.js';
export function publicProfileConfig(env=process.env){
 if(env.VERCEL_ENV&&env.VERCEL_ENV!=='production')return null;
 try{
  const canonical=new URL(env.CHIRPY_SYNC_SERVICE_URL),kv=new URL(env.KV_REST_API_URL||env.UPSTASH_REDIS_REST_URL);
  if(canonical.protocol!=='https:'||canonical.pathname!=='/api/usersync'||canonical.search||canonical.hash||canonical.username||canonical.password||kv.protocol!=='https:'||kv.username||kv.password||!(env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN))return null;
  const service=new URL('/api/profile',canonical).href;
  return {service,kvUrl:kv.href,kvToken:env.KV_REST_API_TOKEN||env.UPSTASH_REDIS_REST_TOKEN,rpc:env.MAINNET_RPC_URL,prefix:`chat:profiles:v1:${createHash('sha256').update(service).digest('hex')}:`};
 }catch{return null;}
}
// Persist the revision even on withdrawal. Old signed publication cannot resurrect a name.
export const PROFILE_CAS=`
local clock=redis.call('TIME')
local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
if now>=tonumber(ARGV[2]) or tonumber(ARGV[2])>now+300000 then return {-2} end
local raw=redis.call('GET',KEYS[1])
if (raw or '')~=ARGV[1] then return {0} end
-- Preserve JSON null, escaped names and safe-integer revisions verbatim. Lua
-- JSON codecs need not preserve those values across decode/encode round trips.
local next=string.sub(ARGV[3],1,-2)..',"updatedAt":'..string.format('%.0f',now)..'}'
redis.call('SET',KEYS[1],next)
return {1,next}
`;
export async function verifyProfileSignature(config,command,signature){
 if(!validProfileCommand(command,config.service)||typeof signature!=='string'||!/^0x(?:[a-fA-F0-9]{2}){1,4096}$/.test(signature))return false;
 const message=profileSignMessage(command);
 try{if((await recoverMessageAddress({message,signature})).toLowerCase()===command.wallet)return true;}catch{}
 try{if(!config.rpc||new URL(config.rpc).protocol!=='https:')return false;
  const client=createPublicClient({chain:mainnet,transport:http(config.rpc,{timeout:8000,retryCount:0})});
  if(await client.getChainId()!==1)return false;
  return await client.verifyMessage({address:command.wallet,message,signature});
 }catch{return false;}
}
export function createPublicProfiles(config,kv=mailKv(config)){
 const key=wallet=>`${config.prefix}${wallet}`;
 const parse=(raw,wallet)=>{
  if(raw===null)return {version:1,wallet,revision:0,label:null,updatedAt:0};
  const invalid=diagnostic=>{console.error('chat_profile_storage_invalid',diagnostic);throw Error('Invalid profile storage');};
  if(typeof raw!=='string'||raw.length>4096)return invalid({reason:'representation'});
  let data;try{data=JSON.parse(raw);}catch{return invalid({reason:'json'});}
  if(!validPublicProfile(data,wallet)){
   // Only fixed schema checks enter logs. Never log keys, raw values, identity,
   // name, signature, request bodies or parser errors derived from stored data.
   const object=!!data&&typeof data==='object'&&!Array.isArray(data);
   return invalid({reason:'schema',object,
    fields:object&&Object.keys(data).sort().join(',')==='label,revision,updatedAt,version,wallet',
    version:object&&data.version===1,wallet:object&&data.wallet===wallet,
    revision:object&&Number.isSafeInteger(data.revision)&&data.revision>=0&&data.revision<Number.MAX_SAFE_INTEGER,
    labelKind:!object||!Object.hasOwn(data,'label')?'missing':data.label===null?'null':typeof data.label==='string'?'string':'other',
    label:object&&profileLabel(data.label),
    updatedAt:object&&Number.isSafeInteger(data.updatedAt)&&data.updatedAt>=0});
  }return data;
 };
 return {
  async readMany(wallets){if(!Array.isArray(wallets)||wallets.length<1||wallets.length>50||!wallets.every(profileAddress)||new Set(wallets).size!==wallets.length)throw Error('Invalid wallets');
   const raw=await kv(['MGET',...wallets.map(key)]);if(!Array.isArray(raw)||raw.length!==wallets.length)throw Error('Invalid profile storage');return raw.map((value,i)=>parse(value,wallets[i]));},
  async read(wallet){if(!profileAddress(wallet))throw Error('Invalid wallet');return parse(await kv(['GET',key(wallet)]),wallet);},
  async write(command){
   if(!validProfileCommand(command,config.service))return {status:'expired'};
   const raw=await kv(['GET',key(command.wallet)]),current=parse(raw,command.wallet);
   if(current.revision!==command.revision)return {status:'conflict'};
   const next={version:1,wallet:command.wallet,revision:command.revision+1,label:command.label};
   const result=await kv(['EVAL',PROFILE_CAS,'1',key(command.wallet),raw??'',String(command.expiresAt),JSON.stringify(next)]);
   if(result[0]===-2)return {status:'expired'};if(result[0]===0)return {status:'conflict'};
   if(result[0]!==1)throw Error('Invalid profile storage');
   return {status:'saved',profile:parse(result[1],command.wallet)};
  }
 };
}
