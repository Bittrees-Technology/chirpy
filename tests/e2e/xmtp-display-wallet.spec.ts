import type { BrowserContext, Page } from '@playwright/test';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { hexToBytes, recoverMessageAddress } from 'viem';
import { displayWalletSignMessage, validDisplayWalletCommand, type DisplayWalletRecord } from '../../packages/core/src/displayWallet';
import { expect, injectSyntheticWallet, test } from './fixtures/wallet';

test.describe('Linked public display identity @xmtp', () => {
  test.use({actionTimeout: 30_000});
  test.describe.configure({timeout: 360_000, retries: 0});
  test('verifies real SDK links, shared choice, delivery, reset and unlink fallback', async ({browser}) => {
    test.skip(process.env.XMTP_E2E !== '1', 'Disposable XMTP-dev identities only.');
    const primaryKey = generatePrivateKey(), linkedKey = generatePrivateKey();
    const primary = privateKeyToAccount(primaryKey), linked = privateKeyToAccount(linkedKey);
    const linkedWallet = linked.address.toLowerCase();
    const owner = await browser.newContext(), recipient = await browser.newContext();
    let linkedDevice: BrowserContext | undefined;
    const ownerWallet = await injectSyntheticWallet(owner, primaryKey), recipientWallet = await injectSyntheticWallet(recipient, generatePrivateKey());
    const choices = new Map<string, DisplayWalletRecord>();
    for (const context of [owner, recipient]) { await displayService(context, choices, linkedWallet); await capture(context); }
    const a = await owner.newPage(), b = await recipient.newPage();
    try {
      await enable(a, ownerWallet); await enable(b, recipientWallet);
      const linkedIdentifier = {identifier: linkedWallet, identifierKind: 0};
      // Never reassign an existing inbox: this account was freshly generated for this test.
      const existing = await sdk(a, 'client.getInboxIdByIdentifier', {identifier: linkedIdentifier});
      expect(existing.ok).toBe(true); expect(existing.result == null).toBe(true);
      const signatureRequestId = crypto.randomUUID();
      const request = await sdk(a, 'client.addAccountSignatureText', {newIdentifier: linkedIdentifier, signatureRequestId});
      expect(request.ok).toBe(true); expect(request.result.signatureText).toBeTruthy();
      const signature = await linked.signMessage({message: request.result.signatureText});
      const added = await sdk(a, 'client.addAccount', {signatureRequestId, signer: {type:'EOA',identifier:linkedIdentifier,signature:[...hexToBytes(signature)]}});
      expect(added).toEqual({ok:true,result:undefined});
      await a.getByRole('button', {name:'Reload display choice',exact:true}).click();
      await expect(a.getByLabel('Display wallet',{exact:true}).locator('option', {hasText:linkedWallet})).toHaveCount(1);
      await publish(a, linkedWallet);
      expect(choices.get(ownerWallet.toLowerCase())?.displayWallet).toBe(linkedWallet);
      await expect(a.getByRole('region',{name:'Public display wallet'})).toContainText('Linked public identity');
      await a.screenshot({path:'test-results/display-wallet-settings-desktop.png',fullPage:true});
      await a.setViewportSize({width:390,height:844});
      expect(await a.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
      await a.screenshot({path:'test-results/display-wallet-settings-mobile.png',fullPage:true});
      await a.setViewportSize({width:1280,height:720});
      console.info('Display-wallet acceptance: real SDK account link and signed public selection passed.');

      await a.locator('.nav-item',{hasText:'Chats'}).click();
      await a.getByRole('button',{name:'+ Chat',exact:true}).click(); await a.getByLabel('Recipient').fill(recipientWallet);
      await a.getByRole('button',{name:'Start chat',exact:true}).click();
      await send(a,'linked identity direct message');
      await b.locator('.nav-item',{hasText:'Chats'}).click(); await b.getByRole('button',{name:'Requests',exact:true}).click();
      await b.locator('.list-item',{hasText:'linked identity direct message'}).click({timeout:120_000});
      await expect(b.locator('.thread-title')).toContainText('Linked public identity');
      await b.getByRole('button',{name:'Accept request',exact:true}).click(); await send(b,'same inbox reply');
      await expect(a.locator('.msg-body',{hasText:'same inbox reply'})).toBeVisible({timeout:120_000});
      await expect(a.locator('.msg-row',{has:a.locator('.msg-body',{hasText:'linked identity direct message'})})).toHaveClass(/mine/);

      await a.locator('.nav-item',{hasText:'Rooms'}).click(); await a.getByRole('button',{name:'+ Room',exact:true}).click();
      await a.getByLabel('Room name').fill('disposable linked display room'); await a.getByRole('button',{name:'Create room',exact:true}).click();
      await expect(a.locator('.thread-title')).toContainText('disposable linked display room',{timeout:120_000});
      await a.locator('.room-members summary').click(); await a.getByLabel('Member wallet',{exact:true}).fill(recipientWallet);
      await a.getByRole('button',{name:'Add member',exact:true}).click(); await expect(a.getByRole('status').filter({hasText:'Member added.'})).toBeVisible({timeout:120_000});
      await send(a,'linked identity group message');
      await b.locator('.nav-item',{hasText:'Rooms'}).click(); await b.getByRole('button',{name:'Requests',exact:true}).click();
      await b.locator('.list-item',{hasText:'linked identity group message'}).click({timeout:120_000}); await b.getByRole('button',{name:'Accept request',exact:true}).click();
      const author = b.locator('.msg-row',{has:b.locator('.msg-body',{hasText:'linked identity group message'})}).locator('.profile-wallet');
      await expect(author).toHaveAttribute('title',linkedWallet); await expect(author).toContainText('Linked public identity');
      await b.locator('.room-members summary').click(); await expect(b.getByRole('list',{name:'Room members'}).getByText(linkedWallet,{exact:true})).toBeVisible();
      await expect(b.getByRole('button',{name:'Add member',exact:true})).toHaveCount(0);
      console.info('Display-wallet acceptance: DM delivery/reply, group author and roster use the display identity without granting ownership.');

      linkedDevice = await browser.newContext(); await injectSyntheticWallet(linkedDevice, linkedKey); await displayService(linkedDevice, choices, linkedWallet); await capture(linkedDevice);
      const c = await linkedDevice.newPage(); await enable(c, linked.address);
      await expect(c.getByLabel('Display wallet',{exact:true})).toHaveValue(linkedWallet);
      await publish(c,'');
      expect(choices.get(linkedWallet)?.inboxId).toBe(choices.get(ownerWallet.toLowerCase())?.inboxId);
      await a.locator('.nav-item',{hasText:'Settings'}).click();
      await b.evaluate(()=>window.dispatchEvent(new Event('chat:display-wallet-changed')));
      await expect(author).toHaveAttribute('title',ownerWallet.toLowerCase(),{timeout:120_000});
      await publish(a,linkedWallet); await b.evaluate(()=>window.dispatchEvent(new Event('chat:display-wallet-changed')));
      await expect(author).toHaveAttribute('title',linkedWallet,{timeout:120_000});
      const removeId = crypto.randomUUID(), removal = await sdk(a,'client.removeAccountSignatureText',{identifier:linkedIdentifier,signatureRequestId:removeId});
      expect(removal.ok).toBe(true); const removeSignature = await primary.signMessage({message:removal.result.signatureText});
      expect(await sdk(a,'client.removeAccount',{signatureRequestId:removeId,signer:{type:'EOA',identifier:{identifier:ownerWallet.toLowerCase(),identifierKind:0},signature:[...hexToBytes(removeSignature)]}})).toEqual({ok:true,result:undefined});
      await a.getByRole('button',{name:'Reload display choice',exact:true}).click(); await expect(a.getByLabel('Display wallet',{exact:true})).toHaveValue('');
      await expect(a.getByLabel('Display wallet',{exact:true}).locator('option',{hasText:linkedWallet})).toHaveCount(0);
      await b.evaluate(()=>window.dispatchEvent(new Event('chat:display-wallet-changed')));
      await expect(author).toHaveAttribute('title',ownerWallet.toLowerCase(),{timeout:120_000});
      await send(b,'delivery after display unlink'); await a.locator('.nav-item',{hasText:'Rooms'}).click();
      await a.locator('.list-item',{hasText:'delivery after display unlink'}).click({timeout:120_000});
      await expect(a.locator('.msg-body',{hasText:'delivery after display unlink'})).toBeVisible();
      console.info('Display-wallet acceptance: explicit reset, republish, real SDK unlink and preserved message delivery passed.');
    } finally {await Promise.all([owner.close(),recipient.close(),linkedDevice?.close()]);}
  });
});
async function enable(page: Page, wallet: string) {
  await page.goto('/'); await page.locator('.nav-item',{hasText:'Settings'}).click(); await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await expect(page.getByRole('textbox',{name:'Address',exact:true})).toHaveValue(wallet);
  await page.getByRole('button',{name:'Enable messaging',exact:true}).click(); await expect(page.getByText('Messaging enabled on this device.')).toBeVisible({timeout:120_000});
  await expect(page.getByRole('button',{name:'Reload display choice',exact:true})).toBeEnabled({timeout:120_000});
}
async function publish(page: Page, wallet: string) {
  await page.getByLabel('Display wallet',{exact:true}).selectOption(wallet);
  await page.getByLabel('Publish this display choice and its inbox association publicly.',{exact:true}).check();
  await page.getByRole('button',{name:'Publish display choice',exact:true}).click();
  await expect(page.getByRole('status').filter({hasText:'Choice saved.'})).toBeVisible({timeout:30_000});
}
async function send(page: Page, body: string) {await page.locator('.composer-input').fill(body); await page.getByRole('button',{name:'Send',exact:true}).click(); await expect(page.locator('.msg-body',{hasText:body})).toBeVisible({timeout:120_000});}
async function capture(context: BrowserContext) {
  await context.addInitScript(()=>{const OriginalWorker=Worker;(window as any).Worker=class extends OriginalWorker {postMessage(...args:any[]) {if(args[0]?.action==='conversations.list')(window as any).__displaySdkWorker=this;return (OriginalWorker.prototype.postMessage as any).apply(this,args);}};});
}
async function sdk(page: Page, action: string, data: any): Promise<any> {
  return page.evaluate(({action,data})=>new Promise(resolve=>{
    if(data.signer?.signature)data.signer.signature=new Uint8Array(data.signer.signature);
    const worker=(window as any).__displaySdkWorker as Worker,id=crypto.randomUUID();
    const timer=setTimeout(()=>{worker.removeEventListener('message',receive);resolve({ok:false,error:'SDK request timed out'});},30000);
    function receive(event:MessageEvent){if(event.data?.id!==id)return;clearTimeout(timer);worker.removeEventListener('message',receive);resolve(event.data.error?{ok:false,error:String(event.data.error.message??event.data.error)}:{ok:true,result:event.data.result});}
    worker.addEventListener('message',receive);worker.postMessage({id,action,data});
  }),{action,data});
}
// This fixture verifies actual wallet signatures but publishes no real public
// profiles. Storage authority/CAS is separately tested against actual Redis.
async function displayService(context: BrowserContext, choices: Map<string, DisplayWalletRecord>, linked: string) {
  await context.route('**/api/profile?kind=display-wallet*',async route=>{
    const req=route.request(),url=new URL(req.url()),service=new URL('/api/profile',url).href+'?kind=display-wallet';
    if(req.method()==='POST') {
      const {command,signature}=req.postDataJSON();
      if(!validDisplayWalletCommand(command,service)||command.network!=='dev'||(await recoverMessageAddress({message:displayWalletSignMessage(command),signature})).toLowerCase()!==command.wallet)return route.fulfill({status:401,json:{}});
      if((choices.get(command.wallet)?.revision??0)!==command.revision)return route.fulfill({status:409,json:{}});
      const choice:DisplayWalletRecord={version:1,wallet:command.wallet,network:'dev',inboxId:command.inboxId,displayWallet:command.displayWallet,revision:command.revision+1,updatedAt:Date.now()};choices.set(command.wallet,choice);
      return route.fulfill({json:{service,status:'saved',choice}});
    }
    return route.fulfill({json:{service,choices:(url.searchParams.get('wallet')??'').split(',').map(wallet=>choices.get(wallet)??{version:1,wallet,network:'dev',inboxId:null,displayWallet:null,revision:0,updatedAt:0})}});
  });
  await context.route('**/api/profile?wallet=*',route=>{const url=new URL(route.request().url());return route.fulfill({json:{service:new URL('/api/profile',url).href,profiles:(url.searchParams.get('wallet')??'').split(',').map(wallet=>({version:1,wallet,revision:1,label:wallet===linked?'Linked public identity':null,updatedAt:1}))}});});
}
