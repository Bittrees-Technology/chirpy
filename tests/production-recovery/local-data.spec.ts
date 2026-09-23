import {test,expect,type BrowserContext,type Page,type Download} from '@playwright/test';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {hexToString} from 'viem';
import {createHash} from 'node:crypto';
import {decryptRecoveryArchive} from '../../apps/web/src/recoveryArchive';
import {recoverySources} from './sources';
for (const sourceApp of recoverySources()) {
test.describe(sourceApp.label, () => {
const sourceOrigin=sourceApp.origin,chat='https://chat.bittrees.org';
const account=privateKeyToAccount(generatePrivateKey()),owner=account.address.toLowerCase(),peer='0x'+'2'.repeat(40);
const password='synthetic deployed recovery passphrase';
const contacts=[{address:peer,label:`Synthetic ${sourceApp.label} contact`}],notes=[{id:`synthetic-${sourceApp.id}-note`,text:`Synthetic ${sourceApp.label} local note`,sentAtMs:123}];
const original={
 [`bittrees.contacts.${owner}`]:JSON.stringify(contacts),[`bittrees.dm.saved.${owner}`]:JSON.stringify(notes),
 'bittrees.dm.settings':JSON.stringify({readReceipts:true}),'bittrees.dm.blocked':JSON.stringify([peer]),
 'bittrees.dm.prefs':JSON.stringify({'synthetic-dm':{readReceipts:true},'room:safe-gov.bittrees.eth':{pinned:true,lastReadAt:123}}),
 'synthetic-secret-canary':'never export unrelated storage',
};
async function versions(){
 const health=await fetch(chat+'/api/health',{redirect:'error',signal:AbortSignal.timeout(15000)});expect(health.status).toBe(200);expect((await health.json()).runtime.gitSha).toBe(process.env.CHAT_EXPECTED_SHA);
 const response=await fetch(sourceOrigin+sourceApp.path,{redirect:'error',signal:AbortSignal.timeout(15000)});expect(response.status).toBe(200);
 const html=await response.text(),path=/<script\b(?=[^>]*type="module")[^>]*src="([^"]+)"/.exec(html)?.[1];expect(path).toBeTruthy();
 const url=new URL(path!,sourceOrigin);expect(url.origin).toBe(sourceOrigin);const asset=await fetch(url,{redirect:'error',signal:AbortSignal.timeout(15000)});expect(asset.status).toBe(200);
 expect(createHash('sha256').update(Buffer.from(await asset.arrayBuffer())).digest('hex')).toBe(sourceApp.assetHash);
}
async function inject(context:BrowserContext,origin:string,signatures:string[],writes:string[]){
 await context.route('**/*',route=>{
  const request=route.request(),url=new URL(request.url());
  if([sourceOrigin,chat,'https://chirpy.bittrees.org'].includes(url.origin)&&!['GET','HEAD'].includes(request.method()))writes.push(url.pathname);
  return url.origin===origin&&['GET','HEAD'].includes(request.method())?route.continue():route.abort('blockedbyclient');
 });
 await context.exposeFunction('__recoverySign',async(params:string[])=>{
  expect(params[1]?.toLowerCase()).toBe(owner);const message=hexToString(params[0] as `0x${string}`);let expires:number;
  if(origin===sourceOrigin){
   const match=/^Chat local data export\nOrigin: (.+)\nWallet: (.+)\nChain: 1\nNonce: [a-f0-9-]{36}\nExpires: (\d+)\nThis proof authorizes only this local encrypted export\. It grants no messaging, sync or spending authority\.$/.exec(message);
   if(!match)throw Error('Synthetic wallet refused unrelated signature.');expect(match[1]).toBe(origin);expect(match[2]).toBe(owner);expires=Number(match[3]);
  }else{
   const match=/^Chat local data (export|restore)\nWallet: (.+)\nOrigin: (.+)\nChain: 1\nNonce: 0x[a-f0-9]{32}\nExpires: (.+)\nProve control for one local data (export|restore)\. This does not authorize messages, transactions, or account access\.$/.exec(message);
   if(!match)throw Error('Synthetic wallet refused unrelated signature.');expect(match[2]).toBe(owner);expect(match[3]).toBe(origin);expect(match[5]).toBe(match[1]);expires=Date.parse(match[4]);
  }
  expect(expires).toBeGreaterThan(Date.now());expect(expires).toBeLessThanOrEqual(Date.now()+120000);signatures.push(message);return account.signMessage({message});
 });
 await context.addInitScript(({address,origin,original,sourceOrigin})=>{
  if(location.origin===origin&&origin===sourceOrigin)for(const [key,value]of Object.entries(original))localStorage.setItem(key,value);
  let connected=false;
  (window as any).ethereum={isMetaMask:true,on(){},removeListener(){},async request({method,params}:any){
   if(method==='eth_accounts')return connected?[address]:[];if(method==='eth_requestAccounts'){connected=true;return [address];}if(method==='eth_chainId')return '0x1';
   if(method==='personal_sign')return (window as any).__recoverySign(params);throw Error('Synthetic wallet refuses '+method);
  }};
  const announce=()=>window.dispatchEvent(new CustomEvent('eip6963:announceProvider',{detail:{
   info:{uuid:'e8fedc6a-9159-4b34-8591-68a4b95bc728',name:'MetaMask',icon:'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg"/>',rdns:'io.metamask'},provider:(window as any).ethereum,
  }}));window.addEventListener('eip6963:requestProvider',announce);announce();
 },{address:account.address,origin,original,sourceOrigin});
}
async function downloaded(download:Download){const stream=await download.createReadStream(),chunks:Buffer[]=[];for await(const chunk of stream)chunks.push(Buffer.from(chunk));return Buffer.concat(chunks).toString('utf8');}
async function records(page:Page){return page.evaluate(owner=>new Promise<any>((resolve,reject)=>{
 const request=indexedDB.open('chat-local-data-v1',1);request.onerror=()=>reject(request.error);request.onsuccess=()=>{
  const db=request.result,tx=db.transaction('wallets'),store=tx.objectStore('wallets'),data=store.get(owner),journal=store.get('restore:'+owner);
  tx.oncomplete=()=>{db.close();resolve({data:data.result,journal:journal.result,prefs:JSON.parse(localStorage.getItem(`chat:settingsPrefs:v1:wallet:${owner}`)||'{}')});};tx.onabort=()=>reject(tx.error);
 };
}),owner);}
async function upload(page:Page,raw:string,pass=password){
 await page.getByLabel('Encrypted recovery file',{exact:true}).setInputFiles({name:`${sourceApp.id}-recovery.json`,mimeType:'application/json',buffer:Buffer.from(raw)});
 await page.getByLabel('Restore passphrase',{exact:true}).fill(pass);await page.getByRole('button',{name:'Unlock and review file',exact:true}).click();
}

test(`deployed ${sourceApp.label} export restores locally in Chat with separate preference consent, backup and undo`,async({browser},info)=>{
 const contexts:BrowserContext[]=[],signatures:string[]=[],writes:string[]=[];await versions();
 try{
  const source=await browser.newContext(),target=await browser.newContext();contexts.push(source,target);await inject(source,sourceOrigin,signatures,writes);await inject(target,chat,signatures,writes);
  const one=await source.newPage();await one.goto(sourceOrigin+sourceApp.path);await one.getByRole('button',{name:'Connect Wallet',exact:true}).first().click();await one.getByRole('button',{name:'MetaMask',exact:true}).click();
  if(sourceApp.id==='governance') {
   await expect(one.getByRole('button',{name:'Enable direct messages',exact:true})).toBeVisible();await one.locator('summary').filter({hasText:'Export local data to Chat'}).click();
  } else await expect(one.getByRole('heading',{name:'Export local data to Chat'})).toBeVisible();
  const panel=one.getByRole('region',{name:'Export local data to Chat'});await panel.getByRole('checkbox').check();await panel.getByRole('button',{name:'Review export'}).click();
  await panel.getByLabel('Recovery passphrase (at least 12 characters)').fill(password);await panel.getByLabel('Confirm passphrase',{exact:true}).fill(password);
  const waiting=one.waitForEvent('download');await panel.getByRole('button',{name:'Verify wallet and download'}).click();const raw=await downloaded(await waiting);
  const decoded=await decryptRecoveryArchive(raw,password,owner);expect(decoded.source).toBe(sourceApp.id);expect(decoded.contacts).toEqual(contacts);expect(decoded.notes).toEqual(notes);expect(JSON.stringify(decoded)).not.toContain(original['synthetic-secret-canary']);
  expect(decoded.preferences).toEqual({blocked:[peer],readReceiptsDefault:true,readReceiptOverrides:{'xmtp:production:synthetic-dm':true}});
  const two=await target.newPage();await two.goto(chat);await two.getByRole('navigation',{name:'Primary'}).waitFor();const decline=two.getByRole('button',{name:'Decline',exact:true});if(await decline.isVisible())await decline.click();
  await two.locator('.nav-item',{hasText:'Settings'}).click();await two.getByRole('button',{name:'Connect wallet',exact:true}).click();await expect(two.getByRole('button',{name:'Disconnect',exact:true})).toBeVisible();
  await expect(two.getByLabel('Encrypted recovery file',{exact:true})).toBeEnabled();
  const before=await records(two);await upload(two,raw,'incorrect synthetic passphrase');await expect(two.getByRole('alert').filter({hasText:'Recovery could not be completed'})).toBeVisible();expect(await records(two)).toEqual(before);
  await upload(two,raw);await expect(two.getByRole('heading',{name:'Review proposed changes'})).toBeVisible();
  await expect(two.getByRole('checkbox',{name:/Apply receipt preferences/})).not.toBeChecked();await expect(two.getByRole('checkbox',{name:/Add legacy blocked/})).not.toBeChecked();
  await two.setViewportSize({width:390,height:844});await two.getByRole('heading',{name:'Review proposed changes'}).scrollIntoViewIfNeeded();expect(await two.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await two.screenshot({path:info.outputPath(`live-${sourceApp.id}-restore-mobile.png`)});
  await two.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await expect(two.getByRole('status').filter({hasText:'Reviewed changes saved.'})).toBeVisible();
  let after=await records(two);expect(after.data.contacts).toEqual(contacts);expect(after.data.notes).toEqual(notes);expect(after.prefs).toMatchObject({readReceiptsDefault:false,blocked:[],syncAcrossDevices:false});expect(after.journal.phase).toBe('applied');
  await two.getByText('Save an encrypted copy of the pre-restore backup',{exact:true}).click();await two.getByLabel('Backup passphrase',{exact:true}).fill(password);await two.getByLabel('Confirm backup passphrase',{exact:true}).fill(password);
  const backupWaiting=two.waitForEvent('download');await two.getByRole('button',{name:'Download encrypted pre-restore backup'}).click();const backup=await decryptRecoveryArchive(await downloaded(await backupWaiting),password,owner);expect(backup.contacts).toEqual([]);expect(backup.notes).toEqual([]);
  two.once('dialog',dialog=>dialog.accept());await two.getByRole('button',{name:'Undo restore',exact:true}).click();await expect(two.getByRole('status').filter({hasText:'Restore undone.'})).toBeVisible();after=await records(two);expect(after.data.contacts).toEqual([]);expect(after.data.notes).toEqual([]);
  two.once('dialog',dialog=>dialog.accept());await two.getByRole('button',{name:'Discard retained backup',exact:true}).click();await upload(two,raw);await two.getByRole('checkbox',{name:/Apply receipt preferences/}).check();await two.getByRole('checkbox',{name:/Add legacy blocked/}).check();
  await two.getByRole('button',{name:'Apply reviewed changes',exact:true}).click();await expect(two.getByRole('status').filter({hasText:'Reviewed changes saved.'})).toBeVisible();after=await records(two);expect(after.prefs).toMatchObject({...decoded.preferences,syncAcrossDevices:false});
  expect(await one.evaluate(keys=>Object.fromEntries(keys.map(key=>[key,localStorage.getItem(key)])),Object.keys(original))).toEqual(original);
  expect(writes).toEqual([]);expect(new Set(signatures).size).toBe(signatures.length);await versions();
  console.log(JSON.stringify({wallet:owner,chatSha:process.env.CHAT_EXPECTED_SHA,source:sourceApp.id,sourceAssetSha:sourceApp.assetHash,deployedExportRestore:true,separateConsent:true,wrongPasswordRejected:true,backupAndUndo:true,sourcePreserved:true,applicationNetworkWrites:0}));
 }finally{for(const context of contexts)await context.close();}
});

});
}
