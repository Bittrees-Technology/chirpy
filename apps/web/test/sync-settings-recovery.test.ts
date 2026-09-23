import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { defaultSettings, loadSettings, saveSettings, saveSyncedSettings, serializeSettings, parseSettingsRaw, applySyncPreferences } from '../src/settingsStorage';
import { editSyncPayloadV2 as edit, mergeSyncPayloadV2 as merge, syncPayloadV2View as view, upgradeSyncPayloadV1 as upgrade } from '../src/versionedSync';
import { backupArchive, undoSyncSettings, validateJournal } from '../src/recoveryJournal';
import { validateRecoveryData } from '../src/recoveryArchive';
import { planRecoveryPreferences } from '../src/recoveryMerge';
import { emptyLocalData } from '../src/localData';
const owner='0x'+'a'.repeat(40),peer='0x'+'b'.repeat(40),receipt='xmtp:dev:room',key=`chat:settingsPrefs:v1:wallet:${owner}`;
const source=()=>upgrade({version:1,settingsPrefs:{...defaultSettings(),blocked:[peer],readReceiptOverrides:{[receipt]:true}},savedMessages:[{id:'m',body:'original',custom:{preserve:true}}],updatedAt:10});
const removed=()=>edit(edit(edit(source(),{kind:'savedMessage',id:'m',value:null},20),{kind:'block',address:peer,value:false},21),{kind:'readReceiptOverride',key:receipt,value:null},22);
let storage:Map<string,string>;
beforeEach(()=>{storage=new Map();vi.stubGlobal('localStorage',{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>storage.set(key,value)});});
afterEach(()=>vi.unstubAllGlobals());
it('stores preferences and complete markers atomically; reload and unrelated edits cannot resurrect deleted values',()=>{
 const write=vi.spyOn(localStorage,'setItem'),raw=saveSyncedSettings(key,null,removed());expect(write).toHaveBeenCalledTimes(1);
 const loaded=loadSettings(key);expect(loaded.failed).toBe(false);expect(loaded.syncPayload).toEqual(removed());expect(loaded.prefs).toEqual(view(removed()).settingsPrefs);
 const edited=saveSettings(key,raw,{...loaded.prefs,readReceiptsDefault:true},1),after=parseSettingsRaw(edited);
 expect(after.syncPayload!.savedMessages.m.value).toBeNull();expect(after.syncPayload!.blocked[peer].value).toBe(false);expect(after.syncPayload!.readReceiptOverrides[receipt].value).toBeNull();
 expect(view(merge(after.syncPayload,source())).savedMessages).toEqual([]);expect(after.updatedAt).toBeGreaterThan(22);
});
it('records explicit unblocks and receipt resets while preserving arbitrary saved fields and no-op clocks',()=>{
 const payload=applySyncPreferences(source(),defaultSettings(),20);expect(payload.blocked[peer].value).toBe(false);expect(payload.readReceiptOverrides[receipt].value).toBeNull();
 expect(payload.savedMessages.m).toEqual(source().savedMessages.m);expect(applySyncPreferences(payload,defaultSettings(),50)).toEqual(payload);
});
it('fails atomically for quota, cross-tab changes, inconsistent views and corrupt metadata',()=>{
 const before=saveSyncedSettings(key,null,removed());
 expect(()=>saveSyncedSettings(key,null,source())).toThrow();expect(storage.get(key)).toBe(before);
 vi.spyOn(localStorage,'setItem').mockImplementation(()=>{throw Error('Quota');});expect(()=>saveSettings(key,before,{...defaultSettings(),readReceiptsDefault:true},30)).toThrow();expect(storage.get(key)).toBe(before);
 expect(()=>serializeSettings({...defaultSettings(),blocked:[peer]},22,removed())).toThrow();
 const corrupt=JSON.stringify({...JSON.parse(before),syncPayload:{...removed(),version:3}});storage.set(key,corrupt);expect(loadSettings(key).failed).toBe(true);expect(()=>saveSettings(key,corrupt,defaultSettings(),30)).toThrow();expect(storage.get(key)).toBe(corrupt);
});
it('keeps prior markers when persisting a merged remote snapshot',()=>{
 const before=saveSyncedSettings(key,null,removed()),after=saveSyncedSettings(key,before,source());expect(parseSettingsRaw(after).syncPayload).toEqual(removed());
});
it('undo retains the new format, advances explicit changes, preserves older deletions and can reverse a restored deletion',()=>{
 const before=serializeSettings(view(source()).settingsPrefs,10,source()),after=serializeSettings(view(removed()).settingsPrefs,22,removed());
 const undone=parseSettingsRaw(undoSyncSettings(before,after,30));expect(undone.prefs).toEqual(view(source()).settingsPrefs);
 expect(view(merge(undone.syncPayload,removed())).savedMessages).toEqual(view(source()).savedMessages);expect(undone.syncPayload!.savedMessages.m.updatedAt).toBeGreaterThan(30);
 const old=removed(),incoming=edit(old,{kind:'savedMessage',id:'new',value:{id:'new',body:'imported'}},25);
 const raw=undoSyncSettings(serializeSettings(view(old).settingsPrefs,22,old),serializeSettings(view(incoming).settingsPrefs,25,incoming),30);
 const result=parseSettingsRaw(raw).syncPayload!;expect(result.savedMessages.m.value).toBeNull();expect(result.savedMessages.new.value).toBeNull();expect(view(merge(result,incoming)).savedMessages).toEqual([]);
});
it('v3 journals preserve exact pre-restore metadata in backups and reject downgraded or altered undo records',()=>{
 const before=source(),after=removed(),beforeRaw=serializeSettings(view(before).settingsPrefs,10,before),afterRaw=serializeSettings(view(after).settingsPrefs,22,after),local=emptyLocalData(owner);
 const journal={wallet:`restore:${owner}`,owner,version:3,id:'00000000-0000-4000-8000-000000000001',createdAt:30,source:'chirpy',phase:'prepared',before:local,after:{...local,revision:1},beforePrefs:beforeRaw,afterPrefs:afterRaw,undoPrefs:undoSyncSettings(beforeRaw,afterRaw,30)};
 const checked=validateJournal(journal,owner),backup=backupArchive(checked);expect(backup).toMatchObject({version:3,syncPayload:before});expect(backup).not.toHaveProperty('localDisplayName');
 expect(()=>validateJournal({...journal,version:1},owner)).toThrow();expect(()=>validateJournal({...journal,undoPrefs:beforeRaw},owner)).toThrow();
 for (const invalidAfter of [serializeSettings(view(after).settingsPrefs,22,after,1),serializeSettings(view(after).settingsPrefs,22,{...after,savedMessages:{}})]) {
  expect(()=>validateJournal({...journal,afterPrefs:invalidAfter,undoPrefs:undoSyncSettings(beforeRaw,invalidAfter,30)},owner)).toThrow();
 }
});
it('only applies receipt-reset markers when the user explicitly restores receipt choices',()=>{
 const payload=removed(),data=validateRecoveryData({version:3,syncMinimum:2,source:'chirpy',wallet:owner,createdAt:30,contacts:[],notes:[],preferences:{blocked:[],readReceiptsDefault:false,readReceiptOverrides:{}},syncPayload:payload});
 const current={blocked:[peer],readReceiptsDefault:false,readReceiptOverrides:{[receipt]:true}};
 expect(planRecoveryPreferences(owner,current,data,{restoreReceipts:false,addLegacyBlocks:false})).toEqual(current);
 expect(planRecoveryPreferences(owner,current,data,{restoreReceipts:true,addLegacyBlocks:false}).readReceiptOverrides).toEqual({});
 expect(()=>validateRecoveryData({...data,preferences:current})).toThrow();expect(()=>validateRecoveryData({...data,source:'governance'})).toThrow();
});
it('persists prepared versus confirmed format floors and never downgrades confirmed local state',()=>{
 const staged=saveSyncedSettings(key,null,removed(),1);expect(loadSettings(key).syncMinimum).toBe(1);
 const edited=saveSettings(key,staged,{...defaultSettings(),readReceiptsDefault:true},30);expect(parseSettingsRaw(edited).syncMinimum).toBe(1);
 const confirmed=saveSyncedSettings(key,edited,removed(),2);expect(parseSettingsRaw(confirmed).syncMinimum).toBe(2);
 const replay=saveSyncedSettings(key,confirmed,source(),1);expect(parseSettingsRaw(replay).syncMinimum).toBe(2);
 const undone=undoSyncSettings(staged,replay,40);expect(parseSettingsRaw(undone).syncMinimum).toBe(2);
 for(const patch of [{syncMinimum:undefined},{syncMinimum:0},{syncMinimum:3},{syncMinimum:'2'}]){
  const raw=JSON.stringify({...JSON.parse(confirmed),...patch});storage.set(key,raw);expect(loadSettings(key).failed).toBe(true);expect(storage.get(key)).toBe(raw);
 }
});
