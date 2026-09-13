import { test, expect } from '@playwright/test';
const token='ab'.repeat(32);
test('email opt-out requires a click, keeps the capability private and safely retries',async({page},testInfo)=>{
  const calls:any[]=[];const urls:string[]=[];page.on('request',req=>urls.push(req.url()));
  await page.route('**/api/mail-optout',async route=>{calls.push({body:route.request().postDataJSON(),headers:route.request().headers()});await route.fulfill({status:calls.length===1?503:200,json:calls.length===1?{error:'unavailable'}:{status:'opted-out'}});});
  await page.goto(`/mail/optout/#token=${token}`);
  await expect(page.getByRole('button',{name:'Stop future email'})).toBeEnabled();expect(calls).toHaveLength(0);expect(page.url()).not.toContain(token);
  expect(urls.every(url=>!url.includes(token)&&new URL(url).hostname==='127.0.0.1')).toBe(true);
  expect(await page.evaluate(()=>[localStorage.length,sessionStorage.length])).toEqual([0,0]);
  await page.screenshot({path:testInfo.outputPath('optout.png'),fullPage:true});
  await page.getByRole('button',{name:'Stop future email'}).click();await expect(page.getByRole('status')).toContainText('could not be confirmed');
  await page.getByRole('button',{name:'Stop future email'}).click();await expect(page.getByRole('status')).toContainText('is stopped');
  expect(calls.map(c=>c.body)).toEqual([{token},{token}]);expect(calls.every(c=>!c.headers.referer&&!c.headers.authorization)).toBe(true);
  await expect(page.getByRole('button')).toBeDisabled();await page.reload();await expect(page.getByRole('status')).toContainText('link is missing');expect(calls).toHaveLength(2);
});
test('invalid links cannot submit and Spanish instructions remain available',async({page})=>{
  let calls=0;await page.route('**/api/mail-optout',route=>{calls++;return route.abort();});
  await page.goto(`/mail/optout/#token=${token}&other=1`);await expect(page.getByRole('button')).toBeDisabled();
  await page.getByLabel('Language / Idioma').selectOption('es');await expect(page.getByRole('heading')).toHaveText('Dejar de recibir correos de Chirpy');
  await expect(page.getByRole('status')).toContainText('enlace falta');expect(calls).toBe(0);
});
test('mobile Spanish confirmation fits the viewport and works with the keyboard',async({page},testInfo)=>{
  await page.setViewportSize({width:390,height:844});let calls=0;
  await page.route('**/api/mail-optout',route=>{calls++;return route.fulfill({json:{status:'opted-out'}});});
  await page.goto(`/mail/optout/#token=${token}`);await page.keyboard.press('Tab');await expect(page.getByLabel('Language / Idioma')).toBeFocused();
  await page.getByLabel('Language / Idioma').selectOption('es');
  expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
  await page.screenshot({path:testInfo.outputPath('optout-mobile-es.png'),fullPage:true});
  await page.keyboard.press('Tab');await expect(page.getByRole('button')).toBeFocused();await page.keyboard.press('Enter');
  await expect(page.getByRole('status')).toContainText('Se han detenido');expect(calls).toBe(1);
});
