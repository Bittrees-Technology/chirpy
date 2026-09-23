import { upgradeSyncPayloadV1 } from '../../apps/web/src/versionedSync';
import {test,expect} from './fixtures/wallet';
import {webcrypto} from 'node:crypto';
import {stringToHex,hexToBytes} from 'viem';

test('a newer encrypted snapshot pauses sync, survives local edits and reload, and can resume after a compatible read',async({page,walletAddress})=>{
 await page.clock.install();
 let record:{blob:string|null;revision:number}={blob:null,revision:0},writes=0,reads=0;
 const service=(url:string)=>new URL('/api/usersync',url).href;
 await page.route('**/api/usersync**',async route=>{
  if(route.request().method()==='GET')reads++;
  if(route.request().method()==='GET')return route.fulfill({json:{...record,payloadVersions:[1,2],minPayloadVersion:record.blob&&JSON.parse(record.blob).payloadVersion===2?2:1,epoch:0,authVersion:2,service:service(route.request().url())}});
  const request=route.request().postDataJSON();expect(request.action).toBe('write');writes++;
  if(request.expectedRevision!==record.revision)return route.fulfill({status:409,json:{stale:true}});
  record={blob:request.blob,revision:record.revision+1};return route.fulfill({json:{ok:true,revision:record.revision,minPayloadVersion:2}});
 });
 await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();
 await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 const message=`Chirpy: enable encrypted sync\nAddress: ${walletAddress}\nThis is a gas-free signature used only to derive your sync key.`;
 // Disposable test wallet only; use the application's unchanged key derivation contract.
 const signature=await page.evaluate(async message=>(window as any).__walletSign([message]),stringToHex(message));
 const input=await webcrypto.subtle.importKey('raw',hexToBytes(signature),'HKDF',false,['deriveKey']);
 const key=await webcrypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${walletAddress.toLowerCase()}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
 const legacy={version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'original',body:'Synthetic original',custom:{preserve:true}}],updatedAt:10};
 const encrypt=async(payload:any,upgraded=false)=>{
  const iv=webcrypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv,...(upgraded?{additionalData:new TextEncoder().encode(`Chat encrypted settings payload v2\nWallet: ${walletAddress.toLowerCase()}\nUpdated at: ${payload.updatedAt}`)}:{})},key,new TextEncoder().encode(JSON.stringify(payload)));
  return JSON.stringify({version:1,...(upgraded?{payloadVersion:2}:{}),algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:walletAddress,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(ciphertext).toString('base64'),updatedAt:payload.updatedAt});
 };
 record={blob:await encrypt(legacy),revision:1};
 await page.getByRole('button',{name:'Turn on',exact:true}).click();await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
 await expect.poll(()=>reads).toBeGreaterThanOrEqual(3);await page.clock.runFor(3000);
 await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
 const future=await encrypt({...upgradeSyncPayloadV1(legacy),version:3,tombstones:['original']},true);record={blob:future,revision:record.revision+1};
 const toggle=page.getByRole('switch',{name:'Read receipts default',exact:true});await toggle.click();
 await page.clock.runFor(2000);
 await expect(page.getByRole('alert')).toContainText('Encrypted sync is paused');
 const stopped=writes;await toggle.click();await page.clock.runFor(3000);
 expect(writes).toBe(stopped);expect(record.blob).toBe(future);
 await page.reload();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();
 await page.getByRole('button',{name:/Re-enable|Turn on/}).click();await expect(page.getByRole('status').filter({hasText:'Encrypted sync is paused'})).toBeVisible();
 expect(writes).toBe(stopped);expect(record.blob).toBe(future);
 record={blob:await encrypt(upgradeSyncPayloadV1(legacy),true),revision:record.revision+1};
 await page.getByRole('button',{name:/Re-enable|Turn on/}).click();await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
 const saved=JSON.parse(record.blob!);const payload=JSON.parse(new TextDecoder().decode(await webcrypto.subtle.decrypt({name:'AES-GCM',iv:Buffer.from(saved.iv,'base64'),additionalData:new TextEncoder().encode(`Chat encrypted settings payload v2\nWallet: ${walletAddress.toLowerCase()}\nUpdated at: ${saved.updatedAt}`)},key,Buffer.from(saved.ciphertext,'base64'))));
 expect(payload.savedMessages.original.value).toEqual(legacy.savedMessages[0]);expect(payload.version).toBe(2);
});
