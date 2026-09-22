import {test,expect,injectSyntheticWallet} from './fixtures/wallet';
import {recoverMessageAddress} from 'viem';
import {profileSignMessage,validProfileCommand} from '../../packages/core/src/publicProfile';

test('publishes an explicitly approved name to another member and withdraws it without changing wallet identity',async({browser,baseURL},testInfo)=>{
 const owner=await browser.newContext({baseURL}),recipient=await browser.newContext({baseURL});
 try{
  const wallet=(await injectSyntheticWallet(owner)).toLowerCase();await injectSyntheticWallet(recipient);
  const records=new Map<string,any>();let writes=0;const signed:any[]=[];
  for(const context of [owner,recipient])await context.route('**/api/profile**',async route=>{
   const req=route.request(),url=new URL(req.url()),service=new URL('/api/profile',url).href;
   const get=(address:string)=>records.get(address)??{version:1,wallet:address,revision:0,label:null,updatedAt:0};
   if(req.method()==='GET')return route.fulfill({json:{service,profiles:url.searchParams.get('wallet')!.split(',').map(get)}});
   const {command,signature}=req.postDataJSON();expect(validProfileCommand(command,service)).toBe(true);
   expect((await recoverMessageAddress({message:profileSignMessage(command),signature})).toLowerCase()).toBe(command.wallet);
   if(get(command.wallet).revision!==command.revision)return route.fulfill({status:409,json:{error:'conflict'}});
   const profile={version:1,wallet:command.wallet,revision:command.revision+1,label:command.label,updatedAt:Date.now()};records.set(command.wallet,profile);writes++;signed.push(command);return route.fulfill({json:{service,status:'saved',profile}});
  });
  const a=await owner.newPage(),b=await recipient.newPage();
  for(const page of [a,b]){await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();await page.locator('.nav-item',{hasText:'Settings'}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();}
  const editor=a.getByRole('region',{name:'Public profile',exact:true});await editor.getByLabel('What to display in Chat').selectOption('name');await editor.getByLabel('Public display name',{exact:true}).fill('Member <not markup> '+ 'x'.repeat(60));
  await expect(editor.getByRole('button',{name:'Sign and publish name'})).toBeDisabled();expect(writes).toBe(0);
  await editor.getByLabel('I want this name and my wallet address to be public.').check();await editor.getByRole('button',{name:'Sign and publish name'}).click();await expect(editor.getByRole('status')).toContainText('Public name saved');expect(writes).toBe(1);
  await b.locator('.nav-item',{hasText:'Chats'}).click();await b.getByRole('button',{name:'+ Chat',exact:true}).click();await b.getByLabel('Recipient',{exact:false}).fill(wallet);await b.getByRole('button',{name:'Start chat',exact:true}).click();
  await expect(b.locator('.thread-title')).toHaveText('Member <not markup> '+ 'x'.repeat(60));await expect(b.locator('.list-item-title').filter({hasText:'Member <not markup> '+ 'x'.repeat(60)})).toContainText(wallet);expect(await b.locator('.thread-title not').count()).toBe(0);
  await b.setViewportSize({width:390,height:844});expect(await b.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await b.screenshot({path:testInfo.outputPath('public-profile-recipient-mobile.png')});
  await a.setViewportSize({width:390,height:844});await editor.screenshot({path:testInfo.outputPath('public-profile-mobile.png')});await editor.getByLabel('What to display in Chat').selectOption('address');await editor.getByLabel('Show my wallet address and withdraw any name I published through Chat.').check();await editor.getByRole('button',{name:'Sign and use wallet address'}).click();await expect(editor.getByRole('status')).toContainText('Chat name withdrawn');
  // A foreground return invalidates the recipient's cached view and fetches the withdrawal.
  await b.evaluate(()=>window.dispatchEvent(new Event('focus')));await expect(b.locator('.thread-title')).not.toHaveText('Member <not markup> '+ 'x'.repeat(60));await expect(b.locator('.thread-title')).toHaveText(wallet.slice(0,6)+'…'+wallet.slice(-4));
  expect(records.get(wallet)).toMatchObject({revision:2,label:null});expect(signed.map(c=>c.wallet)).toEqual([wallet,wallet]);expect(writes).toBe(2);
  expect(await a.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 }finally{await owner.close().catch(()=>{});await recipient.close().catch(()=>{});}
});
