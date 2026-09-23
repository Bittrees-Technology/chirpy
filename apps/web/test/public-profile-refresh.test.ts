import React,{act} from 'react';import {createRoot,type Root} from 'react-dom/client';
import {beforeEach,afterEach,expect,it,vi} from 'vitest';import {usePublicProfiles} from '../src/usePublicProfiles';import {readPublicProfiles} from '../src/publicProfiles';
vi.mock('../src/publicProfiles',()=>({readPublicProfiles:vi.fn(),PUBLIC_PROFILE_CHANGED:'chat:public-profile-changed'}));
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);const profile=(wallet=a,label:string|null='Name')=>({version:1 as const,wallet,revision:1,label,updatedAt:1});
let root:Root,container:HTMLDivElement,latest:Map<string,unknown>;
function Probe({wallet=a}:{wallet?:string}){latest=usePublicProfiles([wallet],true);return null;}
beforeEach(()=>{vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT',true);vi.clearAllMocks();container=document.createElement('div');root=createRoot(container);vi.mocked(readPublicProfiles).mockResolvedValue([profile()]);});
afterEach(async()=>{await act(async()=>root.unmount());vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('refreshes withdrawal and clears names on foreground return before fetching',async()=>{
 await act(async()=>root.render(React.createElement(Probe)));expect(latest.get(a)).toEqual(profile());
 let resolve!:(v:any)=>void;vi.mocked(readPublicProfiles).mockImplementationOnce(()=>new Promise(r=>resolve=r));await act(async()=>window.dispatchEvent(new Event('focus')));expect(latest.size).toBe(0);
 await act(async()=>resolve([profile(a,null)]));expect(latest.get(a)).toEqual(profile(a,null));
});
it('expires displayed names even when a refresh never resolves',async()=>{
 vi.useFakeTimers();await act(async()=>root.render(React.createElement(Probe)));expect(latest.size).toBe(1);vi.mocked(readPublicProfiles).mockImplementation(()=>new Promise(()=>{}));
 await act(async()=>vi.advanceTimersByTimeAsync(40001));expect(latest.size).toBe(0);
});
it('drops stale responses when visible identities change and cancels work on unmount',async()=>{
 let old!:(v:any)=>void;vi.mocked(readPublicProfiles).mockImplementationOnce(()=>new Promise(r=>old=r));await act(async()=>root.render(React.createElement(Probe)));
 const signal=vi.mocked(readPublicProfiles).mock.calls[0][1]!;vi.mocked(readPublicProfiles).mockResolvedValueOnce([profile(b,'Other')]);await act(async()=>root.render(React.createElement(Probe,{wallet:b})));expect(signal.aborted).toBe(true);
 await act(async()=>old([profile()]));expect([...latest.keys()]).toEqual([b]);const current=vi.mocked(readPublicProfiles).mock.calls[1][1]!;await act(async()=>root.render(null));expect(current.aborted).toBe(true);
});
