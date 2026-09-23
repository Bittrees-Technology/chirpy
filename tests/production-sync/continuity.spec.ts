import {test, expect, type BrowserContext, type Page} from '@playwright/test';
import {generatePrivateKey, privateKeyToAccount} from 'viem/accounts';
import {hexToBytes, hexToString, keccak256, stringToHex} from 'viem';
import {syncGrantMessage, syncWriteMessage, syncRevokeAllMessage} from '../../packages/core/src/syncAuth.js';
import {decryptSyncPayloadV2} from '../../apps/web/src/versionedSyncCipher';

if(process.env.CHAT_PRODUCTION_SYNC_ACCEPTANCE!=='1'||!/^[a-f0-9]{40}$/.test(process.env.CHAT_EXPECTED_SHA??''))throw Error('Production sync acceptance requires explicit activation and a reviewed commit.');

const origins=['https://chirpy.bittrees.org','https://chat.bittrees.org'];
const service=origins[0]+'/api/usersync';
class RateLimitError extends Error {
 constructor(readonly retryAfter:number){super('Production sync rate limit reached.');}
}
const peer='0x'+'b'.repeat(40);
const wallet=privateKeyToAccount(generatePrivateKey());
const address=wallet.address.toLowerCase();
const deriveMessage=`Chirpy: enable encrypted sync\nAddress: ${wallet.address}\nThis is a gas-free signature used only to derive your sync key.`;
async function api(origin:string,body?:unknown,expectedStatus=200){
 const response=await fetch(origin+'/api/usersync'+(body?'':'?address='+address),{
  method:body?'POST':'GET',redirect:'error',headers:{Origin:origin,...(body?{'Content-Type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),
 });
 if(response.status===429)throw new RateLimitError(Math.min(60000,Math.max(1000,Number(response.headers.get('retry-after')||60)*1000)));
 const data=await response.json();expect(response.status).toBe(expectedStatus);return data;
}
async function keyFor(){
 const signature=await wallet.signMessage({message:deriveMessage});
 const input=await crypto.subtle.importKey('raw',new Uint8Array(hexToBytes(signature)),'HKDF',false,['deriveKey']);
 return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:new TextEncoder().encode(`Chirpy encrypted sync v1:${address}`),info:new TextEncoder().encode('settings-prefs-and-saved-messages')},input,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function inject(context:BrowserContext){
 await context.route('**/*',route=>{
  const url=new URL(route.request().url());
  return origins.includes(url.origin)||['blob:','data:'].includes(url.protocol)?route.continue():route.abort('blockedbyclient');
 });
 await context.exposeFunction('__syncWalletSign',async(params:string[])=>{
  expect(params[1]?.toLowerCase()).toBe(address);
  const message=hexToString(params[0] as `0x${string}`);
  if(message!==deriveMessage){
   // Only the existing sync grant is allowed. Never sign XMTP registration, mail, profiles or transactions.
   const match=/^Chirpy sync device authorization \(v2\)\nService: (.+)\nWallet: (.+)\nDevice: (.+)\nIssued: (\d+)\nExpires: (\d+)\nEpoch: (\d+)\n/.exec(message);
   if(!match)throw Error('Synthetic wallet declined unrelated signing request.');
   const grant={version:2 as const,service:match[1],address:match[2],device:match[3],issuedAt:Number(match[4]),expiresAt:Number(match[5]),epoch:Number(match[6])};
   expect(grant.service).toBe(service);expect(grant.address).toBe(address);expect(grant.device).toMatch(/^0x[a-f0-9]{40}$/);
   expect(Math.abs(Date.now()-grant.issuedAt)).toBeLessThan(30000);expect(grant.expiresAt-grant.issuedAt).toBe(86400000);
   expect(message).toBe(syncGrantMessage(grant));
  }
  return wallet.signMessage({message});
 });
 await context.addInitScript(({address})=>{
  (window as any).ethereum={isMetaMask:true,on(){},removeListener(){},async request({method,params}:any){
   if(method==='eth_accounts'||method==='eth_requestAccounts')return [address];
   if(method==='eth_chainId')return '0x1';
   if(method==='personal_sign')return (window as any).__syncWalletSign(params);
   throw Error('Synthetic wallet declined '+method);
  }};
 },{address:wallet.address});
}
async function connect(page:Page,origin:string){
 await page.goto(origin);await page.getByRole('navigation',{name:'Primary'}).waitFor();
 const decline=page.getByRole('button',{name:'Decline',exact:true});if(await decline.isVisible())await decline.click();
 await page.locator('.nav-item',{hasText:'Settings'}).click();
 const connect=page.getByRole('button',{name:'Connect wallet',exact:true});if(await connect.isVisible())await connect.click();
 await expect(page.getByRole('button',{name:'Disconnect',exact:true})).toBeVisible();
}
async function enable(page:Page,choice?:'remote'){
 await page.getByRole('button',{name:/^(Turn on|Re-enable)$/}).click();
 if(choice)await page.getByRole('button',{name:'Use synced settings',exact:true}).click();
 await expect(page.getByRole('button',{name:'Turn off',exact:true})).toBeVisible();
}
const stored=(page:Page)=>page.evaluate(address=>JSON.parse(localStorage.getItem(`chat:settingsPrefs:v1:wallet:${address}`)!),address);

test('deployed Chirpy and Chat preserve encrypted deletion, unblock, offline edits and revocation',async({browser},testInfo)=>{
 const contexts:BrowserContext[]=[];let seeded=false;const evidence:Record<string,unknown>={wallet:address,expectedSha:process.env.CHAT_EXPECTED_SHA};
 console.log(JSON.stringify({phase:'start',...evidence}));
 try{
  for(const origin of origins){
   const response=await fetch(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)});expect(response.status).toBe(200);
   const health=await response.json();expect(health.runtime.gitSha).toBe(process.env.CHAT_EXPECTED_SHA);
   const before=await api(origin);expect(before.service).toBe(service);expect(before.blob).toBeNull();expect(before.revision).toBe(0);expect(before.minPayloadVersion).toBe(1);
  }
  const key=await keyFor(),iv=crypto.getRandomValues(new Uint8Array(12));
  const payload={version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[peer]},savedMessages:[{id:'synthetic-continuity-item',body:'Synthetic migration acceptance only',custom:{retained:true}}],updatedAt:10};
  const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(payload)));
  const blob=JSON.stringify({version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address:wallet.address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(encrypted).toString('base64'),updatedAt:10});
  const device=privateKeyToAccount(generatePrivateKey()),issuedAt=Date.now();
  const grant={version:2 as const,service,address,device:device.address.toLowerCase(),issuedAt,expiresAt:issuedAt+600000,epoch:0};
  const authorization={...grant,signature:await wallet.signMessage({message:syncGrantMessage(grant)})};
  const write={action:'write',address,authorization,blob,expectedRevision:0,signature:await device.signMessage({message:syncWriteMessage(grant,0,keccak256(stringToHex(blob)))})};
  seeded=true;await api(origins[0],write);
  const a=await browser.newContext(),b=await browser.newContext();contexts.push(a,b);await inject(a);await inject(b);
  const one=await a.newPage(),two=await b.newPage();await connect(one,origins[0]);await enable(one);
  await connect(two,origins[1]);await enable(two,'remote');
  expect((await stored(one)).syncMinimum).toBe(2);expect((await stored(two)).syncMinimum).toBe(2);
  await b.setOffline(true);
  one.once('dialog',dialog=>dialog.accept());await one.getByRole('button',{name:'Delete saved item',exact:true}).click();
  await one.getByText('Legacy blocked-address preferences',{exact:true}).click();await one.getByRole('button',{name:'Remove old preference',exact:true}).click();
  const remote=async()=>decryptSyncPayloadV2(JSON.parse((await api(origins[1])).blob),key,address);
  await expect.poll(async()=>{const data=await remote();return data.savedMessages['synthetic-continuity-item'].value===null&&data.blocked[peer].value===false;}).toBe(true);
  await two.getByRole('switch',{name:'Read receipts default',exact:true}).click();await expect(two.getByRole('alert')).toContainText('Encrypted sync is paused');
  await b.setOffline(false);await enable(two);
  const shared=await remote();expect(shared.savedMessages['synthetic-continuity-item'].value).toBeNull();expect(shared.blocked[peer].value).toBe(false);expect(shared.readReceiptsDefault.value).toBe(true);
  await one.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(one.getByRole('switch',{name:'Read receipts default',exact:true})).toHaveAttribute('aria-checked','true');
  const beforeRevoke=await stored(one),snapshot=await api(origins[0]),expiresAt=Date.now()+60000;
  await api(origins[1],{...write,expectedRevision:snapshot.revision,signature:await device.signMessage({message:syncWriteMessage(grant,snapshot.revision,keccak256(stringToHex(blob)))})},426);
  expect((await api(origins[0])).blob).toBe(snapshot.blob);
  await api(origins[1],{action:'revoke-all',address,epoch:snapshot.epoch,expiresAt,signature:await wallet.signMessage({message:syncRevokeAllMessage(service,address,snapshot.epoch,expiresAt)})});
  await one.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(one.getByRole('alert')).toContainText('Sync is paused');expect(await stored(one)).toEqual(beforeRevoke);
  for(const origin of origins){const after=await api(origin);expect(after.blob).toBe(snapshot.blob);expect(after.minPayloadVersion).toBe(2);expect(after.epoch).toBe(snapshot.epoch+1);}
  await api(origins[1],{...write,blob:snapshot.blob,expectedRevision:snapshot.revision,signature:await device.signMessage({message:syncWriteMessage(grant,snapshot.revision,keccak256(stringToHex(snapshot.blob)))})},403);
  for(const origin of origins){const response=await fetch(origin+'/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)});expect(response.status).toBe(200);expect((await response.json()).runtime.gitSha).toBe(process.env.CHAT_EXPECTED_SHA);}
  evidence.legacyOverwriteDenied=true;evidence.revokedWriteDenied=true;evidence.continuity=true;evidence.deletionAndUnblock=true;evidence.offlineMerge=true;evidence.revocation=true;
 }finally{
  // Stop browser writes first, then invalidate every test grant, including on assertion failure.
  for(const context of contexts)await context.close();
  testInfo.setTimeout(testInfo.timeout+240000);
  try{
   if(seeded){
    for(let attempt=0;attempt<4;attempt++){
     try{
      const snapshot=await api(origins[0]),expiresAt=Date.now()+60000;
      await api(origins[0],{action:'revoke-all',address,epoch:snapshot.epoch,expiresAt,signature:await wallet.signMessage({message:syncRevokeAllMessage(service,address,snapshot.epoch,expiresAt)})});
      for(const origin of origins)expect((await api(origin)).epoch).toBe(snapshot.epoch+1);
      evidence.allTestGrantsRevoked=true;break;
     }catch(error){
      if(!(error instanceof RateLimitError)||attempt===3)throw error;
      console.log(JSON.stringify({phase:'cleanup-backoff',wallet:address,milliseconds:error.retryAfter}));
      await new Promise(resolve=>setTimeout(resolve,error.retryAfter));
     }
    }
   }
  }finally{console.log(JSON.stringify({phase:'result',...evidence}));}
 }
});
