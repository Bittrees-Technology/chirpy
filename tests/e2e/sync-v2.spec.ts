import { test, expect, injectSyntheticWallet } from './fixtures/wallet';
import type { Page, BrowserContext, Route } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, recoverMessageAddress, keccak256, stringToHex } from 'viem';
import { syncGrantMessage, syncWriteMessage, syncRevokeDeviceMessage } from '../../packages/core/src/syncAuth';
import { decryptSyncPayloadV2 } from '../../apps/web/src/versionedSyncCipher';
const peer='0x'+'b'.repeat(40);
async function keyFor(wallet:ReturnType<typeof privateKeyToAccount>) {
 const signature=await wallet.signMessage({message:`Chirpy: enable encrypted sync\nAddress: ${wallet.address}\nThis is a gas-free signature used only to derive your sync key.`});
 const input=await crypto.subtle.importKey('raw',hexToBytes(signature),'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${wallet.address.toLowerCase()}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function legacyBlob(key:CryptoKey,address:string) {
 const payload={version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[peer]},savedMessages:[{id:'legacy-item',body:'Synthetic older saved item',custom:{retained:true}}],updatedAt:10};
 const iv=crypto.getRandomValues(new Uint8Array(12)),encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
 return JSON.stringify({version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(encrypted).toString('base64'),updatedAt:10});
}
function service(wallet:string,initial:string|null=null) {
 const state={blob:initial,revision:initial?1:0,minimum:1,epoch:0,capability:true,loseAck:false,writes:0};const revoked=new Set<string>();
 const route=async(route:Route)=>{
  const request=route.request(),service=new URL('/api/usersync',request.url()).href;
  if(request.method()==='GET')return route.fulfill({json:{blob:state.blob,revision:state.revision,epoch:state.epoch,authVersion:2,service,...(state.capability?{payloadVersions:[1,2],minPayloadVersion:state.minimum}:{})}});
  const body=request.postDataJSON(),grant=body.authorization;
  expect(grant.address).toBe(wallet.toLowerCase());expect(grant.service).toBe(service);expect(grant.epoch).toBe(state.epoch);
  expect((await recoverMessageAddress({message:syncGrantMessage(grant),signature:grant.signature})).toLowerCase()).toBe(wallet.toLowerCase());
  const message=body.action==='write'?syncWriteMessage(grant,body.expectedRevision,keccak256(stringToHex(body.blob))):syncRevokeDeviceMessage(grant);
  expect((await recoverMessageAddress({message,signature:body.signature})).toLowerCase()).toBe(grant.device);
  if(body.action==='revoke-device'){revoked.add(grant.device);return route.fulfill({json:{ok:true}});}
  expect(revoked.has(grant.device)).toBe(false);
  if(body.expectedRevision!==state.revision)return route.fulfill({status:409,json:{stale:true}});
  expect(JSON.parse(body.blob).payloadVersion).toBe(2);state.blob=body.blob;state.revision++;state.minimum=2;state.writes++;
  if(state.loseAck){state.loseAck=false;return route.abort('failed');}
  return route.fulfill({json:{ok:true,revision:state.revision,minPayloadVersion:2}});
 };
 return {state,route};
}
async function connect(page:Page) {
 await page.goto('/');const decline=page.getByRole('button',{name:'Decline',exact:true});if(await decline.isVisible())await decline.click();
 await page.locator('.nav-item',{hasText:'Settings'}).click();const button=page.getByRole('button',{name:'Connect wallet',exact:true});if(await button.isVisible())await button.click();
 await page.getByRole('button',{name:'Disconnect',exact:true}).waitFor();
}
const stored=(page:Page,address:string)=>page.evaluate(address=>JSON.parse(localStorage.getItem(`chat:settingsPrefs:v1:wallet:${address.toLowerCase()}`)!),address);
async function enable(page:Page,choice?:'remote'|'local') {
 await page.getByRole('button',{name:/^(Turn on|Re-enable)$/}).click();
 if(choice)await page.getByRole('button',{name:choice==='remote'?'Use synced settings':'Keep this device’s settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
}

test('two devices preserve deletion and unblock through an offline edit, then refuse an older API without losing local choices',async({browser})=>{
 const secret=generatePrivateKey(),wallet=privateKeyToAccount(secret),key=await keyFor(wallet),server=service(wallet.address,await legacyBlob(key,wallet.address));
 const contexts:BrowserContext[]=[];let offlineB=false;
 try {
  const a=await browser.newContext(),b=await browser.newContext();contexts.push(a,b);
  await injectSyntheticWallet(a,secret);await injectSyntheticWallet(b,secret);
  await a.route('**/api/usersync**',server.route);await b.route('**/api/usersync**',route=>offlineB?route.abort('internetdisconnected'):server.route(route));
  const one=await a.newPage(),two=await b.newPage();await one.clock.install();await two.clock.install();await connect(one);await enable(one);
  await connect(two);await enable(two,'remote');expect((await stored(one,wallet.address)).syncMinimum).toBe(2);expect((await stored(two,wallet.address)).syncMinimum).toBe(2);
  offlineB=true;
  one.once('dialog',dialog=>dialog.accept());await one.getByRole('button',{name:'Delete saved item',exact:true}).click();
  await one.getByText('Legacy blocked-address preferences',{exact:true}).click();await one.getByRole('button',{name:'Remove old preference',exact:true}).click();await one.clock.runFor(2000);
  await expect.poll(async()=>{const data=await decryptSyncPayloadV2(JSON.parse(server.state.blob!),key,wallet.address);return data.savedMessages['legacy-item'].value===null&&data.blocked[peer].value===false;}).toBe(true);
  const before=server.state.writes;await two.getByRole('switch',{name:'Read receipts default',exact:true}).click();await two.clock.runFor(2000);
  await expect(two.getByRole('alert')).toContainText('Encrypted sync is paused');expect(server.state.writes).toBe(before);
  offlineB=false;await enable(two);const shared=await decryptSyncPayloadV2(JSON.parse(server.state.blob!),key,wallet.address);
  expect(shared.savedMessages['legacy-item'].value).toBeNull();expect(shared.blocked[peer].value).toBe(false);expect(shared.readReceiptsDefault.value).toBe(true);
  await expect(two.getByRole('heading',{name:'Previously saved items'})).toHaveCount(0);
  await one.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(one.getByRole('switch',{name:'Read receipts default',exact:true})).toHaveAttribute('aria-checked','true');
  server.state.capability=false;const cloud=server.state.blob,writes=server.state.writes;
  await one.getByRole('switch',{name:'Read receipts default',exact:true}).click();await one.clock.runFor(2000);await expect(one.getByRole('alert')).toContainText('Encrypted sync is paused');
  expect(server.state.blob).toBe(cloud);expect(server.state.writes).toBe(writes);expect((await stored(one,wallet.address)).syncPayload.readReceiptsDefault.value).toBe(false);
  server.state.capability=true;await enable(one);expect((await stored(one,wallet.address)).syncMinimum).toBe(2);
  const beforeRevocation=await stored(one,wallet.address),writesBeforeRevocation=server.state.writes;
  server.state.epoch++;await one.evaluate(()=>window.dispatchEvent(new Event('focus')));
  await expect(one.getByRole('alert')).toContainText('Sync is paused');expect(server.state.writes).toBe(writesBeforeRevocation);expect(await stored(one,wallet.address)).toEqual(beforeRevocation);
 } finally {for(const context of contexts)await context.close();}
},60000);

test('a lost first acknowledgement retains prepared data and safely confirms the upgrade after reload',async({browser})=>{
 const secret=generatePrivateKey(),wallet=privateKeyToAccount(secret),server=service(wallet.address);server.state.loseAck=true;
 const context=await browser.newContext();try {
  await injectSyntheticWallet(context,secret);await context.route('**/api/usersync**',server.route);const page=await context.newPage();await connect(page);
  await page.getByRole('switch',{name:'Read receipts default',exact:true}).click();await page.getByRole('button',{name:'Turn on',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Sync was not confirmed'})).toBeVisible();expect(server.state.minimum).toBe(2);
  const prepared=await stored(page,wallet.address);expect(prepared.syncMinimum).toBe(1);expect(prepared.syncPayload.readReceiptsDefault.value).toBe(true);expect(prepared.syncAcrossDevices).toBe(false);
  await page.reload();await page.locator('.nav-item',{hasText:'Settings'}).click();await enable(page);
  const confirmed=await stored(page,wallet.address);expect(confirmed.syncMinimum).toBe(2);expect(confirmed.syncPayload.readReceiptsDefault.value).toBe(true);
 } finally {await context.close();}
});

test('an old local copy requires a preference choice and cannot resurrect a remotely deleted saved item',async({browser})=>{
 const secret=generatePrivateKey(),wallet=privateKeyToAccount(secret),key=await keyFor(wallet),old=await legacyBlob(key,wallet.address),server=service(wallet.address,old);
 const a=await browser.newContext(),b=await browser.newContext();try {
  await injectSyntheticWallet(a,secret);await injectSyntheticWallet(b,secret);await a.route('**/api/usersync**',server.route);await b.route('**/api/usersync**',server.route);
  const one=await a.newPage();await one.clock.install();await connect(one);await enable(one);
  one.once('dialog',dialog=>dialog.accept());await one.getByRole('button',{name:'Delete saved item',exact:true}).click();await one.clock.runFor(2000);
  await expect.poll(async()=>(await decryptSyncPayloadV2(JSON.parse(server.state.blob!),key,wallet.address)).savedMessages['legacy-item'].value).toBeNull();
  const two=await b.newPage();await connect(two);await two.getByRole('switch',{name:'Read receipts default',exact:true}).click();
  const blobKey=`chat:settingsSyncBlob:v1:wallet:${wallet.address.toLowerCase()}`;await two.evaluate(({key,old})=>localStorage.setItem(key,old),{key:blobKey,old});
  await expect.poll(async()=>(await stored(two,wallet.address))?.readReceiptsDefault).toBe(true);
  const before=await stored(two,wallet.address),writes=server.state.writes;await two.getByRole('button',{name:'Turn on',exact:true}).click();
  await expect(two.getByRole('button',{name:'Keep this device’s settings',exact:true})).toBeVisible();expect(await stored(two,wallet.address)).toEqual(before);expect(server.state.writes).toBe(writes);
  await two.getByRole('button',{name:'Keep this device’s settings',exact:true}).click();await expect(two.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
  const cloud=await decryptSyncPayloadV2(JSON.parse(server.state.blob!),key,wallet.address);expect(cloud.savedMessages['legacy-item'].value).toBeNull();expect(cloud.readReceiptsDefault.value).toBe(true);
  expect(await two.evaluate(key=>localStorage.getItem(key),blobKey)).toBe(old);await two.getByRole('button',{name:'Turn off',exact:true}).click();expect(await two.evaluate(key=>localStorage.getItem(key),blobKey)).toBe(old);
 } finally {await a.close();await b.close();}
},60000);

test('first upgrade retains a newer preference timestamp stored by a legacy client',async({browser})=>{
 const secret=generatePrivateKey(),wallet=privateKeyToAccount(secret),key=await keyFor(wallet),old=await legacyBlob(key,wallet.address),server=service(wallet.address,old);
 const context=await browser.newContext();try {
  await injectSyntheticWallet(context,secret);await context.route('**/api/usersync**',server.route);const page=await context.newPage();await connect(page);
  await page.evaluate(({wallet,old})=>{
   const scope=`wallet:${wallet.toLowerCase()}`;
   localStorage.setItem(`chat:settingsPrefs:v1:${scope}`,JSON.stringify({readReceiptsDefault:true,syncAcrossDevices:false,blocked:[]}));
   localStorage.setItem(`chat:settingsPrefsUpdatedAt:v1:${scope}`,'20');localStorage.setItem(`chat:settingsSyncBlob:v1:${scope}`,old);
  },{wallet:wallet.address,old});
  await page.reload();await page.locator('.nav-item',{hasText:'Settings'}).click();await enable(page);
  const data=await decryptSyncPayloadV2(JSON.parse(server.state.blob!),key,wallet.address);
  expect(data.readReceiptsDefault).toEqual({value:true,updatedAt:20});expect(data.savedMessages['legacy-item'].value?.custom).toEqual({retained:true});
 } finally {await context.close();}
});
