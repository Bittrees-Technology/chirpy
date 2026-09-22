import {test,expect,injectSyntheticWallet} from './fixtures/wallet';
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
  for(const page of [from,to]){await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();}
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
