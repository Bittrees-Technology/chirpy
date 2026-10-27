import {test,expect} from '@playwright/test';
import {injectSyntheticWallet,dismissAnalyticsConsent} from './fixtures/wallet';
test('sections require explicit activation, persist, and stop Mail when disabled',async({page})=>{
 await injectSyntheticWallet(page,undefined,false);
 let mailRequests=0,forumRequests=0;
 await page.route('**/api/mail/**',route=>{mailRequests++;return route.fulfill({json:{enabled:false}});});
 await page.route('https://gov.bittrees.org/api/forum-feed',route=>{forumRequests++;return route.fulfill({json:{items:[]}});});
 await page.goto('/?mail=connected');await dismissAnalyticsConsent(page);
 await expect(page.getByRole('heading',{name:'Optional sections'})).toBeVisible();
 const nav=page.locator('.sidebar .nav');
 for(const name of ['Rooms','Email','Channels','Forum']) await expect(nav.getByRole('button',{name:new RegExp(name)})).toHaveCount(0);
 expect(mailRequests).toBe(0);expect(forumRequests).toBe(0);
 await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 for(const name of ['Rooms','Email','Channels','Forum']) {
  await page.getByRole('switch',{name,exact:true}).click();
  await expect(nav.getByRole('button',{name:new RegExp(name)})).toBeVisible();
 }
 await page.reload();
 for(const name of ['Rooms','Email','Channels','Forum']) await expect(nav.getByRole('button',{name:new RegExp(name)})).toBeVisible();
 await nav.getByRole('button',{name:/Settings/}).click();
 for(const name of ['Rooms','Email','Channels','Forum']) await page.getByRole('switch',{name,exact:true}).click();
 await expect(page.locator('.mailbox')).toHaveCount(0);
 await page.reload();
 for(const name of ['Rooms','Email','Channels','Forum']) await expect(nav.getByRole('button',{name:new RegExp(name)})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});
 for(const name of ['Rooms','Email','Channels','Forum']) await expect(page.locator('.mobile-nav').getByRole('button',{name:new RegExp(name)})).toHaveCount(0);
 expect(forumRequests).toBe(0);
});

test('choices stay with their profile and another tab can disable an open section',async({page,context})=>{
 const wallet=await injectSyntheticWallet(page,undefined,false);
 await page.goto('/');await dismissAnalyticsConsent(page);
 const nav=page.locator('.sidebar .nav');
 await nav.getByRole('button',{name:/Settings/}).click();
 await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await page.getByRole('switch',{name:'Channels',exact:true}).click();
 await nav.getByRole('button',{name:/Channels/}).click();
 const other=await context.newPage();await other.goto('/about');
 await other.evaluate(wallet=>localStorage.setItem(`chat:sections:v1:wallet:${wallet.toLowerCase()}`,JSON.stringify({routes:false})),wallet);
 await expect(page.getByRole('heading',{name:'Optional sections'})).toBeVisible();
 await expect(nav.getByRole('button',{name:/Channels/})).toHaveCount(0);
 await page.getByRole('switch',{name:'Rooms',exact:true}).click();
 await page.getByRole('button',{name:'Disconnect',exact:true}).click();
 await expect(page.getByRole('switch',{name:'Rooms',exact:true})).toHaveAttribute('aria-checked','false');
 await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await expect(page.getByRole('switch',{name:'Rooms',exact:true})).toHaveAttribute('aria-checked','true');
});

test('invalid section storage fails closed and preserves the original record',async({page})=>{
 const owner='0x'+'1'.repeat(40),key=`chat:sections:v1:stub:${owner}`,raw='{"mail":"true"}';
 await page.addInitScript(({owner,key,raw})=>{
  localStorage.setItem('chat:identity:v1',JSON.stringify({address:owner,handle:'you'}));localStorage.setItem(key,raw);
 },{owner,key,raw});
 await page.goto('/?forum=governance');await dismissAnalyticsConsent(page);
 await expect(page.getByText('Section choices could not be saved or read.',{exact:false})).toBeVisible();
 await expect(page.getByRole('switch',{name:'Email',exact:true})).toBeDisabled();
 await expect(page.locator('.sidebar .nav').getByRole('button',{name:/Email|Forum|Rooms|Channels/})).toHaveCount(0);
 expect(await page.evaluate(key=>localStorage.getItem(key),key)).toBe(raw);
});
