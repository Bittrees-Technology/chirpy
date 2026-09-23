import {parseSettingsRaw} from './settingsStorage';
import type {EncryptedSyncBlobSnapshot,SettingsSyncPayload} from './userSync';

export const SYNC_READ_PAUSED='Encrypted sync is paused because remote data could not be safely read. Local and remote data were kept. Update Chat or restore access, then re-enable sync.';
export class SyncReadError extends Error {constructor(){super(SYNC_READ_PAUSED);}}
const record=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const timestamp=(value:unknown):value is number=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0&&value<Number.MAX_SAFE_INTEGER;
const exact=(value:Record<string,unknown>,keys:string[])=>Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
function fail():never{throw new SyncReadError();}
function decode(value:unknown){
 if(typeof value!=='string'||value.length>400000)fail();
 let binary:string;try{binary=atob(value);if(btoa(binary)!==value)fail();}catch{return fail();}
 return Uint8Array.from(binary,c=>c.charCodeAt(0));
}
/** Preserve arbitrary legacy message fields; never filter away data we cannot interpret. */
export function parseSyncPayload(value:unknown):SettingsSyncPayload{
 if(!record(value)||!exact(value,['version','settingsPrefs','savedMessages','updatedAt'])||value.version!==1||!timestamp(value.updatedAt)||!record(value.settingsPrefs)||!Array.isArray(value.savedMessages))fail();
 const settings=value.settingsPrefs;
 if(!['readReceiptsDefault','syncAcrossDevices','blocked'].every(key=>Object.hasOwn(settings,key))||Object.keys(settings).some(key=>!['readReceiptsDefault','readReceiptOverrides','syncAcrossDevices','blocked'].includes(key)))fail();
 let prefs;try{prefs=parseSettingsRaw(JSON.stringify(value.settingsPrefs)).prefs;}catch{return fail();}
 if(value.savedMessages.some(item=>!record(item)||typeof item.id!=='string'||!item.id||('updatedAt' in item&&!timestamp(item.updatedAt))))fail();
 return {version:1,settingsPrefs:prefs,savedMessages:value.savedMessages as SettingsSyncPayload['savedMessages'],updatedAt:value.updatedAt};
}
export async function decryptSettingsPayload(blob:EncryptedSyncBlobSnapshot,key:CryptoKey,address:string):Promise<SettingsSyncPayload>{
 try{
  if(!record(blob)||!exact(blob,['version','algorithm','kdf','address','iv','ciphertext','updatedAt'])||blob.version!==1||blob.algorithm!=='AES-GCM'||blob.kdf!=='HKDF-SHA-256'||typeof blob.address!=='string'||blob.address.toLowerCase()!==address.toLowerCase()||!timestamp(blob.updatedAt))fail();
  const iv=decode(blob.iv),ciphertext=decode(blob.ciphertext);if(iv.length!==12||ciphertext.length<16)fail();
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,ciphertext);
  return parseSyncPayload(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(plaintext)));
 }catch{return fail();}
}
