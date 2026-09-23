import {test,expect} from './fixtures/wallet';

test('connected email sends the selected binary file once and guards uncertain delivery',async({page,walletAddress},testInfo)=>{
 const wallet=walletAddress.toLowerCase();const sends:any[]=[];let uncertain=false;
 await page.setViewportSize({width:390,height:844});
 await page.route('**/api/mail/**',async route=>{
  const action=new URL(route.request().url()).pathname.split('/').at(-1);
  if(action==='status')return route.fulfill({json:{enabled:true,wallet,connection:{mailbox:'fixture@bittrees.org',scopes:['read','send'],expiresAt:null}}});
  const body=route.request().postDataJSON();
  if(body.action==='folders')return route.fulfill({json:{folders:['INBOX','Sent']}});
  if(body.action==='messages')return route.fulfill({json:{messages:[],nextCursor:null}});
  if(body.action==='send'){sends.push(body.input);return route.fulfill({status:uncertain?503:200,json:uncertain?{error:'Uncertain'}:{ok:true}});}
  return route.fulfill({status:400,json:{error:'Unexpected fixture action'}});
 });
 await page.goto('/');await page.getByRole('button',{name:'Decline',exact:true}).click();
 await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Settings/}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Email/}).click();await page.getByRole('button',{name:'New email',exact:true}).click();
 await page.getByLabel('To',{exact:true}).fill('fixture@bittrees.org');await page.getByLabel('Subject',{exact:true}).fill('Synthetic files');await page.getByLabel('Message',{exact:true}).fill('Synthetic attachment acceptance.');
 const bytes=Buffer.from([0,1,127,128,255]);
 await page.getByLabel('Attach files',{exact:true}).setInputFiles({name:'fixture.bin',mimeType:'application/octet-stream',buffer:bytes});
 await expect(page.getByText('fixture.bin · 5 B',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Remove fixture.bin',exact:true}).click();expect(sends).toHaveLength(0);
 await page.getByLabel('Attach files',{exact:true}).setInputFiles({name:'fixture.bin',mimeType:'application/octet-stream',buffer:bytes});
 await expect(page.getByText('fixture.bin · 5 B',{exact:true})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);await page.screenshot({path:testInfo.outputPath('email-attachments-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Send email',exact:true}).click();await expect(page.getByRole('status')).toContainText('Email sent');
 expect(sends).toHaveLength(1);expect(sends[0].attachments).toEqual([{filename:'fixture.bin',content:bytes.toString('base64')}]);
 uncertain=true;await page.getByRole('button',{name:'New email',exact:true}).click();await page.getByLabel('To',{exact:true}).fill('fixture@bittrees.org');await page.getByLabel('Message',{exact:true}).fill('Uncertain fixture');await page.getByLabel('Attach files',{exact:true}).setInputFiles({name:'uncertain.txt',mimeType:'text/plain',buffer:Buffer.from('fixture')});
 await expect(page.getByText('uncertain.txt · 7 B',{exact:true})).toBeVisible();await page.getByRole('button',{name:'Send email',exact:true}).click();await expect(page.getByText('Check your previous send',{exact:true})).toBeVisible();
 await page.reload();await page.getByRole('navigation',{name:'Primary'}).getByRole('button',{name:/Email/}).click();await expect(page.getByText('Check your previous send',{exact:true})).toBeVisible();expect(sends).toHaveLength(2);
 expect(await page.evaluate(()=>JSON.stringify({...localStorage}))).not.toContain('uncertain.txt');
});
