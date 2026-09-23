import {recoverMessageAddress} from 'viem';
import {mailSignMessage} from '../../packages/core/src/mailAuth.js';
import {dismissAnalyticsConsent,test,expect,injectSyntheticWallet} from './fixtures/wallet';
import {generatePrivateKey} from 'viem/accounts';
import {readFile} from 'node:fs/promises';

test('encrypted email request backup restores on a fresh device without sending or reviving retries',async({browser,baseURL},testInfo)=>{
 const privateKey=generatePrivateKey(),a='a'.repeat(32),b='b'.repeat(32),password='Synthetic backup passphrase only';
 const source=await browser.newContext({baseURL,viewport:{width:390,height:844}}),target=await browser.newContext({baseURL,viewport:{width:390,height:844}});
 try {
  const wallet=(await injectSyntheticWallet(source,privateKey)).toLowerCase();await injectSyntheticWallet(target,privateKey);
  let posts=0;
  for(const context of [source,target])await context.route('**/api/mail',route=>{if(route.request().method()==='POST')posts++;return route.fulfill({status:503,json:{enabled:false}});});
  const from=await source.newPage(),to=await target.newPage();
  for(const page of [from,to]){await page.goto('/');await dismissAnalyticsConsent(page);await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();}
  await from.evaluate(({wallet,a,b})=>localStorage.setItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`,JSON.stringify({version:1,active:a,receipts:[{id:a,digest:'f'.repeat(64),createdAt:Date.now()},{id:b,digest:null,createdAt:null}]})),{wallet,a,b});
  await from.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Channels/}).click();await expect(from.getByText('Forwarding is not activated on this service yet.')).toBeVisible();
  await from.getByText('Back up or restore email request IDs',{exact:true}).click();await from.getByLabel('Email recovery passphrase',{exact:true}).fill(password);await from.getByLabel('Confirm recovery passphrase',{exact:true}).fill(password);
  const downloaded=from.waitForEvent('download');await from.getByRole('button',{name:'Download encrypted request IDs'}).click();const download=await downloaded;
  const path=testInfo.outputPath('synthetic-email-request-backup.json');await download.saveAs(path);const raw=await readFile(path,'utf8');expect(raw).not.toContain(wallet);expect(raw).not.toContain(a);
  await expect(from.getByRole('button',{name:'Remove backed-up older IDs'})).toBeDisabled();
  await from.getByLabel('I have saved the encrypted file and its passphrase separately.').check();await from.getByRole('button',{name:'Remove backed-up older IDs'}).click();await expect(from.getByRole('status')).toContainText('IDs removed from this device');
  const readState=(page:typeof from)=>page.evaluate(wallet=>JSON.parse(localStorage.getItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`)!),wallet);
  expect((await readState(from)).receipts.map((item:any)=>item.id)).toEqual([a]);
  await to.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Channels/}).click();await to.getByText('Back up or restore email request IDs',{exact:true}).click();
  await to.getByLabel('Email request recovery file',{exact:false}).setInputFiles(path);await to.getByLabel('Email recovery passphrase',{exact:true}).fill(password+' incorrect');
  await to.getByRole('button',{name:'Unlock and review request IDs'}).click();await expect(to.getByRole('alert')).toContainText('Recovery could not finish');expect(await readState(to)).toBeNull();
  await to.getByLabel('Email recovery passphrase',{exact:true}).fill(password);await to.getByRole('button',{name:'Unlock and review request IDs'}).click();
  await expect(to.getByRole('region',{name:'Review request IDs'})).toContainText(a);expect(await readState(to)).toBeNull();
  await to.getByRole('button',{name:'Restore request IDs',exact:true}).click();await expect(to.getByRole('status')).toContainText('No email was sent');
  expect(await readState(to)).toEqual({version:1,active:a,receipts:[a,b].map(id=>({id,digest:null,createdAt:null}))});expect(posts).toBe(0);
  for(const page of [from,to])expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
  await to.screenshot({path:testInfo.outputPath('email-recovery-mobile.png'),fullPage:true});
 }finally{await source.close().catch(()=>{});await target.close().catch(()=>{});}
});

test('forwarding history shows independently signed receipt details without sending or changing saved IDs',async({page,walletAddress},testInfo)=>{
 await page.setViewportSize({width:390,height:844});const wallet=walletAddress.toLowerCase(),ids=['a'.repeat(32),'b'.repeat(32)];let posts=0;
 await page.route('**/api/mail',async route=>{
  const service=new URL('/api/mail',route.request().url()).href;
  if(route.request().method()==='GET')return route.fulfill({json:{enabled:true,service}});
  const {command,signature}=route.request().postDataJSON();expect(command).toMatchObject({action:'status',wallet,service});expect(ids).toContain(command.id);
  expect((await recoverMessageAddress({message:mailSignMessage(command),signature})).toLowerCase()).toBe(wallet);posts++;
  return route.fulfill({json:{id:command.id,status:command.id===ids[0]?'accepted':'stopped',receipt:{version:1,createdAt:1700000000000,updatedAt:command.id===ids[0]?1700000001000:null,attempts:command.id===ids[0]?2:0,retryUntil:1700082800000},...(command.id===ids[0]?{delivery:{version:1,events:[{type:'delivered',occurredAt:1700000002000},{type:'bounced',occurredAt:1700000003000}]}}:{})}});
 });
 await page.goto('/');await dismissAnalyticsConsent(page);await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await page.evaluate(({wallet,ids})=>localStorage.setItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`,JSON.stringify({version:1,active:ids[0],receipts:ids.map(id=>({id,digest:null,createdAt:null}))})),{wallet,ids});
 const saved=await page.evaluate(wallet=>localStorage.getItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`),wallet);
 await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Channels/}).click();await page.getByText('Forwarding request history',{exact:true}).click();
 const rows=page.locator('.wallet-email-history li');await expect(rows).toHaveCount(2);
 await rows.nth(0).getByRole('button',{name:'Check request status'}).click();await expect(rows.nth(0)).toContainText('does not confirm delivery or reading');await expect(rows.nth(0)).toContainText('Recipient mail server accepted');await expect(rows.nth(0)).toContainText('Recipient mail server rejected');await expect(rows.nth(0)).toContainText('does not prove inbox placement or reading');
 await rows.nth(1).getByRole('button',{name:'Check request status'}).click();await expect(rows.nth(1)).toContainText('Not recorded for this older request');await expect(rows.nth(0)).toContainText('Processing attempts');
 expect(posts).toBe(2);expect(await page.evaluate(wallet=>localStorage.getItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`),wallet)).toBe(saved);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await rows.nth(0).scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('forwarding-history-mobile.png')});
});

test('signed discovery reviews and restores paginated lookup-only IDs on a fresh device',async({page,walletAddress},testInfo)=>{
 await page.setViewportSize({width:390,height:844});const wallet=walletAddress.toLowerCase(),a='a'.repeat(32),b='b'.repeat(32),cursor='f'.repeat(64);let lookups=0;
 await page.route('**/api/mail',async route=>{
  const service=new URL('/api/mail',route.request().url()).href;
  if(route.request().method()==='GET')return route.fulfill({json:{enabled:true,service,historyVersion:1}});
  const {command,signature}=route.request().postDataJSON();expect(command).toMatchObject({action:'history',wallet,service});expect([null,cursor]).toContain(command.cursor);
  expect((await recoverMessageAddress({message:mailSignMessage(command),signature})).toLowerCase()).toBe(wallet);lookups++;
  return route.fulfill({json:{status:'history',id:command.id,service,wallet,cursor:command.cursor,ids:[command.cursor?b:a],nextCursor:command.cursor?null:cursor}});
 });
 await page.goto('/');await dismissAnalyticsConsent(page);await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Channels/}).click();await page.getByText('Find missing forwarding request IDs',{exact:true}).click();
 const readState=()=>page.evaluate(wallet=>JSON.parse(localStorage.getItem(`chat:wallet-email-receipts:v1:${encodeURIComponent(new URL('/api/mail',location.href).href)}:${wallet}`)!),wallet);
 await page.getByRole('button',{name:'Find recent requests',exact:true}).click();const review=page.getByRole('region',{name:'Review found request IDs'});await expect(review).toContainText(a);expect(await readState()).toBeNull();
 await review.getByRole('button',{name:'Save these request IDs'}).click();await expect(page.locator('.wallet-email-discovery [role=status]')).toContainText('Request IDs saved');expect(await readState()).toEqual({version:1,active:a,receipts:[{id:a,digest:null,createdAt:null}]});
 await review.getByRole('button',{name:'Older requests'}).click();await expect(review).toContainText(b);expect((await readState()).receipts).toHaveLength(1);
 await review.getByRole('button',{name:'Save these request IDs'}).click();await expect(page.locator('.wallet-email-discovery [role=status]')).toContainText('Request IDs saved');
 expect(await readState()).toEqual({version:1,active:a,receipts:[a,b].map(id=>({id,digest:null,createdAt:null}))});expect(lookups).toBe(2);
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await review.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('forwarding-discovery-mobile.png')});
});

test('incoming forwarding history uses separate wallet authority and never retries uncertain publication',async({page,walletAddress},testInfo)=>{
 const {INBOUND_HISTORY_SERVICE,inboundHistorySignMessage}=await import('../../packages/core/src/inboundHistory.js');
 await page.setViewportSize({width:390,height:844});const wallet=walletAddress.toLowerCase(),cursor='b'.repeat(64);let requests=0;
 await page.route('**/api/mail/inbound-history',async route=>{
  if(route.request().method()==='GET')return route.fulfill({json:{enabled:true,version:1,service:INBOUND_HISTORY_SERVICE}});
  const {command,signature}=route.request().postDataJSON();expect(command).toMatchObject({action:'history',wallet,service:INBOUND_HISTORY_SERVICE});expect((await recoverMessageAddress({message:inboundHistorySignMessage(command),signature})).toLowerCase()).toBe(wallet);requests++;
  return route.fulfill({json:{status:'history',...command,records:[{id:(command.cursor?'d':'a').repeat(64),status:command.cursor?'published':'uncertain',createdAt:1700000000000,updatedAt:1700000001000,deadline:1700000060000,attempts:1}],nextCursor:command.cursor?null:cursor}});
 });
 await page.goto('/');await dismissAnalyticsConsent(page);await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Channels/}).click();
 await page.getByText('Incoming forwarding history',{exact:true}).click();const history=page.locator('.inbound-email-history');await history.getByRole('button',{name:'Check incoming forwarding'}).click();await expect(history).toContainText('Publication is uncertain');await expect(history).toContainText('Do not resend automatically');await expect(history.getByRole('button')).toHaveCount(2);
 await history.getByRole('button',{name:'Older requests'}).click();await expect(history).toContainText('The bridge recorded a wallet publication');await expect(history).toContainText('does not confirm recipient delivery or reading');expect(requests).toBe(2);await expect(history.getByRole('region',{name:'Incoming forwarding results'})).toBeFocused();expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await history.scrollIntoViewIfNeeded();await page.screenshot({path:testInfo.outputPath('incoming-forwarding-history-mobile.png')});
});
