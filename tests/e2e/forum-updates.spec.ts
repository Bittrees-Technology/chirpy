import {test,expect} from './fixtures/wallet';
test('wallet can follow forum, see unread updates, reload and unfollow without sending messages',async({page,walletAddress},info)=>{
 let requests=0;const id='0x'+'a'.repeat(64);
 await page.route('https://gov.bittrees.org/api/forum-feed',route=>{requests++;return route.fulfill({json:{items:[{id,title:'Governance discussion',time:Math.floor(Date.now()/1000)+1,url:'https://gov.bittrees.org/forum/'+id}]}});});
 await page.goto('/?forum=governance');await expect(page.getByRole('heading',{name:'Governance forum'})).toBeVisible();expect(requests).toBe(0);
 await page.locator('.nav-item',{hasText:'Settings'}).click();await page.getByRole('button',{name:'Connect wallet',exact:true}).click();
 await page.locator('.nav-item',{hasText:'Forum'}).click();await page.getByRole('button',{name:'Follow forum',exact:true}).click();
 await expect(page.getByRole('link',{name:'Governance discussion'})).toBeVisible();await expect(page.getByText('1 unread updates',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Mark updates as read'}).click();await expect(page.getByText('0 unread updates',{exact:true})).toBeVisible();
 await page.reload();await expect(page.getByRole('button',{name:'Unfollow forum'})).toBeVisible();
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
 await page.screenshot({path:info.outputPath('forum-mobile.png'),fullPage:true});
 await page.getByRole('button',{name:'Unfollow forum'}).click();await expect(page.getByRole('link',{name:'Governance discussion'})).toHaveCount(0);
 expect(await page.evaluate(wallet=>JSON.parse(localStorage.getItem(`chat:forum-follow:v1:${wallet.toLowerCase()}`)!).following,walletAddress)).toBe(false);
});
