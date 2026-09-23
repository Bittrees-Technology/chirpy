import {setActiveProvider,clearActiveProvider} from '../src/walletProviders';
import React,{act} from 'react';
import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {HistorySession} from '../src/views/InboundHistory';
import {I18nProvider} from '../src/i18n';
import {inboundHistoryAvailable,requestInboundHistory} from '../src/inboundHistory';
vi.mock('../src/inboundHistory',()=>({inboundHistoryAvailable:vi.fn(),requestInboundHistory:vi.fn()}));
const wallet='0x'+'1'.repeat(40),id='a'.repeat(64),cursor='b'.repeat(64),record={id,status:'uncertain' as const,createdAt:1700000000000,updatedAt:1700000001000,deadline:1700000060000,attempts:1};
let root:Root,container:HTMLDivElement;const listeners=new Map<string,Set<()=>void>>();
const render=(key='first')=>act(async()=>root.render(React.createElement(React.StrictMode,null,React.createElement(I18nProvider,null,React.createElement(HistorySession,{key,wallet})))));
const button=(name:string)=>[...container.querySelectorAll('button')].find(b=>b.textContent===name)!;
const click=(name:string)=>act(async()=>button(name).click());
beforeEach(()=>{vi.clearAllMocks();listeners.clear();setActiveProvider({request:async()=>[wallet],on:(event,fn)=>{const set=listeners.get(event)??new Set();set.add(fn as ()=>void);listeners.set(event,set);},removeListener:(event,fn)=>listeners.get(event)?.delete(fn as ()=>void)},'injected');vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.mocked(inboundHistoryAvailable).mockResolvedValue(true);vi.mocked(requestInboundHistory).mockResolvedValue({records:[record],nextCursor:null});container=document.createElement('div');document.body.append(container);root=createRoot(container);});
afterEach(async()=>{await act(async()=>root.unmount());container.remove();clearActiveProvider();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('labels uncertain publication honestly and exposes no retry or sending action',async()=>{
 await render();const writes=vi.spyOn(Storage.prototype,'setItem');await click('Check incoming forwarding');expect(writes).not.toHaveBeenCalled();expect(container.textContent).toContain('Publication is uncertain');expect(container.textContent).toContain('Do not resend automatically');expect(container.textContent).toContain('not messages sent');expect([...container.querySelectorAll('button')].map(b=>b.textContent)).toEqual(['Check incoming forwarding']);
});
it('separately signs pages and clears earlier evidence on failure',async()=>{
 vi.mocked(requestInboundHistory).mockResolvedValueOnce({records:[record],nextCursor:cursor});await render();await click('Check incoming forwarding');
 vi.mocked(requestInboundHistory).mockRejectedValueOnce(Error('changed'));await click('Older requests');expect(vi.mocked(requestInboundHistory).mock.calls[1][0].cursor).toBe(cursor);expect(container.querySelector('code')).toBeNull();expect(container.textContent).toContain('History could not be checked');
});
it('drops pending results when the session changes and does not persist history',async()=>{
 let resolve!:(value:any)=>void;vi.mocked(requestInboundHistory).mockImplementationOnce(()=>new Promise(r=>resolve=r));await render();await click('Check incoming forwarding');const signal=vi.mocked(requestInboundHistory).mock.calls[0][1]!;
 await render('replacement');expect(signal.aborted).toBe(true);await act(async()=>resolve({records:[record],nextCursor:null}));expect(container.querySelector('code')).toBeNull();
});
it('hides unavailable capability and treats an empty page as missing evidence',async()=>{
 vi.mocked(inboundHistoryAvailable).mockResolvedValue(false);await render();expect(container.textContent).toBe('');vi.mocked(inboundHistoryAvailable).mockResolvedValue(true);await render('available');vi.mocked(requestInboundHistory).mockResolvedValue({records:[],nextCursor:null});await click('Check incoming forwarding');expect(container.textContent).toContain('does not prove that no message was published');
});

it.each(['accountsChanged','disconnect','session_delete'])('clears displayed snapshots on %s even before identity state changes',async event=>{
 await render();await click('Check incoming forwarding');expect(container.querySelector('code')).not.toBeNull();await act(async()=>{listeners.get(event)?.forEach(fn=>fn());});expect(container.querySelector('code')).toBeNull();expect(container.textContent).toContain('History could not be checked');
});
