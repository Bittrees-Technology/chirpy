import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {snapshotWalletEmailRecovery,readWalletEmailRecovery,reserveWalletEmailReceipt,finishWalletEmailReceipt,walletEmailReceiptKey,walletEmailLegacyReceiptKey} from '../src/walletEmailReceipts';
import {mergeWalletEmailArchive,restoreWalletEmailArchive,pruneBackedUpWalletEmailIds,removableWalletEmailIds} from '../src/walletEmailArchiveStorage';
const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/mail',a='a'.repeat(32),b='b'.repeat(32),c='c'.repeat(32);
const key=walletEmailReceiptKey(wallet,service),legacy=walletEmailLegacyReceiptKey(wallet);
let storage:Map<string,string>;
const snapshot=()=>snapshotWalletEmailRecovery(wallet,service),check=()=>{};
const data=()=>({version:1 as const,wallet,service,createdAt:Date.now(),active:a,ids:[a,b]});
const command=(id=a)=>({action:'send' as const,wallet,service,id,to:'fixture@example.com',subject:'Fixture',text:'Fixture',expiresAt:Date.now()+60000});
beforeEach(()=>{storage=new Map();vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v)});});
afterEach(()=>{vi.unstubAllGlobals();vi.restoreAllMocks();});
it('restores lookup-only IDs and never creates resend authority or a renewed clock',async()=>{
 await restoreWalletEmailArchive(data(),wallet,service,snapshot().revision,check);
 expect(readWalletEmailRecovery(wallet,service)).toEqual({version:1,active:a,receipts:[{id:a,digest:null,createdAt:null},{id:b,digest:null,createdAt:null}]});
 await expect(reserveWalletEmailReceipt(command(),true)).rejects.toMatchObject({code:'pending'});
 const before=snapshot();await restoreWalletEmailArchive(data(),wallet,service,before.revision,check);expect(snapshot()).toEqual(before);
});
it('preserves original local retry metadata and gives a newer local active request priority',async()=>{
 await reserveWalletEmailReceipt(command(),false);await finishWalletEmailReceipt(wallet,service,a);await reserveWalletEmailReceipt(command(c),false);
 const before=snapshot();await restoreWalletEmailArchive(data(),wallet,service,before.revision,check);
 const state=readWalletEmailRecovery(wallet,service);expect(state.active).toBe(c);expect(state.receipts.slice(0,2)).toEqual(before.state.receipts);expect(state.receipts[2]).toEqual({id:b,digest:null,createdAt:null});
});
it('requires unchanged reviewed state and serializes competing restores',async()=>{
 const before=snapshot();const result=await Promise.allSettled([restoreWalletEmailArchive(data(),wallet,service,before.revision,check),restoreWalletEmailArchive({...data(),ids:[c],active:c},wallet,service,before.revision,check)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(snapshot().state.receipts.map(r=>r.id)).toEqual([a,b]);
 await expect(pruneBackedUpWalletEmailIds(wallet,service,before.revision,check)).rejects.toMatchObject({code:'pending'});
});
it('does not evict local IDs to make room for an archive',()=>{
 const receipts=Array.from({length:100},(_,i)=>({id:i.toString(16).padStart(32,'0'),digest:null,createdAt:null}));const raw=JSON.stringify({version:1,active:null,receipts});storage.set(key,raw);
 expect(()=>mergeWalletEmailArchive(snapshot(),data(),wallet,service)).toThrow('limit');expect(storage.get(key)).toBe(raw);
});
it('removes only backed-up history while preserving the active and legacy IDs and their metadata',async()=>{
 storage.set(legacy,b);await finishWalletEmailReceipt(wallet,service,b);await reserveWalletEmailReceipt(command(),false);await finishWalletEmailReceipt(wallet,service,a);await reserveWalletEmailReceipt(command(c),false);
 const before=snapshot();expect(removableWalletEmailIds(before)).toEqual([a]);await pruneBackedUpWalletEmailIds(wallet,service,before.revision,check);
 expect(snapshot().state).toEqual({...before.state,receipts:before.state.receipts.filter(r=>r.id!==a)});expect(storage.get(legacy)).toBe(b);
 await restoreWalletEmailArchive(data(),wallet,service,snapshot().revision,check);expect(snapshot().state.receipts.find(r=>r.id===a)).toEqual({id:a,digest:null,createdAt:null});expect(snapshot().state.active).toBe(c);
});
it('refuses malformed storage, revoked proof and cancelled work without overwriting data',async()=>{
 storage.set(key,'broken');await expect(restoreWalletEmailArchive(data(),wallet,service,'stale',check)).rejects.toThrow();expect(storage.get(key)).toBe('broken');storage.delete(key);
 await expect(restoreWalletEmailArchive(data(),wallet,service,snapshot().revision,()=>{throw Error('revoked');})).rejects.toThrow('revoked');expect(storage.size).toBe(0);
 const controller=new AbortController();controller.abort();await expect(restoreWalletEmailArchive(data(),wallet,service,snapshot().revision,check,controller.signal)).rejects.toThrow();expect(storage.size).toBe(0);
});
it('fails on storage writes and readback failures, preserving interrupted successful imports for review',async()=>{
 const revision=snapshot().revision;const spy=vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('quota');});
 await expect(restoreWalletEmailArchive(data(),wallet,service,revision,check)).rejects.toThrow();expect(storage.size).toBe(0);
 spy.mockImplementation(()=>{});await expect(restoreWalletEmailArchive(data(),wallet,service,revision,check)).rejects.toThrow();expect(storage.size).toBe(0);
 spy.mockImplementation((k,v)=>{storage.set(k,v);throw Error('interrupted');});await expect(restoreWalletEmailArchive(data(),wallet,service,revision,check)).rejects.toThrow();spy.mockRestore();expect(snapshot().state.receipts.map(r=>r.id)).toEqual([a,b]);
});
it('includes legacy-slot changes in the revision and rechecks proof after computing the change',async()=>{
 const before=snapshot();storage.set(legacy,c);await expect(restoreWalletEmailArchive(data(),wallet,service,before.revision,check)).rejects.toThrow();expect(storage.has(key)).toBe(false);
 const proof=vi.fn().mockImplementationOnce(()=>{}).mockImplementationOnce(()=>{throw Error('expired');});await expect(restoreWalletEmailArchive(data(),wallet,service,snapshot().revision,proof)).rejects.toThrow('expired');expect(storage.has(key)).toBe(false);
});
