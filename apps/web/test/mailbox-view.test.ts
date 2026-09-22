import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {Mailbox} from '../src/views/Mailbox';
import {I18nProvider} from '../src/i18n';
import * as mail from '../src/connectedMail';
const state=vi.hoisted(()=>({identity:{address:'0x'+'1'.repeat(40)},mode:'wallet'}));
vi.mock('../src/state',()=>({useIdentity:()=>state}));
vi.mock('../src/connectedMail',async original=>({...await original<any>(),mailStatus:vi.fn(),mailFolders:vi.fn(),mailMessages:vi.fn(),mailMessage:vi.fn(),disconnectMail:vi.fn(),mailReceipt:vi.fn(()=>null)}));
let container:HTMLDivElement,root:Root;
const connection=()=>({mailbox:'fixture@bittrees.org',scopes:['read','send'] as ('read'|'send')[],expiresAt:new Date(Date.now()+3600000).toISOString()});
const item={id:'a'.repeat(64),from:'Fixture <fixture@bittrees.org>',subject:'Acceptance fixture',date:'Today'};
const render=()=>act(async()=>root.render(React.createElement(I18nProvider,null,React.createElement(Mailbox,{key:state.identity.address,onOpenSettings:()=>{}}))));
const click=async(text:string)=>{const button=[...container.querySelectorAll('button')].find(b=>b.textContent===text);expect(button).toBeDefined();await act(async()=>button!.click());};
beforeEach(()=>{
 vi.clearAllMocks();vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{}});
 state.identity={address:'0x'+'1'.repeat(40)};state.mode='wallet';
 vi.mocked(mail.mailStatus).mockResolvedValue(connection());vi.mocked(mail.mailFolders).mockResolvedValue(['INBOX','Sent']);vi.mocked(mail.mailMessages).mockResolvedValue([item]);vi.mocked(mail.mailMessage).mockResolvedValue({...item,text:'<img src=x onerror=alert(1)> private fixture'});vi.mocked(mail.mailReceipt).mockReturnValue(null);
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
 vi.mocked(mail.mailMessages).mockRejectedValue(new mail.MailClientError('denied'));
 await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(container.textContent).not.toContain('private fixture');expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('does not have permission');
});
it('expiry clears rendered content and pending sends prevent composing after remount',async()=>{
 vi.useFakeTimers();vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),expiresAt:new Date(Date.now()+1000).toISOString()});
 vi.mocked(mail.mailReceipt).mockReturnValue({id:'b'.repeat(64),createdAt:Date.now()});await render();
 expect([...container.querySelectorAll('button')].find(b=>b.textContent==='New email')?.disabled).toBe(true);expect(container.textContent).toContain('Check your previous send');
 await act(async()=>vi.advanceTimersByTimeAsync(1001));expect(container.textContent).not.toContain(item.subject);expect(container.textContent).toContain('session expired');
});
it('does not poll while composing or while the page is hidden',async()=>{
 vi.useFakeTimers();Object.defineProperty(document,'visibilityState',{configurable:true,value:'hidden'});await render();await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(mail.mailMessages).toHaveBeenCalledTimes(1);
 Object.defineProperty(document,'visibilityState',{configurable:true,value:'visible'});await click('New email');await act(async()=>vi.advanceTimersByTimeAsync(45000));expect(mail.mailMessages).toHaveBeenCalledTimes(1);
});
it('cancelled reads cannot reveal a late response',async()=>{
 let resolve!:(value:mail.MailMessage)=>void;vi.mocked(mail.mailMessage).mockImplementation(()=>new Promise(r=>resolve=r));
 await render();await act(async()=>container.querySelector<HTMLButtonElement>('.mailbox-row')!.click());await click('Cancel');
 await act(async()=>resolve({...item,text:'cancelled private content'}));expect(container.textContent).not.toContain('cancelled private content');
});
it('send-only consent does not request folders or messages',async()=>{
 vi.mocked(mail.mailStatus).mockResolvedValue({...connection(),scopes:['send']});await render();
 expect(mail.mailFolders).not.toHaveBeenCalled();expect(mail.mailMessages).not.toHaveBeenCalled();expect(container.textContent).toContain('allows sending only');
});
