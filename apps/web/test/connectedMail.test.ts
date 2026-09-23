import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createSiweMessage} from 'viem/siwe';
import {mailHtml,mailAttachments,downloadMailAttachment,connectMail,mailStatus,mailMessages,mailPage,mailThreadPage,mailThread,mailMessage,mailReceipt,sendMail,replyAddress,MailClientError} from '../src/connectedMail';
const mocks=vi.hoisted(()=>({provider:null as any}));
vi.mock('../src/walletProviders',()=>({getActiveProvider:()=>mocks.provider}));
const wallet='0x'+'1'.repeat(40);let storage:Map<string,string>;let requests:any[],fetcher:ReturnType<typeof vi.fn>;
beforeEach(()=>{
 storage=new Map();vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});requests=[];mocks.provider={request:vi.fn(async({method})=>method==='eth_accounts'?[wallet]:'0x'+'2'.repeat(130))};
 fetcher=vi.fn(async(url,init)=>{const action=String(url).split('/').at(-1);requests.push({action,body:init?.body?JSON.parse(init.body):undefined});
  if(action==='disconnect')return Response.json({ok:true,sourceRevoked:true});
  if(action==='challenge')return Response.json({message:createSiweMessage({address:wallet as `0x${string}`,domain:'chat.bittrees.org',uri:'https://chat.bittrees.org/api/mail/verify',version:'1',chainId:1,nonce:'a'.repeat(64),issuedAt:new Date(),expirationTime:new Date(Date.now()+300000),statement:'Sign in to connect your mailbox to Chat. Mail will separately ask for read and send permission. No transaction is authorized.'})});
  if(action==='verify')return Response.json({wallet});
  if(action==='start')return Response.json({url:'https://mail.bittrees.org/connect/chat#challenge='+'x'.repeat(43)+'&state='+'b'.repeat(64)+'&wallet='+wallet});
  return Response.json({ok:true});
 });vi.stubGlobal('fetch',fetcher);
});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('connects with exact bounded sign-in message and fixed source URL without exposing tokens',async()=>{
 const url=await connectMail(wallet,false);expect(url).toMatch(/^https:\/\/mail.bittrees.org\/connect\/chat#/);expect(requests.map(r=>r.action)).toEqual(['disconnect','challenge','verify','start']);
 expect(mocks.provider.request.mock.calls.filter(([r])=>r.method==='personal_sign')).toHaveLength(1);
});
it('will not sign an unrelated or expanded authorization message',async()=>{
 const original=fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async(url,init)=>{const response=await original(url,init);if(String(url).endsWith('/challenge')){const data=await response.json();data.message+='\n\nResources:\n- https://evil.test/permission';return Response.json(data);}return response;});
 await expect(connectMail(wallet,false)).rejects.toBeInstanceOf(MailClientError);expect(mocks.provider.request.mock.calls.some(([r])=>r.method==='personal_sign')).toBe(false);
});
it('wallet changes during signing stop verification and navigation',async()=>{
 mocks.provider.request.mockImplementation(async({method})=>{if(method==='personal_sign'){mocks.provider={request:async()=>['0x'+'3'.repeat(40)]};return '0x'+'2'.repeat(130);}return [wallet];});
 await expect(connectMail(wallet,false)).rejects.toMatchObject({code:'wallet'});expect(requests.some(r=>r.action==='verify')).toBe(false);
});
it('validates connected wallet and strict source message identity',async()=>{
 fetcher.mockResolvedValueOnce(Response.json({enabled:true,wallet:'0x'+'2'.repeat(40),connection:null}));await expect(mailStatus(wallet)).rejects.toMatchObject({code:'wallet'});
 fetcher.mockResolvedValueOnce(Response.json({messages:[{id:'bad',from:'x',subject:'x',date:'x'}]}));await expect(mailMessages(wallet,'INBOX')).rejects.toMatchObject({code:'failed'});
 fetcher.mockResolvedValueOnce(Response.json({message:{id:'b'.repeat(64),from:'x',subject:'x',date:'x',text:'private'}}));await expect(mailMessage(wallet,'INBOX','a'.repeat(64))).rejects.toMatchObject({code:'failed'});
});
const draft={to:'fixture@bittrees.org',subject:'Test',text:'private draft'};
it('records the send before dispatch, clears only on confirmed success and stores no content',async()=>{
 fetcher.mockImplementation(async(_url,init)=>{const receipt=mailReceipt(wallet);expect(receipt).not.toBeNull();expect(JSON.stringify([...storage])).not.toContain('private draft');expect(JSON.parse(init.body).input.idempotencyKey).toBe(receipt!.id);return Response.json({ok:true});});
 await sendMail(wallet,draft);expect(mailReceipt(wallet)).toBeNull();
});
it('uncertain sends keep their receipt and a second click cannot create a new send',async()=>{
 fetcher.mockRejectedValue(new Error('offline'));await expect(sendMail(wallet,draft)).rejects.toThrow();expect(mailReceipt(wallet)).not.toBeNull();
 await expect(sendMail(wallet,draft)).rejects.toMatchObject({code:'storage'});expect(fetcher).toHaveBeenCalledTimes(1);
});
it('storage failure prevents dispatch; late response after wallet change remains uncertain',async()=>{
 const spy=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('full');});await expect(sendMail(wallet,draft)).rejects.toMatchObject({code:'storage'});expect(fetcher).not.toHaveBeenCalled();spy.mockRestore();
 fetcher.mockImplementation(async()=>{mocks.provider={request:async()=>['0x'+'3'.repeat(40)]};return Response.json({ok:true});});await expect(sendMail(wallet,draft)).rejects.toMatchObject({code:'wallet'});expect(mailReceipt(wallet)).not.toBeNull();
});
it('aborting a dispatched send retains the warning and reply extraction rejects header injection',async()=>{
 const c=new AbortController();fetcher.mockImplementation(async()=>{c.abort();return Response.json({ok:true});});await expect(sendMail(wallet,draft,c.signal)).rejects.toThrow();expect(mailReceipt(wallet)).not.toBeNull();
 expect(replyAddress('Person <fixture@bittrees.org>')).toBe('fixture@bittrees.org');expect(replyAddress('fixture@bittrees.org\nBcc:x@y.org')).toBe('');
});
it('coordinates concurrent sends across tabs and refuses uncoordinated storage',async()=>{
 fetcher.mockRejectedValue(new Error('offline'));
 const results=await Promise.allSettled([sendMail(wallet,draft),sendMail(wallet,draft)]);
 expect(results.every(r=>r.status==='rejected')).toBe(true);expect(fetcher).toHaveBeenCalledTimes(1);
 localStorage.removeItem('chat:mail-pending:v1:'+wallet);
 Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});
 await expect(sendMail(wallet,draft)).rejects.toMatchObject({code:'storage'});expect(fetcher).toHaveBeenCalledTimes(1);
});
it('validates bounded pages and passes only the selected cursor to Mail',async()=>{
 const rows=Array.from({length:25},(_,i)=>({id:i.toString(16).padStart(64,'0'),from:'fixture@bittrees.org',subject:'Fixture',date:'Today'})),cursor='c'.repeat(64);
 fetcher.mockResolvedValueOnce(Response.json({messages:rows,nextCursor:'d'.repeat(64)}));
 expect(await mailPage(wallet,'INBOX',cursor)).toEqual({messages:rows,nextCursor:'d'.repeat(64)});
 expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).input).toEqual({folder:'INBOX',cursor});
 for(const data of [{messages:rows,nextCursor:cursor},{messages:rows,nextCursor:'bad'},{messages:rows.slice(1),nextCursor:'d'.repeat(64)},{messages:[rows[0],rows[0]],nextCursor:null}]){
  fetcher.mockResolvedValueOnce(Response.json(data));await expect(mailPage(wallet,'INBOX',cursor)).rejects.toMatchObject({code:'failed'});
 }
 const count=fetcher.mock.calls.length;await expect(mailPage(wallet,'INBOX','../escape')).rejects.toMatchObject({code:'failed'});expect(fetcher).toHaveBeenCalledTimes(count);
});
it('reports changed or oversized pages with recovery guidance',async()=>{
 for(const [status,code] of [[409,'pageChanged'],[413,'pageLimit']] as const){fetcher.mockResolvedValueOnce(Response.json({}, {status}));await expect(mailPage(wallet,'INBOX','c'.repeat(64))).rejects.toMatchObject({code});}
});
it('accepts bounded source reply metadata and rejects malformed version or recipient',async()=>{
 const message={id:'a'.repeat(64),from:'fixture@bittrees.org',subject:'Fixture',date:'Today',text:'Original',sourceVersion:'b'.repeat(64),replyTo:'reply@bittrees.org',threadedReply:true};
 fetcher.mockResolvedValueOnce(Response.json({message}));expect(await mailMessage(wallet,'INBOX',message.id)).toEqual(message);
 for(const change of [{sourceVersion:'invalid'},{replyTo:'a@example.org\r\nBcc:x@example.org'},{threadedReply:'yes'}]){fetcher.mockResolvedValueOnce(Response.json({message:{...message,...change}}));await expect(mailMessage(wallet,'INBOX',message.id)).rejects.toMatchObject({code:'failed'});}
});
it('validates conversation counts, versions, folder-qualified members and bounded cursors',async()=>{
 const id='a'.repeat(64),version='b'.repeat(64),cursor='c'.repeat(64),member={id:'d'.repeat(64),folder:'Sent',from:'Fixture',subject:'😀'.repeat(200),date:'Today'};
 fetcher.mockResolvedValueOnce(Response.json({threads:[{id,version,count:2,latest:member}],nextCursor:cursor}));
 expect((await mailThreadPage(wallet,'INBOX')).threads[0].latest).toEqual(member);
 fetcher.mockResolvedValueOnce(Response.json({id,version,count:2,messages:[member,{...member,folder:'INBOX'}],nextCursor:null}));
 expect((await mailThread(wallet,'INBOX',id)).messages).toHaveLength(2);
 for(const patch of [{id:'f'.repeat(64)},{version:'bad'},{count:0},{count:10001},{messages:[member,member]},{messages:[{...member,folder:'../escape'}]},{messages:[]},{nextCursor:cursor}]){
  fetcher.mockResolvedValueOnce(Response.json({id,version,count:2,messages:[member],nextCursor:null,...patch}));await expect(mailThread(wallet,'INBOX',id,cursor)).rejects.toMatchObject({code:'failed'});
 }
 for(const threads of [[{id,version,count:1,latest:member},{id,version,count:1,latest:member}],[{id,version,count:'2',latest:member}]]){fetcher.mockResolvedValueOnce(Response.json({threads,nextCursor:null}));await expect(mailThreadPage(wallet,'INBOX')).rejects.toMatchObject({code:'failed'});}
});
it('conversation reads map changed sources and limits to actionable errors',async()=>{
 for(const [status,code]of [[404,'pageChanged'],[409,'pageChanged'],[413,'pageLimit'],[403,'denied']] as const){fetcher.mockResolvedValueOnce(Response.json({error:'fixture'},{status}));await expect(mailThread(wallet,'INBOX','a'.repeat(64))).rejects.toMatchObject({code});}
});

it('rejects conversation responses that claim completeness while omitting members',async()=>{
 const id='a'.repeat(64),version='b'.repeat(64),message={id:'d'.repeat(64),folder:'INBOX',from:'Fixture',subject:'Test',date:'Today'};
 fetcher.mockResolvedValueOnce(Response.json({id,version,count:2,messages:[message],nextCursor:null}));await expect(mailThread(wallet,'INBOX',id)).rejects.toMatchObject({code:'failed'});
 fetcher.mockResolvedValueOnce(Response.json({id,version,count:1,messages:[message],nextCursor:'c'.repeat(64)}));await expect(mailThread(wallet,'INBOX',id)).rejects.toMatchObject({code:'failed'});
});

const fileItem={id:'1.2',filename:'fixture.bin',contentType:'application/octet-stream',bytes:1048576,downloadable:true};
const fileContext={id:'a'.repeat(64),sourceVersion:'b'.repeat(64),chunkBytes:12288,maxAttachmentBytes:1048576,transferVersion:2};
async function fileFixture(changes?:(data:any,index:number)=>any){
 const bytes=Uint8Array.from({length:fileItem.bytes},(_,i)=>i%256),sha256=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');let count=0;
 fetcher.mockImplementation(async(_url,init)=>{const request=JSON.parse(init.body);const data=request.action==='attachments'?{...fileContext,attachments:[fileItem]}:{...fileContext,transfer:'complete',attachment:fileItem,sha256,data:Buffer.from(bytes).toString('base64')};return Response.json(changes?changes(data,count++):data);});return bytes;
}
it('downloads the full bounded file in one operation and checks its digest',async()=>{
 const expected=await fileFixture(),items=await mailAttachments(wallet,'INBOX',fileContext.id,fileContext.sourceVersion);
 const result=await downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,items[0]);expect(result.bytes).toEqual(expected);expect(result.filename).toBe('fixture.bin');expect(fetcher).toHaveBeenCalledTimes(2);expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body)).toMatchObject({action:'attachmentFile',input:{part:'1.2',version:fileContext.sourceVersion,transferVersion:2}});
});
it('rejects changed content, selectors, truncated files and noncanonical bytes without returning a file',async()=>{
 for(const change of [(d:any)=>({...d,sourceVersion:'c'.repeat(64)}),(d:any)=>({...d,transfer:'chunk'}),(d:any)=>({...d,maxAttachmentBytes:524288}),(d:any)=>({...d,id:'c'.repeat(64)}),(d:any)=>({...d,data:d.data+'\n'}),(d:any)=>({...d,sha256:'c'.repeat(64)}),(d:any)=>({...d,data:d.data.slice(4)}),(d:any)=>({...d,attachment:{...fileItem,filename:'different.bin'}})]){
  await fileFixture((data,index)=>index===0?change(data):data);await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem)).rejects.toMatchObject({code:'failed'});
 }
});
it('does not finish an attachment after wallet change, revocation or cancellation',async()=>{
 await fileFixture();const original=fetcher.getMockImplementation()!;
 fetcher.mockImplementation(async(...args)=>{const result=await original(...args);mocks.provider={request:async()=>['0x'+'2'.repeat(40)]};return result;});await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem)).rejects.toMatchObject({code:'wallet'});
 mocks.provider={request:async()=>[wallet]};await fileFixture();const run=fetcher.getMockImplementation()!;let calls=0;fetcher.mockImplementation(async(...args)=>++calls===1?Response.json({error:'revoked'},{status:403}):run(...args));await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem)).rejects.toMatchObject({code:'denied'});
 const controller=new AbortController();await fileFixture(()=>{controller.abort();return {};});await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem,controller.signal)).rejects.toBeDefined();
});
it('rejects unsafe or oversized attachment metadata before downloading',async()=>{
 for(const change of [{filename:'../escape'},{filename:'evil\u202egnp.exe'},{bytes:1048577},{id:'1.0'},{bytes:null}]){
  await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,{...fileItem,...change})).rejects.toMatchObject({code:'failed'});
 }
 expect(fetcher).not.toHaveBeenCalled();
});

it('validates the selected HTML source and bounded preview flags',async()=>{
 const id='a'.repeat(64),version='b'.repeat(64),valid={id,sourceVersion:version,html:'<p>Test</p>',bodyAvailable:true,truncated:false};
 fetcher.mockResolvedValue(Response.json(valid));expect(await mailHtml(wallet,'Sent',id,version)).toEqual({html:valid.html,bodyAvailable:true,truncated:false});
 for(const change of [{id:'c'.repeat(64)},{sourceVersion:'c'.repeat(64)},{html:'😀'.repeat(4001)},{bodyAvailable:false},{truncated:'false'}]){fetcher.mockResolvedValue(Response.json({...valid,...change}));await expect(mailHtml(wallet,'Sent',id,version)).rejects.toMatchObject({code:'failed'});}
});

it('prepares bounded binary files without persisting content and validates the total budget',async()=>{
 const {prepareMailAttachments,validMailDraft}=await import('../src/connectedMail');
 const bytes=new Uint8Array(1048576);for(let i=0;i<bytes.length;i++)bytes[i]=i%256;
 const read=vi.fn(async()=>bytes.buffer),file={name:'fixture 🐦.bin',size:bytes.length,arrayBuffer:read} as unknown as File;
 const files=await prepareMailAttachments([file]);expect(atob(files[0].content).length).toBe(bytes.length);expect(atob(files[0].content).charCodeAt(255)).toBe(255);expect(validMailDraft({...draft,attachments:files})).toBe(true);
 expect(validMailDraft({...draft,text:'x'.repeat(20000),attachments:files})).toBe(false);
 await expect(prepareMailAttachments([{...file,size:1048577} as File])).rejects.toMatchObject({code:'attachmentFiles'});expect(read).toHaveBeenCalledTimes(1);
 await expect(prepareMailAttachments([{...file,size:1} as File],files)).rejects.toMatchObject({code:'attachmentFiles'});expect(read).toHaveBeenCalledTimes(1);
 for(const filename of ['../x','x\nBcc:bad','\ud800','x\u202ey',' '])expect(validMailDraft({...draft,attachments:[{filename,content:'eA=='}]})).toBe(false);
 for(const content of ['eB==','eA=','eA==\n','bad!'])expect(validMailDraft({...draft,attachments:[{filename:'x',content}]})).toBe(false);
 expect(storage.size).toBe(0);
});
it('aborted file reads cannot return private bytes or start a send',async()=>{
 const {prepareMailAttachments}=await import('../src/connectedMail');const c=new AbortController();let finish!:(v:ArrayBuffer)=>void;
 const file={name:'x.bin',size:1,arrayBuffer:()=>new Promise<ArrayBuffer>(r=>finish=r)} as File;
 const promise=prepareMailAttachments([file],[],c.signal);c.abort();finish(new Uint8Array([120]).buffer);
 await expect(promise).rejects.toThrow();expect(fetcher).not.toHaveBeenCalled();expect(storage.size).toBe(0);
});
it('send snapshots attachment bytes before wallet checks and uncertain sends cannot repeat',async()=>{
 const outgoing={...draft,attachments:[{filename:'original.bin',content:'eA=='}]};
 fetcher.mockRejectedValue(new Error('offline'));
 const promise=sendMail(wallet,outgoing);outgoing.attachments[0].content='eQ==';outgoing.attachments[0].filename='changed.bin';
 await expect(promise).rejects.toThrow();expect(JSON.parse(fetcher.mock.calls[0][1].body).input.attachments).toEqual([{filename:'original.bin',content:'eA=='}]);
 expect(JSON.stringify([...storage])).not.toContain('original.bin');await expect(sendMail(wallet,outgoing)).rejects.toMatchObject({code:'storage'});expect(fetcher).toHaveBeenCalledTimes(1);
});

it('reports real transfer phases and cancellation during verification releases no file',async()=>{
 await fileFixture();const progress=vi.fn();await downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem,undefined,progress);
 expect(progress.mock.calls.map(([p])=>p)).toEqual([{phase:'preparing',bytes:1048576},{phase:'checking',bytes:1048576}]);
 const c=new AbortController();await fileFixture();await expect(downloadMailAttachment(wallet,'INBOX',fileContext.id,fileContext.sourceVersion,fileItem,c.signal,p=>{if(p.phase==='checking')c.abort();})).rejects.toThrow();
});


it('opts into larger message and preview reads and rejects downgraded attachment metadata',async()=>{
 const id=fileContext.id,version=fileContext.sourceVersion;
 fetcher.mockResolvedValue(Response.json({message:{id,from:'fixture@bittrees.org',subject:'Fixture',date:'Today',text:'Body'}}));await mailMessage(wallet,'INBOX',id);
 expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).input).toEqual({folder:'INBOX',id,transferVersion:2});
 fetcher.mockResolvedValue(Response.json({id,sourceVersion:version,html:'',bodyAvailable:false,truncated:false}));await mailHtml(wallet,'INBOX',id,version);
 expect(JSON.parse(fetcher.mock.calls.at(-1)![1].body).input.transferVersion).toBe(2);
 for(const change of [{transferVersion:undefined,maxAttachmentBytes:262144},{transferVersion:1},{transferVersion:'2'},{maxAttachmentBytes:2097152}]){
  await fileFixture(data=>({...data,...change}));await expect(mailAttachments(wallet,'INBOX',id,version)).rejects.toMatchObject({code:'failed'});
 }
});
