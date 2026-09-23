import {expect,it} from 'vitest';
import {prepareSyncMigration,SyncMigrationChoiceError} from '../src/syncMigration';
import {defaultSettings} from '../src/settingsStorage';
import {editSyncPayloadV2 as edit,upgradeSyncPayloadV1 as upgrade,syncPayloadV2View as view} from '../src/versionedSync';
const address='0x'+'b'.repeat(40);
const original=()=>upgrade({version:1,settingsPrefs:{...defaultSettings(),blocked:[address]},savedMessages:[{id:'old',body:'Keep original legacy fields',extra:true}],updatedAt:10});
it('merges cached legacy messages only before the remote format has upgraded',()=>{
 const local={prefs:defaultSettings(),updatedAt:20};
 expect(view(prepareSyncMigration(local,null,1,undefined,original())).savedMessages).toEqual(view(original()).savedMessages);
 const removed=edit(original(),{kind:'savedMessage',id:'old',value:null},30);
 const result=prepareSyncMigration(local,removed,2,'remote',original());expect(view(result).savedMessages).toEqual([]);
});
it('requires an explicit preference choice without rewriting either old local state or upgraded remote deletions',()=>{
 const remote=edit(original(),{kind:'savedMessage',id:'old',value:null},30),local={prefs:defaultSettings(),updatedAt:9999999};
 const before=JSON.stringify({local,remote});expect(()=>prepareSyncMigration(local,remote,2)).toThrow(SyncMigrationChoiceError);
 const keepLocal=prepareSyncMigration(local,remote,2,'local');expect(view(keepLocal).settingsPrefs.blocked).toEqual([]);expect(view(keepLocal).savedMessages).toEqual([]);
 expect(prepareSyncMigration(local,remote,2,'remote')).toEqual(remote);expect(JSON.stringify({local,remote})).toBe(before);
});
it('merges existing full metadata without reimporting its materialized legacy view',()=>{
 const remote=original(),metadata=edit(remote,{kind:'block',address,value:false},30),local={prefs:defaultSettings(),updatedAt:9999999,syncPayload:metadata};
 expect(prepareSyncMigration(local,remote,2)).toEqual(metadata);
});
it('does not invent a conflict from only the session sync flag and rejects impossible upgraded empty state',()=>{
 const remote=upgrade({version:1,settingsPrefs:{...defaultSettings(),syncAcrossDevices:true},savedMessages:[],updatedAt:10}),local={prefs:defaultSettings(),updatedAt:20};
 expect(prepareSyncMigration(local,remote,2)).toEqual(remote);expect(()=>prepareSyncMigration(local,null,2)).toThrow();
});
