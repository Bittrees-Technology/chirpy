import { expect, it } from 'vitest';
import { editSyncPayloadV2 as edit, mergeSyncPayloadV2 as merge, parseSyncPayloadV2 as parse, syncPayloadV2View as view, upgradeSyncPayloadV1 as upgrade } from '../src/versionedSync';
const a='0x'+'a'.repeat(40), b='0x'+'b'.repeat(40), receipt='xmtp:dev:conversation';
const legacy=(patch={})=>({version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,readReceiptOverrides:{[receipt]:true},blocked:[a]},savedMessages:[{id:'m1',body:'saved',custom:{b:[1,true],a:'retained'}}],updatedAt:10,...patch});
const base=()=>upgrade(legacy());
it('upgrades legacy data without losing arbitrary JSON fields, uses stable per-item times and never mutates inputs',()=>{
  const source=legacy(),copy=JSON.stringify(source),result=upgrade(source);
  expect(result.savedMessages.m1.updatedAt).toBe(10);expect(result.savedMessages.m1.value).toEqual(source.savedMessages[0]);expect(view(result).settingsPrefs).toEqual(source.settingsPrefs);expect(JSON.stringify(source)).toBe(copy);
  const withTimes=upgrade(legacy({savedMessages:[{id:'m1',body:'new',updatedAt:20},{id:'m1',body:'old',updatedAt:2},{id:'m2',custom:'no-time'}]}));
  expect(withTimes.savedMessages.m1.updatedAt).toBe(20);expect(withTimes.savedMessages.m2.updatedAt).toBe(10);expect(withTimes.updatedAt).toBe(20);
});
it('explicit delete, unblock and reset survive replay of an older offline snapshot',()=>{
  const old=base();let current=edit(old,{kind:'savedMessage',id:'m1',value:null},20);
  current=edit(current,{kind:'block',address:a,value:false},21);current=edit(current,{kind:'readReceiptOverride',key:receipt,value:null},22);
  const merged=merge(old,current);expect(merge(current,old)).toEqual(merged);
  expect(view(merged).savedMessages).toEqual([]);expect(view(merged).settingsPrefs.blocked).toEqual([]);expect(view(merged).settingsPrefs.readReceiptOverrides).toEqual({});
  expect(merged.savedMessages.m1).toEqual({updatedAt:20,value:null});expect(merged.blocked[a]).toEqual({updatedAt:21,value:false});expect(merged.readReceiptOverrides[receipt]).toEqual({updatedAt:22,value:null});
  expect(view(merge(merged,old))).toEqual(view(merged));
});
it('merges independent edits without letting an unrelated later preference edit resurrect a message',()=>{
  const old=base(),deleted=edit(old,{kind:'savedMessage',id:'m1',value:null},20),other=edit(old,{kind:'readReceiptsDefault',value:true},30);
  const result=merge(deleted,other);expect(view(result).savedMessages).toEqual([]);expect(view(result).settingsPrefs.readReceiptsDefault).toBe(true);
  expect(result.savedMessages.m1.updatedAt).toBe(20);
});
it('permits a later explicit recreation, reblock or receipt selection, and advances safely during clock rollback',()=>{
  let result=edit(base(),{kind:'savedMessage',id:'m1',value:null},20);
  result=edit(result,{kind:'savedMessage',id:'m1',value:{id:'m1',body:'explicit recreation'}},1);
  expect(result.savedMessages.m1.updatedAt).toBe(21);expect(view(result).savedMessages[0].body).toBe('explicit recreation');
  result=edit(result,{kind:'block',address:a,value:false},1);result=edit(result,{kind:'block',address:a,value:true},1);expect(view(result).settingsPrefs.blocked).toEqual([a]);
});
it('equal-time conflicts keep receipts off, blocks on and saved-message deletion, independent of ordering',()=>{
  const source=base(),deleted=edit(source,{kind:'savedMessage',id:'m1',value:null},20),replaced=edit(source,{kind:'savedMessage',id:'m1',value:{id:'m1',body:'edit'}},20);
  expect(merge(deleted,replaced).savedMessages.m1.value).toBe(null);
  const blocked=edit(source,{kind:'block',address:a,value:true},20),unblocked=edit(source,{kind:'block',address:a,value:false},20);expect(merge(blocked,unblocked).blocked[a].value).toBe(true);
  const on=edit(source,{kind:'readReceiptOverride',key:receipt,value:true},20),reset=edit(source,{kind:'readReceiptOverride',key:receipt,value:null},20);
  expect(merge(on,reset).readReceiptOverrides[receipt].value).toBe(false);expect(merge(reset,on)).toEqual(merge(on,reset));
});
it('resolves equal-time differing message fields canonically and preserves prototype-like IDs as data',()=>{
  const source=base(),left=edit(source,{kind:'savedMessage',id:'__proto__',value:JSON.parse('{"id":"__proto__","__proto__":{"safe":true},"value":"a"}')},20);
  const right=edit(source,{kind:'savedMessage',id:'__proto__',value:{value:'b',id:'__proto__'}},20);
  expect(merge(left,right)).toEqual(merge(right,left));expect(Object.hasOwn(left.savedMessages,'__proto__')).toBe(true);expect(({} as any).safe).toBeUndefined();
  expect(parse(JSON.parse(JSON.stringify(left)))).toEqual(parse(left));
});
it('does not interpret absent collection entries as deletions or mutate either merge input',()=>{
  const a=base(),b=upgrade(legacy({savedMessages:[],settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]}}));
  const copyA=JSON.stringify(a),copyB=JSON.stringify(b);expect(view(merge(a,b)).savedMessages).toHaveLength(1);expect(view(merge(a,b)).settingsPrefs.blocked).toHaveLength(1);
  expect(JSON.stringify(a)).toBe(copyA);expect(JSON.stringify(b)).toBe(copyB);
});
it('has idempotent, commutative and associative merge laws across deterministic concurrent edit histories',()=>{
  let seed=7;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  const history=()=>{let state=base();for(let i=0;i<5;i++){const choice=random()%6,at=10+random()%20;state=choice===0?edit(state,{kind:'readReceiptsDefault',value:Boolean(random()%2)},at):choice===1?edit(state,{kind:'syncAcrossDevices',value:Boolean(random()%2)},at):choice===2?edit(state,{kind:'block',address:random()%2?a:b,value:Boolean(random()%2)},at):choice===3?edit(state,{kind:'readReceiptOverride',key:receipt,value:[true,false,null][random()%3]},at):edit(state,{kind:'savedMessage',id:'m1',value:choice===4?null:{id:'m1',body:String(random()%5)}},at);}return state;};
  for(let i=0;i<80;i++){const a=history(),b=history(),c=history();expect(merge(a,a)).toEqual(a);expect(merge(a,b)).toEqual(merge(b,a));expect(merge(merge(a,b),c)).toEqual(merge(a,merge(b,c)));}
});
it.each(['unknown-field','clock','bad-stamp','wrong-message-id','bad-wallet','bad-receipt','unsafe-json'])('rejects %s without dropping malformed content',kind=>{
  const value:any=base();
  if(kind==='unknown-field')value.extra=true;if(kind==='clock')value.updatedAt++;if(kind==='bad-stamp')value.readReceiptsDefault.extra=true;
  if(kind==='wrong-message-id')value.savedMessages.m1.value.id='different';if(kind==='bad-wallet')value.blocked.bad={value:true,updatedAt:10};
  if(kind==='bad-receipt')value.readReceiptOverrides.bad={value:false,updatedAt:10};if(kind==='unsafe-json')value.savedMessages.m1.value.numeric=Infinity;
  expect(()=>parse(value)).toThrow();
});
it('fails closed on byte/collection/clock exhaustion and unsupported legacy structures',()=>{
  expect(()=>edit(base(),{kind:'savedMessage',id:'m1',value:{id:'m1',body:'a'.repeat(300000)}},20)).toThrow();
  expect(()=>upgrade(legacy({savedMessages:Array.from({length:10001},()=>({id:'m1'}))}))).toThrow();
  const exhausted=edit(base(),{kind:'readReceiptsDefault',value:false},Number.MAX_SAFE_INTEGER-1);expect(()=>edit(exhausted,{kind:'readReceiptsDefault',value:true},0)).toThrow();
  for(const input of [null,{...legacy(),version:3},{...legacy(),extra:true},legacy({savedMessages:[{id:'m1',updatedAt:'bad'}]})])expect(()=>upgrade(input)).toThrow();
});
it('keeps equal-clock joins associative for every receipt reset/off/on and saved-message deletion tie',()=>{
  const receipts=[true,false,null].map(value=>edit(base(),{kind:'readReceiptOverride',key:receipt,value},20));
  const messages=[null,{id:'m1',body:'a'},{id:'m1',body:'b'}].map(value=>edit(base(),{kind:'savedMessage',id:'m1',value},20));
  for(const states of [receipts,messages])for(const a of states)for(const b of states)for(const c of states){expect(merge(merge(a,b),c)).toEqual(merge(a,merge(b,c)));expect(merge(a,b)).toEqual(merge(b,a));}
});
