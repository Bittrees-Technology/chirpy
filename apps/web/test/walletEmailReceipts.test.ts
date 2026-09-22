import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {readWalletEmailRecovery,reserveWalletEmailReceipt,finishWalletEmailReceipt,walletEmailReceiptKey,walletEmailLegacyReceiptKey} from '../src/walletEmailReceipts';
import type {MailCommand} from '../../../packages/core/src/mailAuth.js';
const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/mail';
const key=walletEmailReceiptKey(wallet,service),legacy=walletEmailLegacyReceiptKey(wallet);
let storage:Map<string,string>;
const command=(id='a'.repeat(32)):MailCommand=>({action:'send',wallet,service,id,to:'fixture@example.com',subject:'Private subject',text:'Private text',expiresAt:Date.now()+60000});
beforeEach(()=>{storage=new Map();vi.stubGlobal('localStorage',{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>storage.set(k,v),removeItem:(k:string)=>storage.delete(k)});});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();});
it('reserves an ID before use, stores no raw email and permits only exact-content retries',async()=>{
 const c=command();await reserveWalletEmailReceipt(c,false);expect(readWalletEmailRecovery(wallet,service).active).toBe(c.id);
 expect(JSON.stringify([...storage])).not.toMatch(/Private|fixture@example/);
 await reserveWalletEmailReceipt({...c,expiresAt:Date.now()+90000},true);
 for(const patch of [{text:'changed'},{subject:'changed'},{to:'changed@example.com'},{id:'b'.repeat(32)}])await expect(reserveWalletEmailReceipt({...c,...patch},true)).rejects.toMatchObject({code:'pending'});
});
it('serializes competing reservations so only one request becomes active',async()=>{
 const result=await Promise.allSettled([reserveWalletEmailReceipt(command(),false),reserveWalletEmailReceipt(command('b'.repeat(32)),false)]);
 expect(result.filter(r=>r.status==='fulfilled')).toHaveLength(1);
 const state=readWalletEmailRecovery(wallet,service);expect(state.receipts).toHaveLength(1);expect(state.active).toBe(state.receipts[0].id);
});
it('retains legacy IDs without rewriting them and never resurrects an archived legacy selection',async()=>{
 storage.set(legacy,'c'.repeat(32));expect(readWalletEmailRecovery(wallet,service).active).toBe('c'.repeat(32));
 await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'pending'});
 await finishWalletEmailReceipt(wallet,service,'c'.repeat(32));await reserveWalletEmailReceipt(command(),false);
 expect(storage.get(legacy)).toBe('c'.repeat(32));expect(readWalletEmailRecovery(wallet,service).receipts.map(r=>r.id)).toEqual(['c'.repeat(32),'a'.repeat(32)]);
});
it('never lets a stale tab clear or retry over a newer active request',async()=>{
 await reserveWalletEmailReceipt(command(),false);await finishWalletEmailReceipt(wallet,service,'a'.repeat(32));await reserveWalletEmailReceipt(command('b'.repeat(32)),false);
 await expect(finishWalletEmailReceipt(wallet,service,'a'.repeat(32))).rejects.toMatchObject({code:'pending'});
 await expect(reserveWalletEmailReceipt(command(),true)).rejects.toMatchObject({code:'pending'});
 expect(readWalletEmailRecovery(wallet,service).active).toBe('b'.repeat(32));
 expect(readWalletEmailRecovery(wallet,service).receipts).toHaveLength(2);
});
it.each(['read','write','readback'])('refuses storage %s failures without deleting recovery data',async(failure)=>{
 if(failure==='read')vi.spyOn(localStorage,'getItem').mockImplementation(()=>{throw Error();});
 if(failure==='write')vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error();});
 if(failure==='readback')vi.spyOn(localStorage,'setItem').mockImplementation(()=>{});
 await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'storage'});expect(storage.has(key)).toBe(false);
});
it('keeps a reservation written just before a storage error and refuses a second new ID',async()=>{
 const spy=vi.spyOn(localStorage,'setItem').mockImplementation((k,v)=>{storage.set(k,v);throw Error('interrupted');});
 await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'storage'});spy.mockRestore();
 expect(readWalletEmailRecovery(wallet,service).active).toBe(command().id);
 await expect(reserveWalletEmailReceipt(command('b'.repeat(32)),false)).rejects.toMatchObject({code:'pending'});
});
it.each(['not-json',JSON.stringify({version:2,active:null,receipts:[]}),JSON.stringify({version:1,active:'a'.repeat(32),receipts:[]}),JSON.stringify({version:1,active:null,receipts:[{id:'a'.repeat(32),digest:null,createdAt:null},{id:'a'.repeat(32),digest:null,createdAt:null}]})])('preserves malformed records instead of replacing them',async(raw)=>{
 storage.set(key,raw);await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'storage'});expect(storage.get(key)).toBe(raw);
});
it('keeps malformed legacy input and checks wallet and service isolation',async()=>{
 storage.set(legacy,'invalid');await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'storage'});expect(storage.get(legacy)).toBe('invalid');storage.delete(legacy);
 await reserveWalletEmailReceipt(command(),false);
 expect(readWalletEmailRecovery('0x'+'2'.repeat(40),service).receipts).toHaveLength(0);
 expect(readWalletEmailRecovery(wallet,'https://other.example/api/mail').receipts).toHaveLength(0);
});
it('does not silently evict old IDs at the recovery limit',async()=>{
 const receipts=Array.from({length:100},(_,i)=>({id:i.toString(16).padStart(32,'0'),digest:null,createdAt:null}));
 const raw=JSON.stringify({version:1,active:null,receipts});storage.set(key,raw);
 await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'limit'});expect(storage.get(key)).toBe(raw);
});
it('refuses missing locks or cancelled reservations before changing storage',async()=>{
 const c=new AbortController();c.abort();await expect(reserveWalletEmailReceipt(command(),false,c.signal)).rejects.toThrow();expect(storage.size).toBe(0);
 Object.defineProperty(navigator,'locks',{configurable:true,value:undefined});await expect(reserveWalletEmailReceipt(command(),false)).rejects.toMatchObject({code:'storage'});expect(storage.size).toBe(0);
});

it('never renews the original retry deadline or resends after it expires',async()=>{
 const time=Date.now();vi.useFakeTimers();vi.setSystemTime(time);const c=command();await reserveWalletEmailReceipt(c,false);
 vi.setSystemTime(time+22*3600000);await reserveWalletEmailReceipt({...c,expiresAt:Date.now()+60000},true);expect(readWalletEmailRecovery(wallet,service).receipts[0].createdAt).toBe(time);
 vi.setSystemTime(time+23*3600000);await expect(reserveWalletEmailReceipt({...c,expiresAt:Date.now()+60000},true)).rejects.toMatchObject({code:'expired'});
 vi.setSystemTime(time+31*86400000);await expect(reserveWalletEmailReceipt({...c,expiresAt:Date.now()+60000},true)).rejects.toMatchObject({code:'expired'});
 vi.setSystemTime(time-1);await expect(reserveWalletEmailReceipt({...c,expiresAt:Date.now()+60000},true)).rejects.toMatchObject({code:'expired'});
 expect(readWalletEmailRecovery(wallet,service).active).toBe(c.id);
});
