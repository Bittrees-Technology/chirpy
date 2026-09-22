import {it,expect,vi} from 'vitest';
import DOMPurify from 'dompurify';
import {formattedMailDocument} from '../src/mailHtml';
it('preserves basic email formatting inside a resource-blocked standalone document',()=>{
 const document=new DOMParser().parseFromString(formattedMailDocument('<h2>Title</h2><p>Hello <strong>world</strong></p><table><tr><td>Cell</td></tr></table>'),'text/html');
 expect(document.body.querySelector('strong')?.textContent).toBe('world');expect(document.body.querySelector('td')?.textContent).toBe('Cell');
 expect(document.querySelector('meta[http-equiv]')?.getAttribute('content')).toContain("default-src 'none'");
});
it('removes active content, external resources, navigation, CSS, forms and identity attributes',()=>{
 const malicious='<base href="https://evil.test"><meta http-equiv="refresh" content="0;url=https://evil.test"><link rel="stylesheet" href="https://evil.test"><script>alert(1)</script><style>body{background:url(https://evil.test)}</style><img src="https://evil.test/pixel"><svg onload="alert(1)"><a href="https://evil.test">svg</a></svg><math><mtext><img src=x onerror=alert(1)></mtext></math><iframe srcdoc="bad"></iframe><form action="https://evil.test"><input name="password"><button>Submit</button></form><a href="javascript:alert(1)" target="_top">Link</a><p id="location" name="cookie" class="evil" style="background:url(https://evil.test)" data-x="x" aria-label="fake" onclick="alert(1)">Text</p>';
 const body=new DOMParser().parseFromString(formattedMailDocument(malicious),'text/html').body;
 expect(body.querySelector('script,style,img,svg,math,iframe,form,input,button,a,link,meta,base')).toBeNull();
 expect([...body.querySelectorAll('*')].flatMap(el=>[...el.attributes])).toEqual([]);expect(body.textContent).toContain('Text');
});
it('fails closed on oversize input or an unsupported sanitizer',()=>{
 expect(()=>formattedMailDocument('😀'.repeat(4001))).toThrow();const prior=DOMPurify.isSupported;
 try{DOMPurify.isSupported=false;expect(()=>formattedMailDocument('<p>test</p>')).toThrow();}finally{DOMPurify.isSupported=prior;vi.restoreAllMocks();}
});
it('keeps malformed nesting and clobbering payloads inside the formatting allowlist',()=>{
 for(const html of ['<svg><style><a id="</style><img src=x onerror=alert(1)>">','<math><mtext><table><mglyph><style><!--</style><img title="--><img src=x onerror=alert(1)>">','<form><input name="nodeName"><input name="attributes"></form><p id="__proto__">safe</p>','<noscript><p title="</noscript><img src=x onerror=alert(1)>">']){
  const body=new DOMParser().parseFromString(formattedMailDocument(html),'text/html').body;
  expect(body.querySelector('script,style,img,svg,math,form,input,noscript')).toBeNull();expect([...body.querySelectorAll('*')].flatMap(el=>[...el.attributes])).toEqual([]);
 }
});
