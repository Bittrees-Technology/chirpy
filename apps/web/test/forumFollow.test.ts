import {describe,it,expect,beforeEach,vi} from 'vitest';
import {forumKey,readForumPreference,parseForumItems} from '../src/forumFollow';
import React,{act} from 'react';import {createRoot} from 'react-dom/client';import {useForumFollow} from '../src/forumFollow';
const a='0x'+'1'.repeat(40),b='0x'+'2'.repeat(40);
beforeEach(()=>{localStorage.clear();vi.restoreAllMocks();});
describe('forum subscriptions',()=>{
 it('isolates wallet preferences and preserves corrupt records',()=>{
  localStorage.setItem(forumKey(a),JSON.stringify({following:true,seen:1,since:1}));expect(readForumPreference(a).following).toBe(true);expect(readForumPreference(b).following).toBe(false);
  localStorage.setItem(forumKey(b),'broken');expect(()=>readForumPreference(b)).toThrow();expect(localStorage.getItem(forumKey(b))).toBe('broken');
 });
 it('rejects arbitrary destinations and invalid timestamps from the public feed',()=>{
  const id='0x'+'a'.repeat(64),row={id,title:'Discussion',time:1,url:'https://gov.bittrees.org/forum/'+id};expect(parseForumItems([row])).toEqual([row]);
  expect(()=>parseForumItems([{...row,url:'https://evil.test'}])).toThrow();expect(()=>parseForumItems([{...row,time:NaN}])).toThrow();
 });
 it('follows, marks read, unfollows and resets on wallet change without sending messages',async()=>{
  const host=document.createElement('div'),root=createRoot(host);let state:ReturnType<typeof useForumFollow>;
  const id='0x'+'a'.repeat(64),time=Math.floor(Date.now()/1000)+1;
  vi.stubGlobal('fetch',vi.fn().mockResolvedValue({ok:true,json:async()=>({items:[{id,title:'New',time,url:'https://gov.bittrees.org/forum/'+id}]})}));
  function Harness({wallet}:{wallet:string}){state=useForumFollow(wallet,true);return null;}
  try{
   await act(async()=>root.render(React.createElement(Harness,{wallet:a})));expect(state!.prefs.following).toBe(false);
   await act(async()=>state!.follow());expect(state!.prefs.following).toBe(true);expect(state!.unread).toBe(1);
   await act(async()=>state!.markRead());expect(state!.unread).toBe(0);
   await act(async()=>root.render(React.createElement(Harness,{wallet:b})));expect(state!.prefs.following).toBe(false);expect(state!.items).toEqual([]);
   await act(async()=>root.render(React.createElement(Harness,{wallet:a})));expect(state!.prefs.following).toBe(true);
   await act(async()=>state!.unfollow());expect(state!.items).toEqual([]);expect(readForumPreference(a).following).toBe(false);
  }finally{await act(async()=>root.unmount());vi.unstubAllGlobals();}
 });
});
