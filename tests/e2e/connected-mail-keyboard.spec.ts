import {test,expect} from './fixtures/wallet';

for (const view of ['messages','conversations'] as const) {
 test(`email ${view} support keyboard reading and composing without delayed focus theft`,async({page,walletAddress})=>{
  const wallet=walletAddress.toLowerCase(),id='a'.repeat(64),version='b'.repeat(64),threadId='c'.repeat(64);
  const summary={id,from:'fixture@bittrees.org',subject:'Keyboard fixture',date:'Today'};
  let hold=false,release:(()=>void)|undefined,listReads=0;
  await page.clock.install();
  await page.route('**/api/mail/**',async route=>{
   if(new URL(route.request().url()).pathname.endsWith('/status'))return route.fulfill({json:{enabled:true,wallet,connection:{mailbox:'fixture@bittrees.org',scopes:['read','send'],expiresAt:null}}});
   const {action}=route.request().postDataJSON();
   if(action==='folders')return route.fulfill({json:{folders:['INBOX','Sent']}});
   if(action==='messages'||action==='threads')listReads++;
   if(action==='messages')return route.fulfill({json:{messages:[summary],nextCursor:null}});
   if(action==='threads')return route.fulfill({json:{threads:[{id:threadId,version,count:1,latest:{...summary,folder:'INBOX'}}],nextCursor:null}});
   if(hold && action===(view==='conversations'?'thread':'message'))await new Promise<void>(r=>release=r);
   if(action==='thread')return route.fulfill({json:{id:threadId,version,count:1,messages:[{...summary,folder:'INBOX'}],nextCursor:null}}).catch(()=>{});
   if(action==='message')return route.fulfill({json:{message:{...summary,text:'Synthetic keyboard fixture.',sourceVersion:version,replyTo:summary.from,threadedReply:true}}}).catch(()=>{});
   return route.fulfill({status:400,json:{error:'Unexpected fixture action'}});
  });
  await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();
  const navigation=page.getByRole('navigation',{name:'Primary'});
  await navigation.getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await navigation.getByRole('button',{name:/Email/}).click();
  const newEmail=page.getByRole('button',{name:'New email',exact:true});
  await expect(newEmail).toBeEnabled();await newEmail.focus();await page.keyboard.press('Enter');
  await expect(page.getByLabel('To',{exact:true})).toBeFocused();
  await page.getByRole('button',{name:'Refresh',exact:true}).click();
  await page.getByRole('combobox',{name:'Email view',exact:true}).selectOption(view);
  const row=page.locator('.mailbox-list').getByRole('button',{name:/Keyboard fixture/});
  await expect(row).toBeEnabled();await row.focus();await page.keyboard.press('Enter');
  const heading=page.getByRole('heading',{name:'Keyboard fixture',exact:true});
  await expect(heading).toBeFocused();
  await expect(row).toHaveAttribute('aria-current','true');
  if(view==='conversations')await expect(page.locator('.mailbox-conversation-members button')).toHaveAttribute('aria-current','true');
  await page.getByRole('button',{name:'Reply',exact:true}).focus();await page.keyboard.press('Enter');
  await expect(page.getByLabel('Message',{exact:true})).toBeFocused();await expect(page.getByLabel('To',{exact:true})).toHaveValue(summary.from);
  await expect(row).not.toHaveAttribute('aria-current','true');
  // A slow source response must not move focus back after the reader chooses another control.
  hold=true;await expect(row).toBeEnabled();await row.focus();await page.keyboard.press('Enter');await expect.poll(()=>typeof release).toBe('function');
  const chats=navigation.getByRole('button',{name:/Chats/});await chats.focus();release!();
  await expect(heading).toBeVisible();await expect(chats).toBeFocused();
  // Passive inbox polling must leave keyboard focus and the selected message alone.
  const previousReads=listReads;await page.clock.fastForward(45000);await expect.poll(()=>listReads).toBeGreaterThan(previousReads);await expect(row).toBeEnabled();await expect(chats).toBeFocused();
  // Cancellation invalidates the delayed read and cannot restore its focus or content.
  release=undefined;await expect(row).toBeEnabled();await row.focus();await page.keyboard.press('Enter');await expect.poll(()=>typeof release).toBe('function');
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await chats.focus();release!();
  await expect(heading).toHaveCount(0);await expect(chats).toBeFocused();
 });
}
