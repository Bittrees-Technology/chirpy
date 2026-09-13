import {expect,test} from './fixtures/wallet';
import {recoverMessageAddress} from 'viem';
import {mailSignMessage} from '../../packages/core/src/mailAuth.js';
test('wallet email signs scoped requests, retries with the same ID and recovers status after reload',async({page,walletAddress})=>{
  const sends:any[]=[];let fail=true;const checks:any[]=[];
  await page.route('**/api/mail',async route=>{
    const service=new URL('/api/mail',route.request().url()).href;
    if(route.request().method()==='GET') return route.fulfill({json:{enabled:true,service,authVersion:1}});
    const {command,signature}=route.request().postDataJSON();
    expect(command.wallet).toBe(walletAddress.toLowerCase());expect(command.service).toBe(service);
    expect((await recoverMessageAddress({message:mailSignMessage(command),signature})).toLowerCase()).toBe(walletAddress.toLowerCase());
    if(command.action==='send'){
      sends.push(command);
      if(fail){fail=false;return route.fulfill({status:503,json:{error:'synthetic outage'}});}
      return route.fulfill({json:{status:'queued',id:command.id}});
    }
    checks.push(command);return route.fulfill({json:{status:'accepted',id:command.id}});
  });
  await page.goto('/');await page.locator('.nav-item',{hasText:'Settings'}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
  await page.locator('.nav-item',{hasText:'Channels'}).click();
  await page.getByLabel('Recipient',{exact:true}).fill('member@example.com');await page.getByLabel('Subject',{exact:true}).fill('Hello from my wallet');await page.getByLabel('Email message',{exact:true}).fill('Private synthetic message');
  await page.getByRole('button',{name:'Sign and queue email'}).click();
  await expect(page.getByRole('alert')).toContainText('result is unknown');
  await expect(page.getByLabel('Recipient',{exact:true})).toBeDisabled();
  await page.getByRole('button',{name:'Retry same request'}).click();await expect(page.getByRole('status')).toContainText('Queued for email forwarding');
  expect(sends).toHaveLength(2);expect(sends[0].id).toBe(sends[1].id);expect(sends[0].text).toBe(sends[1].text);
  await page.reload();await page.locator('.nav-item',{hasText:'Channels'}).click();
  await expect(page.getByLabel('Request ID',{exact:false})).toHaveValue(sends[0].id);
  await expect(page.getByLabel('Email message',{exact:true})).toHaveValue('');
  await page.getByRole('button',{name:'Check request status'}).click();await expect(page.getByRole('status')).toContainText('does not confirm delivery or reading');
  expect(checks[0].id).toBe(sends[0].id);
  await page.getByRole('button',{name:'New message',exact:true}).last().click();await expect(page.getByLabel('Request ID',{exact:false})).toHaveValue('');
});
test('unconfigured forwarding does not offer an active send form',async({page})=>{
  await page.route('**/api/mail',route=>route.fulfill({status:503,json:{enabled:false}}));await page.goto('/');await page.locator('.nav-item',{hasText:'Channels'}).click();
  await expect(page.getByText('Forwarding is not activated on this service yet.')).toBeVisible();await expect(page.getByRole('button',{name:'Sign and queue email'})).toHaveCount(0);
});
