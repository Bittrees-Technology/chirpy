import {test,expect,dismissAnalyticsConsent} from './fixtures/wallet';
import type {Page} from '@playwright/test';
const id='a'.repeat(64),second='c'.repeat(64),version='b'.repeat(64);
const activeUrl='https://mail-content.invalid/track';
const hostile=`<h2>Formatted fixture</h2><p>Hello <strong>member</strong></p><table><tr><td>Preserved cell</td></tr></table><script>parent.__mailExecuted=true</script><img src="${activeUrl}"><link rel="stylesheet" href="${activeUrl}"><style>body{background:url(${activeUrl})}</style><iframe src="${activeUrl}"></iframe><form action="${activeUrl}"><input name="password"><button>Submit</button></form><a href="${activeUrl}" target="_top">Link text</a><p id="location" name="cookie" onclick="parent.__mailExecuted=true" style="background:url(${activeUrl})">Safe text</p><svg onload="parent.__mailExecuted=true"><image href="${activeUrl}"/></svg>`;
async function openMessage(page:Page){
 await page.goto('/');await dismissAnalyticsConsent(page);
 const nav=page.getByRole('navigation',{name:'Primary'});await nav.getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await nav.getByRole('button',{name:/Email/}).click();
 await page.locator('.mailbox-list').getByRole('button',{name:/First fixture/}).click();await expect(page.locator('.mailbox-body')).toHaveText('Plain first fixture');
}
async function fixture(page:Page,wallet:string){
 let release:(()=>void)|undefined,started=false,hold=false,external=0,htmlReads=0;
 let finished:()=>void=()=>{};const responseFinished=new Promise<void>(resolve=>finished=resolve);
 let output={id,sourceVersion:version,html:hostile,bodyAvailable:true,truncated:false};
 const summaries=[{id,from:'fixture@bittrees.org',subject:'First fixture',date:'Today'},{id:second,from:'fixture@bittrees.org',subject:'Second fixture',date:'Today'}];
 await page.route('https://mail-content.invalid/**',route=>{external++;return route.fulfill({body:''});});
 await page.route('**/api/mail/**',async route=>{
  if(new URL(route.request().url()).pathname.endsWith('/status'))return route.fulfill({json:{enabled:true,wallet:wallet.toLowerCase(),connection:{mailbox:'fixture@bittrees.org',scopes:['read'],expiresAt:null}}});
  const {action,input}=route.request().postDataJSON();
  if(action==='folders')return route.fulfill({json:{folders:['INBOX']}});
  if(action==='messages')return route.fulfill({json:{messages:summaries,nextCursor:null}});
  if(action==='message'){const summary=summaries.find(m=>m.id===input.id)!;return route.fulfill({json:{message:{...summary,text:summary.id===id?'Plain first fixture':'Plain second fixture',sourceVersion:version,replyTo:summary.from,threadedReply:true}}});}
  if(action==='html'){
   htmlReads++;expect(input).toEqual({folder:'INBOX',id,version,transferVersion:2});started=true;
   if(hold)await new Promise<void>(resolve=>release=resolve);
   try { await route.fulfill({json:output}); } catch { /* The browser may have cancelled the request. */ } finally { finished(); }
   return;
  }
  return route.fulfill({status:400,json:{error:'Unexpected fixture action'}});
 });
 return {responseFinished,get reads(){return htmlReads;},get external(){return external;},get started(){return started;},release:()=>release?.(),delay:()=>{hold=true;},set:(value:Partial<typeof output>)=>{output={...output,...value};}};
}

test('formatted email renders basic content in an opaque sandbox without active content or external requests',async({page,walletAddress},testInfo)=>{
 const source=await fixture(page,walletAddress);await openMessage(page);expect(source.reads).toBe(0);
 await page.getByRole('button',{name:'View formatting',exact:true}).click();
 const preview=page.getByTitle('Formatted email preview',{exact:true}),body=preview.contentFrame().locator('body');
 await expect(page.getByText('This is a plain-text preview.',{exact:false})).toHaveCount(0);
 await expect(body.locator('strong')).toHaveText('member');await expect(body.locator('strong')).toBeVisible();await expect(body.locator('td')).toHaveText('Preserved cell');
 await expect(preview).toHaveAttribute('sandbox','');await expect(preview).toHaveAttribute('referrerpolicy','no-referrer');
 await expect(body.locator('script,style,img,iframe,form,input,button,a,link,meta,base,svg')).toHaveCount(0);
 expect(await body.evaluate(el=>[...el.querySelectorAll('*')].flatMap(node=>[...node.attributes].map(a=>a.name)))).toEqual([]);
 expect(await body.evaluate(()=>{try{void parent.document.body;return false;}catch{return true;}})).toBe(true);
 expect(await page.evaluate(()=>(window as any).__mailExecuted)).toBeUndefined();expect(source.external).toBe(0);
 expect(await preview.contentFrame().locator('meta[http-equiv]').getAttribute('content')).toContain("default-src 'none'");
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await preview.scrollIntoViewIfNeeded();await expect(body.locator('strong')).toBeVisible();await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));await page.screenshot({path:testInfo.outputPath('formatted-email-mobile.png')});
 await page.getByRole('button',{name:'Plain text',exact:true}).click();await expect(preview).toHaveCount(0);await expect(page.locator('.mailbox-body')).toHaveText('Plain first fixture');await expect(page.getByText('This is a plain-text preview.',{exact:false})).toBeVisible();
 expect(source.reads).toBe(1);expect(source.external).toBe(0);
});

test('formatted email discloses shortened and missing source bodies without replacing plain text silently',async({page,walletAddress})=>{
 const source=await fixture(page,walletAddress);await openMessage(page);source.set({html:'<p>Shortened fixture</p>',truncated:true});
 await page.getByRole('button',{name:'View formatting',exact:true}).click();await expect(page.getByText('This preview has been shortened.',{exact:false})).toBeVisible();
 await expect(page.getByTitle('Formatted email preview').contentFrame().locator('body')).toHaveText('Shortened fixture');
 await page.getByRole('button',{name:'Plain text',exact:true}).click();source.set({html:'',truncated:false,bodyAvailable:false});
 await page.getByRole('button',{name:'View formatting',exact:true}).click();await expect(page.getByRole('status')).toHaveText('This email has no formatted body.');await expect(page.getByTitle('Formatted email preview')).toHaveCount(0);await expect(page.locator('.mailbox-body')).toHaveText('Plain first fixture');
});

for(const fault of ['wrong message','wrong version','oversized'] as const)test(`formatted email refuses ${fault} data and preserves the plain message`,async({page,walletAddress})=>{
 const source=await fixture(page,walletAddress);await openMessage(page);
 source.set(fault==='wrong message'?{id:second}:fault==='wrong version'?{sourceVersion:'d'.repeat(64)}:{html:'😀'.repeat(4001)});
 await page.getByRole('button',{name:'View formatting',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();await expect(page.getByTitle('Formatted email preview')).toHaveCount(0);await expect(page.locator('.mailbox-body')).toHaveText('Plain first fixture');expect(source.external).toBe(0);
});

for(const interruption of ['cancel and select another message','wallet change'] as const)test(`late formatted email cannot survive ${interruption}`,async({page,walletAddress})=>{
 const source=await fixture(page,walletAddress);await openMessage(page);source.delay();await page.getByRole('button',{name:'View formatting',exact:true}).click();await expect.poll(()=>source.started).toBe(true);
 if(interruption==='cancel and select another message'){
  await page.getByRole('button',{name:'Cancel',exact:true}).click();await page.locator('.mailbox-list').getByRole('button',{name:/Second fixture/}).click();await expect(page.locator('.mailbox-body')).toHaveText('Plain second fixture');
 }else await page.evaluate(()=>{const provider=(window as any).ethereum,prior=provider.request;provider.request=(args:any)=>args.method==='eth_accounts'?Promise.resolve(['0x'+'2'.repeat(40)]):prior(args);});
 source.release();await source.responseFinished;
 // Let a delivered callback and its React render settle before checking that
 // cancelled data cannot replace the newly selected message.
 await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
 if(interruption==='wallet change'){await expect(page.getByRole('alert')).toBeVisible();await expect(page.locator('.mailbox-body')).toHaveCount(0);}
 else await expect(page.locator('.mailbox-body')).toHaveText('Plain second fixture');
 await expect(page.getByTitle('Formatted email preview')).toHaveCount(0);expect(source.external).toBe(0);
});
