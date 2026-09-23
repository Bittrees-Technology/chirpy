import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Mailbox} from '../src/views/Mailbox';
import {I18nProvider} from '../src/i18n';
import * as mail from '../src/connectedMail';
const state=vi.hoisted(()=>({identity:{address:'0x'+'1'.repeat(40)},mode:'wallet'}));
vi.mock('../src/state',()=>({useIdentity:()=>state}));
vi.mock('../src/connectedMail',async original=>({...await original<any>(),mailHtml:vi.fn(),mailAttachments:vi.fn(),downloadMailAttachment:vi.fn(),mailStatus:vi.fn(),mailFolders:vi.fn(),mailPage:vi.fn(),mailThreadPage:vi.fn(),mailThread:vi.fn(),mailMessage:vi.fn(),disconnectMail:vi.fn(),sendMail:vi.fn(),mailReceipt:vi.fn(()=>null)}));
let container:HTMLDivElement,root:Root;
const connection=()=>({mailbox:'fixture@bittrees.org',scopes:['read','send'] as ('read'|'send')[],expiresAt:new Date(Date.now()+3600000).toISOString()});
const item={id:'a'.repeat(64),from:'Fixture <fixture@bittrees.org>',subject:'Acceptance fixture',date:'Today'};
const render=()=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(Mailbox,{key:state.identity.address,onOpenSettings:()=>{}})))));
const click=async(text:string)=>{const button=[...container.querySelectorAll('button')].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});
 state.identity={address:'0x'+'1'.repeat(40)};state.mode='wallet';
 vi.mocked(mail.mailStatus).mockResolvedValue(connection());vi.mocked(mail.mailFolders).mockResolvedValue(['INBOX','Sent']);vi.mocked(mail.mailPage).mockResolvedValue({messages:[item],nextCursor:null});vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'<img src=x onerror=alert(1)> private fixture'});vi.mocked(mail.mailReceipt).mockReturnValue(null);
 container=document.createElement('div');document.body.append(container);root=createRoot(container);
});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();vi.useRealTimers();vi.unstubAllGlobals();});
it('renders message content as text, respects read-only scope and clears it on disconnect',async()=>{
 vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['read']});vi.mocked(mail.disconnectMail).mockResolvedValue(false);
 await render();expect(container.textContent).toContain(item.subject);
 await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());
 expect(container.querySelector('pre')?.textContent).toContain('<img');expect(container.querySelector('img')).toBeNull();
 expect([...container.querySelectorAll('button')].find(b=>b.textContent==='Reply')?.disabled).toBe(true);
 await click('Disconnect Mail');expect(container.textContent).not.toContain('private fixture');expect(container.textContent).toContain('Mail could not confirm revocation');
});
it('late private responses cannot appear after the selected wallet changes',async()=>{
 let resolve!:(value:mail.MailMessage)=>void;vi.mocked(mail.mailMessage).mockImplementation(()=>new Promise(r=>resolve=r));
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());
 state.identity={address:'0x'+'2'.repeat(40)};vi.mocked(mail.mailStatus).mockResolvedValue(null);await render();
 await act(async()=>resolve({...item,text:'old wallet secret'}));expect(container.textContent).not.toContain('old wallet secret');expect(container.textContent).toContain('Connect your mailbox');
});
it('polls visible idle inboxes and removes content when source access is denied',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await render();
 await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());
 vi.mocked(mail.mailPage).mockRejectedValue(new mail.MailClientError('denied'));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(container.textContent).not.toContain('private fixture');expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('does not have permission');
});
it('expiry clears rendered content and pending sends prevent composing after remount',async()=>{
 vi.useFakeTimers();vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),expiresAt:new Date(Date.now()+1000).toISOString()});
 vi.mocked(mail.mailReceipt).mockReturnValue({id:'b'.repeat(64),createdAt:Date.now()});await render();
 expect([...container.querySelectorAll('button')].find(b=>b.textContent==='New email')?.disabled).toBe(true);expect(container.textContent).toContain('Check your previous send');
 await act(async()=>vi.advanceTimersByTimeAsync(1001));expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('session expired');
});
it('does not poll while composing or while the page is hidden',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});await render();await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(mail.mailPage).toHaveBeenCalledTimes(1);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await click('New email');await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(mail.mailPage).toHaveBeenCalledTimes(1);
});
it('cancelled reads cannot reveal a late response',async()=>{
 let resolve!:(value:mail.MailMessage)=>void;vi.mocked(mail.mailMessage).mockImplementation(()=>new Promise(r=>resolve=r));
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('Cancel');
 await act(async()=>resolve({...item,text:'cancelled private content'}));expect(container.textContent).not.toContain('cancelled private content');
});
it('send-only consent does not request folders or messages',async()=>{
 vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['send']});await render();
 expect(mail.mailFolders).not.toHaveBeenCalled();expect(mail.mailPage).not.toHaveBeenCalled();expect(container.textContent).toContain('allows sending only');
});

it('revoked connections offer an explicit reset before reconnecting',async()=>{
 vi.mocked(mail.mailStatus).mockRejectedValue(new mail.MailClientError('denied'));vi.mocked(mail.disconnectMail).mockResolvedValue(true);await render();
 expect(container.textContent).toContain('does not have permission');
 await click('Clear this connection attempt');expect(mail.disconnectMail).toHaveBeenCalledTimes(1);
 expect([...container.querySelectorAll('button')].some(b=>b.textContent==='Connect Mail')).toBe(true);
});
it('pages older and newer mail, pauses polling on older pages and resets on folder changes',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 const cursor='c'.repeat(64),older={...item,id:'b'.repeat(64),subject:'Older fixture'};
 vi.mocked(mail.mailPage).mockImplementation(async(_wallet,folder,after)=>after?{messages:[older],nextCursor:null}:{messages:[item],nextCursor:folder==='INBOX'?cursor:null});
 await render();await click('Older messages');expect(mail.mailPage).toHaveBeenLastCalledWith(state.identity.address,'INBOX',cursor,expect.any(AbortSignal));
 expect(container.textContent).toContain('Older fixture');expect(container.textContent).not.toContain('Acceptance fixture');
 const count=vi.mocked(mail.mailPage).mock.calls.length;await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(mail.mailPage).toHaveBeenCalledTimes(count);
 await click('Newer messages');expect(container.textContent).toContain('Acceptance fixture');await click('Older messages');
 await act(async()=>{const select=container.querySelector('select')!;select.value='Sent';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(mail.mailPage).toHaveBeenLastCalledWith(state.identity.address,'Sent',null,expect.any(AbortSignal));expect(container.textContent).not.toContain('Newer messages');
});
it('revoked access during older-page navigation clears every page and cursor control',async()=>{
 vi.mocked(mail.mailPage).mockResolvedValue({messages:[item],nextCursor:'c'.repeat(64)});await render();
 vi.mocked(mail.mailPage).mockRejectedValue(new mail.MailClientError('denied'));await click('Older messages');
 expect(container.textContent).not.toContain(item.subject);expect(container.textContent).not.toContain('Older messages');expect(container.textContent).toContain('Review your Mail connection');
});
it('replies use the source Reply-To and original version, while a new email clears reply context',async()=>{
 vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Original',sourceVersion:'d'.repeat(64),replyTo:'reply@bittrees.org',threadedReply:true});
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('Reply');
 expect(container.querySelector<HTMLInputElement>('input[type=email]')?.value).toBe('reply@bittrees.org');
 await act(async()=>{const textarea=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Authorized fixture reply');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(mail.sendMail).toHaveBeenCalledWith(state.identity.address,expect.objectContaining({to:'reply@bittrees.org',reply:{folder:'INBOX',id:item.id,version:'d'.repeat(64)}}),expect.any(AbortSignal));
 await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('Reply');await click('New email');
 expect(container.querySelector<HTMLInputElement>('input[type=email]')?.value).toBe('');expect(container.querySelector('h2')?.textContent).toBe('New email');
});

it('keeps controls usable during a slow poll, avoids overlapping polls, and prioritizes message reads',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await render();
 let resolvePage!:(value:Awaited<ReturnType<typeof mail.mailPage>>)=>void;
 vi.mocked(mail.mailPage).mockImplementationOnce(()=>new Promise(r=>resolvePage=r));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));
 const signal=vi.mocked(mail.mailPage).mock.lastCall![3]!;
 expect([...container.querySelectorAll('button')].filter(b=>['New email','Disconnect Mail','Refresh'].includes(b.textContent!)).every(b=>!b.disabled)).toBe(true);
 expect(container.querySelector<HTMLButtonElement>('.mailbox-row')!.disabled).toBe(false);
 await act(async()=>vi.advanceTimersByTimeAsync(90000));expect(mail.mailPage).toHaveBeenCalledTimes(2);
 let resolveMessage!:(value:mail.MailMessage)=>void;vi.mocked(mail.mailMessage).mockImplementationOnce(()=>new Promise(r=>resolveMessage=r));
 await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());expect(signal.aborted).toBe(true);
 await act(async()=>resolvePage({messages:[],nextCursor:null}));
 expect(container.querySelector<HTMLButtonElement>('.mailbox-row')!.disabled).toBe(true);
 await act(async()=>resolveMessage({...item,text:'Selected after polling'}));
 expect(container.textContent).toContain('Selected after polling');expect(container.textContent).toContain(item.subject);
});
it('starting a draft aborts a background read and late results cannot disturb the draft',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await render();
 let resolve!:(value:Awaited<ReturnType<typeof mail.mailPage>>)=>void;vi.mocked(mail.mailPage).mockImplementationOnce(()=>new Promise(r=>resolve=r));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));const signal=vi.mocked(mail.mailPage).mock.lastCall![3]!;
 await click('New email');expect(signal.aborted).toBe(true);
 await act(async()=>{const textarea=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Keep this draft');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>resolve({messages:[{...item,subject:'Obsolete poll'}],nextCursor:'c'.repeat(64)}));
 expect(container.querySelector('textarea')?.value).toBe('Keep this draft');expect(container.textContent).not.toContain('Obsolete poll');
 await act(async()=>vi.advanceTimersByTimeAsync(90000));expect(mail.mailPage).toHaveBeenCalledTimes(2);expect(mail.sendMail).not.toHaveBeenCalled();
});
it('changing folders invalidates a pending poll and preserves the selected folder results',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await render();
 let reject!:(error:unknown)=>void;vi.mocked(mail.mailPage).mockImplementationOnce(()=>new Promise((_r,j)=>reject=j));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));const signal=vi.mocked(mail.mailPage).mock.lastCall![3]!;
 vi.mocked(mail.mailPage).mockResolvedValue({messages:[{...item,subject:'Sent selection'}],nextCursor:null});
 await act(async()=>{const select=container.querySelector('select')!;select.value='Sent';select.dispatchEvent(new Event('change',{bubbles:true}));});
 expect(signal.aborted).toBe(true);
 await act(async()=>reject(new mail.MailClientError('denied')));
 expect(container.querySelector('select')?.value).toBe('Sent');expect(container.textContent).toContain('Sent selection');expect(container.textContent).not.toContain('does not have permission');
});
it('disconnect and expiry abort background reads and cannot restore private content',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});
 vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),expiresAt:new Date(Date.now()+60000).toISOString()});await render();
 let resolve!:(value:Awaited<ReturnType<typeof mail.mailPage>>)=>void;vi.mocked(mail.mailPage).mockImplementationOnce(()=>new Promise(r=>resolve=r));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));const signal=vi.mocked(mail.mailPage).mock.lastCall![3]!;
 await act(async()=>vi.advanceTimersByTimeAsync(15001));expect(signal.aborted).toBe(true);
 await act(async()=>resolve({messages:[item],nextCursor:null}));expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('session expired');
 vi.mocked(mail.mailStatus).mockResolvedValue(connection());await click('Refresh');
 vi.mocked(mail.mailPage).mockImplementationOnce(()=>new Promise(r=>resolve=r));await act(async()=>vi.advanceTimersByTimeAsync(45000));const disconnectSignal=vi.mocked(mail.mailPage).mock.lastCall![3]!;
 vi.mocked(mail.disconnectMail).mockResolvedValue(true);await click('Disconnect Mail');expect(disconnectSignal.aborted).toBe(true);
 await act(async()=>resolve({messages:[item],nextCursor:null}));expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('Mail disconnected');
});
const threadId='e'.repeat(64),threadVersion='f'.repeat(64),member={...item,folder:'Sent'};
async function conversations(){
 vi.mocked(mail.mailThreadPage).mockResolvedValue({threads:[{id:threadId,version:threadVersion,count:2,latest:member}],nextCursor:null});
 vi.mocked(mail.mailThread).mockResolvedValue({id:threadId,version:threadVersion,count:2,messages:[member,{...member,folder:'INBOX'}],nextCursor:null});
 await render();await act(async()=>{const select=container.querySelectorAll('select')[1];select.value='conversations';select.dispatchEvent(new Event('change',{bubbles:true}));});
}
const openConversation=()=>act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-list .mailbox-row')!.click());
it('opens folder-qualified conversation copies and replies to the actual source folder',async()=>{
 vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Conversation body',sourceVersion:'d'.repeat(64),replyTo:'reply@bittrees.org',threadedReply:true});
 await conversations();await openConversation();expect(mail.mailMessage).toHaveBeenLastCalledWith(state.identity.address,'Sent',item.id,expect.any(AbortSignal));
 expect(container.querySelectorAll('.mailbox-conversation .mailbox-row')).toHaveLength(2);
 await click('Reply');await act(async()=>{const textarea=container.querySelector('textarea')!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value')!.set!.call(textarea,'Reply fixture');textarea.dispatchEvent(new Event('input',{bubbles:true}));});
 await act(async()=>container.querySelector('form')!.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 expect(mail.sendMail).toHaveBeenCalledWith(state.identity.address,expect.objectContaining({reply:{folder:'Sent',id:item.id,version:'d'.repeat(64)}}),expect.any(AbortSignal));
});
it('pages complete conversation membership and rejects changed versions without reading stale members',async()=>{
 await conversations();vi.mocked(mail.mailThread).mockResolvedValueOnce({id:threadId,version:threadVersion,count:26,messages:[member],nextCursor:'c'.repeat(64)});await openConversation();
 vi.mocked(mail.mailThread).mockResolvedValueOnce({id:threadId,version:threadVersion,count:26,messages:[{...member,folder:'INBOX'}],nextCursor:null});
 await click('Older messages');expect(mail.mailThread).toHaveBeenLastCalledWith(state.identity.address,'INBOX',threadId,'c'.repeat(64),expect.any(AbortSignal));expect(mail.mailMessage).toHaveBeenLastCalledWith(state.identity.address,'INBOX',item.id,expect.any(AbortSignal));
 const reads=vi.mocked(mail.mailMessage).mock.calls.length;vi.mocked(mail.mailThread).mockResolvedValueOnce({id:threadId,version:'b'.repeat(64),count:26,messages:[member],nextCursor:null});await click('Newer messages');
 // First-page refresh is allowed; only continued pages must preserve the snapshot.
 expect(mail.mailMessage).toHaveBeenCalledTimes(reads+1);
 vi.mocked(mail.mailThread).mockResolvedValueOnce({id:threadId,version:threadVersion,count:26,messages:[member],nextCursor:'c'.repeat(64)});await openConversation();
 const before=vi.mocked(mail.mailMessage).mock.calls.length;vi.mocked(mail.mailThread).mockResolvedValueOnce({id:threadId,version:'b'.repeat(64),count:26,messages:[member],nextCursor:null});await click('Older messages');expect(mail.mailMessage).toHaveBeenCalledTimes(before);expect(container.textContent).toContain('This page changed');
});
it('conversation polling clears changed membership and current denial removes all private views',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await conversations();await openConversation();
 vi.mocked(mail.mailThreadPage).mockResolvedValueOnce({threads:[{id:threadId,version:'b'.repeat(64),count:3,latest:member}],nextCursor:null});await act(async()=>vi.advanceTimersByTimeAsync(45000));
 expect(container.querySelector('.mailbox-conversation')).toBeNull();expect(container.querySelector('pre')).toBeNull();expect(container.textContent).toContain('This conversation changed');
 vi.mocked(mail.mailThreadPage).mockRejectedValueOnce(new mail.MailClientError('denied'));await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('does not have permission');
});
it('late conversation results cannot appear after wallet changes',async()=>{
 await conversations();let resolve!:(v:mail.MailThreadPage)=>void;vi.mocked(mail.mailThread).mockImplementationOnce(()=>new Promise(r=>resolve=r));await openConversation();
 state.identity={address:'0x'+'2'.repeat(40)};vi.mocked(mail.mailStatus).mockResolvedValue(null);await render();
 await act(async()=>resolve({id:threadId,version:threadVersion,count:1,messages:[member],nextCursor:null}));expect(container.textContent).not.toContain(item.subject);expect(mail.mailMessage).not.toHaveBeenCalled();
});

it('downloads only an explicitly selected attachment with the source member folder and version',async()=>{
 vi.useFakeTimers();const create=vi.fn(()=> 'blob:fixture'),revoke=vi.fn();vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:create,revokeObjectURL:revoke}));
 const anchor=vi.spyOn(HTMLAnchorElement.prototype,'click').mockImplementation(()=>{});
 const version='b'.repeat(64),file={id:'1.2',filename:'fixture.bin',contentType:'application/octet-stream',bytes:3,downloadable:true};
 vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['read']});vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Body',sourceVersion:version,replyTo:'fixture@bittrees.org',threadedReply:true});
 vi.mocked(mail.mailAttachments).mockResolvedValue([file]);vi.mocked(mail.downloadMailAttachment).mockResolvedValue({filename:file.filename,bytes:new Uint8Array([1,2,3])});
 try{
  await render();await act(async()=>container.querySelector<HTMLSelectElement>('select')!.value='Sent');await act(async()=>container.querySelector('select')!.dispatchEvent(new Event('change',{bubbles:true})));
  await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());expect(mail.mailAttachments).not.toHaveBeenCalled();await click('Show attachments');expect(mail.downloadMailAttachment).not.toHaveBeenCalled();
  expect(container.textContent).toContain(file.filename);await click('Download');expect(mail.downloadMailAttachment).toHaveBeenCalledWith(state.identity.address,'Sent',item.id,version,file,expect.any(AbortSignal),expect.any(Function));expect(anchor).toHaveBeenCalledTimes(1);expect(create).toHaveBeenCalledTimes(1);expect(create.mock.calls[0][0].type).toBe('application/octet-stream');
  await act(async()=>vi.advanceTimersByTimeAsync(30000));expect(revoke).toHaveBeenCalledWith('blob:fixture');
 }finally{anchor.mockRestore();}
});
it('cancels an attachment transfer without creating a file from a late response',async()=>{
 const create=vi.fn();vi.stubGlobal('URL',Object.assign(class extends URL {},{createObjectURL:create}));let resolve!:(v:any)=>void;
 const file={id:'1.2',filename:'private.bin',contentType:'application/octet-stream',bytes:3,downloadable:true};
 vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Body',sourceVersion:'b'.repeat(64),replyTo:'',threadedReply:false});vi.mocked(mail.mailAttachments).mockResolvedValue([file]);vi.mocked(mail.downloadMailAttachment).mockImplementation((_w,_f,_id,_v,_file,_signal,progress)=>{progress?.({phase:'preparing',bytes:3});return new Promise(r=>resolve=r);});
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('Show attachments');await click('Download');expect(container.textContent).toContain('Preparing private.bin (3 bytes)');expect(container.querySelector('progress')).not.toBeNull();await click('Cancel');expect(container.querySelector('progress')).toBeNull();await act(async()=>resolve({filename:file.filename,bytes:new Uint8Array([1,2,3])}));expect(create).not.toHaveBeenCalled();
});

it('loads formatting only on request, strips unsafe content and isolates the preview',async()=>{
 vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Plain body',sourceVersion:'b'.repeat(64),replyTo:'',threadedReply:false});
 vi.mocked(mail.mailHtml).mockResolvedValue({html:'<h2>Formatted fixture</h2><img src="https://evil.test/pixel"><script>alert(1)</script><a href="https://evil.test">Link</a>',bodyAvailable:true,truncated:true});
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());expect(mail.mailHtml).not.toHaveBeenCalled();expect(container.querySelector('iframe')).toBeNull();
 await click('View formatting');const frame=container.querySelector('iframe')!;expect(frame).not.toBeNull();expect(frame.getAttribute('sandbox')).toBe('');expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');expect(frame.srcdoc).toContain('Formatted fixture');expect(frame.srcdoc).not.toContain('evil.test');expect(frame.srcdoc).not.toContain('<script>');expect(container.textContent).toContain('This preview has been shortened.');expect(container.querySelector('pre')).toBeNull();
 await click('Plain text');expect(container.querySelector('iframe')).toBeNull();expect(container.querySelector('pre')?.textContent).toBe('Plain body');
});
it('never mounts a late formatted preview after cancellation or revoked access',async()=>{
 vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'Plain',sourceVersion:'b'.repeat(64),replyTo:'',threadedReply:false});let resolve!:(v:any)=>void;
 vi.mocked(mail.mailHtml).mockImplementation(()=>new Promise(r=>resolve=r));await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('View formatting');await click('Cancel');await act(async()=>resolve({html:'<p>Late private body</p>',bodyAvailable:true,truncated:false}));expect(container.querySelector('iframe')).toBeNull();
 vi.mocked(mail.mailHtml).mockRejectedValue(new mail.MailClientError('denied'));await click('View formatting');expect(container.querySelector('iframe')).toBeNull();expect(container.querySelector('pre')).toBeNull();expect(container.textContent).not.toContain('Plain');
});

it('keeps thirty-day connections active across browser timer limits and expires at the selected deadline',async()=>{
 vi.useFakeTimers();vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['send'],expiresAt:new Date(Date.now()+30*86400000).toISOString()});await render();
 await act(async()=>vi.advanceTimersByTimeAsync(25*86400000));expect(container.textContent).toContain('fixture@bittrees.org');expect(container.textContent).not.toContain('session expired');
 await act(async()=>vi.advanceTimersByTimeAsync(5*86400000+1));expect(container.textContent).toContain('session expired');
});
it('until-revoked connections do not schedule a synthetic expiry and can still be disconnected',async()=>{
 vi.useFakeTimers();vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['send'],expiresAt:null});vi.mocked(mail.disconnectMail).mockResolvedValue(true);await render();
 await act(async()=>vi.advanceTimersByTimeAsync(500*86400000));expect(container.textContent).toContain('fixture@bittrees.org');expect(container.textContent).not.toContain('session expired');
 await click('Disconnect Mail');expect(container.textContent).not.toContain('fixture@bittrees.org');
});

const chooseFiles=async(files:File[])=>act(async()=>{const picker=container.querySelector<HTMLInputElement>('input[type=file]')!;Object.defineProperty(picker,'files',{configurable:true,value:files});picker.dispatchEvent(new Event('change',{bubbles:true}));});
const fileFixture=(name='private.txt')=>({name,size:1,arrayBuffer:async()=>new Uint8Array([120]).buffer} as File);
it('selects and removes draft files without uploading and clears them on refresh',async()=>{
 await render();await click('New email');await chooseFiles([fileFixture()]);expect(container.textContent).toContain('private.txt · 1 B');expect(mail.sendMail).not.toHaveBeenCalled();
 await click('Remove');expect(container.textContent).not.toContain('private.txt');await chooseFiles([fileFixture()]);await click('Refresh');expect(container.textContent).not.toContain('private.txt');await click('New email');expect(container.textContent).not.toContain('private.txt');
});
it('cancelled file selection cannot repopulate the next draft',async()=>{
 let finish!:(value:ArrayBuffer)=>void;await render();await click('New email');await chooseFiles([{...fileFixture(),arrayBuffer:()=>new Promise<ArrayBuffer>(r=>finish=r)} as File]);
 expect(container.querySelector<HTMLInputElement>('input[type=file]')!.disabled).toBe(true);await click('Cancel');await click('New email');await act(async()=>finish(new Uint8Array([120]).buffer));expect(container.textContent).not.toContain('private.txt');expect(mail.sendMail).not.toHaveBeenCalled();
});
it('rejects oversized selections before reading and clears files when access expires',async()=>{
 vi.useFakeTimers();vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),expiresAt:new Date(Date.now()+1000).toISOString()});await render();await click('New email');
 const read=vi.fn();await chooseFiles([{...fileFixture(),size:262145,arrayBuffer:read} as File]);expect(read).not.toHaveBeenCalled();expect(container.querySelector('[role=alert]')?.textContent).toContain('256 KiB');
 await chooseFiles([fileFixture()]);expect(container.textContent).toContain('private.txt');await act(async()=>vi.advanceTimersByTimeAsync(1001));expect(container.textContent).not.toContain('private.txt');expect(container.querySelector('input[type=file]')).toBeNull();
});
