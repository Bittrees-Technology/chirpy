import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
const read=p=>readFileSync(new URL('../'+p,import.meta.url),'utf8');
test('only static public information is discoverable; app and private routes stay excluded',()=>{
 const sitemap=read('apps/web/public/sitemap.xml');
 const paths=[...sitemap.matchAll(/<loc>https:\/\/chat\.bittrees\.org([^<]+)<\/loc>/g)].map(m=>m[1]);
 assert.deepEqual(paths,['/about','/support','/security','/es/support/','/es/security/','/privacy','/service']);
 for(const path of paths){const file=path.startsWith('/es/')?path.slice(1)+'index.html':path.slice(1)+'.html';const html=read('apps/web/public/'+file);assert.ok(html.includes(`rel="canonical" href="https://chat.bittrees.org${path}"`));assert.match(html,/<h1>/);assert.match(html,/rel="icon"/);}
 assert.match(read('apps/web/index.html'),/name="robots" content="noindex, nofollow"/);
 const robots=read('apps/web/public/robots.txt');for(const path of ['/api/','/administration','/mail/','/account','/wallet','/session'])assert.ok(robots.includes('Disallow: '+path));
 const config=JSON.parse(read('vercel.json'));assert.ok(!config.rewrites.some(r=>r.destination==='/index.html'),'unknown paths must not fall back to the app with HTTP200');
 for(const route of ['/','/api/:path*','/mail/:path*','/administration/:path*'])assert.ok(config.headers.some(r=>r.source===route&&r.headers.some(h=>h.key==='X-Robots-Tag'&&h.value.includes('noindex'))));
 assert.ok(!read('apps/web/public/llms.txt').includes('/api/'));
});
