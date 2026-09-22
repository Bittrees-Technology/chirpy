import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {createSiweMessage} from 'viem/siwe';
import {connectMail,mailStatus,mailMessages,mailPage,mailMessage,mailReceipt,sendMail,replyAddress,MailClientError} from '../src/connectedMail';
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
