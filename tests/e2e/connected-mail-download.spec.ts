import {test,expect} from './fixtures/wallet';
import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

test('a complete attachment uses one read, shows progress, and saves only verified bytes',async({page,walletAddress},testInfo)=>{
 const wallet=walletAddress.toLowerCase(),id='a'.repeat(64),version='b'.repeat(64),bytes=Buffer.alloc(1048576,37),sha256=createHash('sha256').update(bytes).digest('hex');
 const file={id:'1.2',filename:'fixture.bin',contentType:'application/octet-stream',bytes:bytes.length,downloadable:true};
 const message={id,from:'fixture@bittrees.org',subject:'Download fixture',date:'Today',text:'Synthetic attachment',sourceVersion:version,replyTo:'',threadedReply:false};
 let mode='hold',release:(()=>void)|undefined,reads=0,downloads=0;page.on('download',()=>downloads++);
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/mail/**',async route=>{
  if(new URL(route.request().url()).pathname.endsWith('/status'))return route.fulfill({json:{enabled:true,wallet,connection:{mailbox:'fixture@bittrees.org',scopes:['read'],expiresAt:null}}});
  const request=route.request().postDataJSON();
  if(request.action==='folders')return route.fulfill({json:{folders:['INBOX']}});
  if(request.action==='messages')return route.fulfill({json:{messages:[{id,from:message.from,subject:message.subject,date:message.date}],nextCursor:null}});
  if(request.action==='message')return route.fulfill({json:{message}});
  if(request.action==='attachments')return route.fulfill({json:{id,sourceVersion:version,chunkBytes:12288,maxAttachmentBytes:1048576,transferVersion:2,attachments:[file]}});
  expect(request.action).toBe('attachmentFile');expect(request.input).toEqual({folder:'INBOX',id,version,part:'1.2',transferVersion:2});reads++;
  if(mode==='hold')await new Promise<void>(r=>release=r);
  await route.fulfill({json:{id,sourceVersion:version,transfer:'complete',maxAttachmentBytes:1048576,transferVersion:2,attachment:file,data:bytes.toString('base64'),sha256:mode==='bad'?'c'.repeat(64):sha256}}).catch(()=>{});
 });
 await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Email/}).click();
 await page.getByRole('button',{name:/Download fixture/}).click();await page.getByRole('button',{name:'Show attachments',exact:true}).click();await page.getByRole('button',{name:'Download',exact:true}).click();
 await expect(page.getByRole('progressbar',{name:'Attachment download progress'})).toBeVisible();await expect(page.getByRole('status')).toContainText('Preparing fixture.bin (1048576 bytes)');await expect.poll(()=>typeof release).toBe('function');
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('email-download-progress-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Cancel',exact:true}).click();release!();await expect(page.getByRole('progressbar')).toHaveCount(0);expect(downloads).toBe(0);
 mode='bad';await page.getByRole('button',{name:'Download',exact:true}).click();await expect(page.getByRole('alert')).toBeVisible();expect(downloads).toBe(0);
 mode='valid';const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download',exact:true}).click();const download=await pending;const path=testInfo.outputPath('verified-fixture.bin');await download.saveAs(path);expect(await readFile(path)).toEqual(bytes);expect(reads).toBe(3);expect(downloads).toBe(1);await expect(page.getByRole('progressbar')).toHaveCount(0);
});
