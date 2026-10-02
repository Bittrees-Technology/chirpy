import {useEffect,useState} from 'react';
export interface ForumItem {id:string;title:string;time:number;url:string}
export interface ForumPreference {following:boolean;seen:number;since:number}
export const forumKey=(wallet:string)=>{
 if(!/^0x[\da-f]{40}$/i.test(wallet))throw Error('Connect a wallet to follow the forum.');
 return `chat:forum-follow:v1:${wallet.toLowerCase()}`;
};
export function readForumPreference(wallet:string):ForumPreference{
 const raw=localStorage.getItem(forumKey(wallet));if(!raw)return {following:false,seen:0,since:0};
 const v=JSON.parse(raw);
 if(typeof v.following!=='boolean'||!Number.isSafeInteger(v.seen)||v.seen<0||!Number.isSafeInteger(v.since)||v.since<0)throw Error('Forum preferences could not be read. Existing data was preserved.');
 return v;
}
export function parseForumItems(value:unknown):ForumItem[]{
 if(!Array.isArray(value)||value.length>100)throw Error('Invalid forum response');
 return value.map(v=>{
  if(!v||!/^0x[\da-f]{64}$/i.test(v.id)||typeof v.title!=='string'||v.title.length>120||!Number.isSafeInteger(v.time)||v.time<0||v.url!==`https://gov.bittrees.org/forum/${v.id}`)throw Error('Invalid forum response');
  return {id:v.id,title:v.title,time:v.time,url:v.url};
 });
}
export function useForumFollow(wallet:string,enabled:boolean){
 const [prefs,setPrefs]=useState<ForumPreference>({following:false,seen:0,since:0});
 const [items,setItems]=useState<ForumItem[]>([]),[error,setError]=useState(''),[loaded,setLoaded]=useState(false);
 useEffect(()=>{
  setItems([]);setError('');setLoaded(false);setPrefs({following:false,seen:0,since:0});
  if(!enabled)return;
  const read=()=>{try{setPrefs(readForumPreference(wallet));setLoaded(true);setError('');}catch(e){setLoaded(false);setError((e as Error).message);}};
  read();const listener=(e:StorageEvent)=>{if(e.key===forumKey(wallet)||e.key===null)read();};window.addEventListener('storage',listener);return()=>window.removeEventListener('storage',listener);
 },[wallet,enabled]);
 useEffect(()=>{
  if(!enabled||!loaded||!prefs.following)return;
  const controller=new AbortController();let running=false;
  const refresh=async()=>{if(running||document.visibilityState==='hidden')return;running=true;try{
   const r=await fetch('https://gov.bittrees.org/api/forum-feed',{signal:controller.signal,credentials:'omit',referrerPolicy:'no-referrer'});if(!r.ok)throw Error('Forum updates are temporarily unavailable.');
   const data=await r.json(),list=parseForumItems(data.items);if(!controller.signal.aborted){setItems(list);setError('');}
  }catch(e){if(!controller.signal.aborted)setError((e as Error).message);}finally{running=false;}};
  void refresh();const timer=setInterval(()=>void refresh(),60000);document.addEventListener('visibilitychange',refresh);
  return()=>{controller.abort();clearInterval(timer);document.removeEventListener('visibilitychange',refresh);};
 },[wallet,enabled,loaded,prefs.following]);
 function update(following:boolean,read=false){
  if(!enabled||!loaded)return;
  try{const current=readForumPreference(wallet),time=Math.floor(Date.now()/1000);const next={following,since:following&&!current.following?time:current.since,seen:read?Math.max(current.seen,...items.map(i=>i.time)):current.seen};localStorage.setItem(forumKey(wallet),JSON.stringify(next));setPrefs(next);setError('');if(!following)setItems([]);}catch(e){setError((e as Error).message);}
 }
 const updates=items.filter(i=>i.time>=prefs.since);
 return {prefs,items:updates,error,loaded,enabled,unread:updates.filter(i=>i.time>prefs.seen).length,follow:()=>update(true),unfollow:()=>update(false),markRead:()=>update(true,true)};
}
