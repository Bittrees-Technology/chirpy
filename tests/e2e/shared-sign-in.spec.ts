import {test,expect} from '@playwright/test';
for(const action of ['publish','resume'])test('shared sign-in '+action+' uses canonical handoff and preserves return location',async({page})=>{
 await page.route('**/api/sso/status',r=>r.fulfill({json:{configured:true,action}}));
 await page.route('**/api/sso/start?*',r=>r.fulfill({contentType:'text/html',body:'<p>Shared handoff</p>'}));
 await page.goto('/?mail=connected');
 await expect(page).toHaveURL(new RegExp('/api/sso/start\\?'));
 const u=new URL(page.url());expect(u.searchParams.get('mode')).toBe(action);expect(u.searchParams.get('return_to')).toBe('/?mail=connected');
 expect([...u.searchParams.keys()].sort()).toEqual(['mode','return_to']);
});
for(const response of [{configured:false},{configured:true,action:null}])test('shared sign-in allows local fallback '+JSON.stringify(response),async({page})=>{
 await page.route('**/api/sso/status',r=>r.fulfill({json:response}));
 await page.goto('/');await expect(page.locator('.brand-name')).toHaveText('Chat');expect(new URL(page.url()).pathname).toBe('/');
});
test('issuer status outage leaves local Chat available',async({page})=>{
 await page.route('**/api/sso/status',r=>r.fulfill({status:503,json:{error:'unavailable'}}));
 await page.goto('/');await expect(page.locator('.brand-name')).toHaveText('Chat');expect(new URL(page.url()).pathname).toBe('/');
});
