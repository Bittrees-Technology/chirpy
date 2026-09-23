import {expect,it,vi,afterEach} from 'vitest';
import {webcrypto} from 'node:crypto';
import {decryptSettingsPayload} from '../src/syncPayload';
afterEach(()=>vi.unstubAllGlobals());
import {parseSyncPayload} from '../src/syncPayload';
const valid=()=>({version:1,settingsPrefs:{readReceiptsDefault:false,syncAcrossDevices:true,blocked:[]},savedMessages:[{id:'old',text:'Original',arbitrary:{keep:['all',1,null]}}],updatedAt:0});
it('preserves legacy message fields, optional preference defaults and zero timestamps',()=>{
 const value=valid(),before=JSON.stringify(value),parsed=parseSyncPayload(value);
 expect(parsed.savedMessages).toEqual(value.savedMessages);expect(parsed.updatedAt).toBe(0);
 expect(parsed.settingsPrefs.readReceiptOverrides).toEqual({});expect(JSON.stringify(value)).toBe(before);
});
it.each([
 null,[],{...valid(),version:2},{...valid(),version:'1'}, {...valid(),unknown:'must not disappear'},
 {...valid(),settingsPrefs:null},{...valid(),settingsPrefs:{}},{...valid(),settingsPrefs:{...valid().settingsPrefs,updatedAt:1}},{...valid(),settingsPrefs:{...valid().settingsPrefs,blocked:['invalid']}},
 {...valid(),settingsPrefs:{...valid().settingsPrefs,readReceiptOverrides:{unknown:true}}},
 {...valid(),settingsPrefs:{...valid().settingsPrefs,readReceiptsDefault:'true'}},
 {...valid(),settingsPrefs:{...valid().settingsPrefs,tombstones:[]}},
 {...valid(),savedMessages:null},{...valid(),savedMessages:[null]},{...valid(),savedMessages:[{id:''}]},
 {...valid(),savedMessages:[{id:'old',updatedAt:'123'}]}, {...valid(),updatedAt:-1},{...valid(),updatedAt:'123'},
 {...valid(),updatedAt:Number.MAX_SAFE_INTEGER},
])('rejects unsupported or malformed data without dropping its contents: %j',value=>{
 const before=JSON.stringify(value);expect(()=>parseSyncPayload(value)).toThrow('paused');expect(JSON.stringify(value)).toBe(before);
});

it('validates encrypted envelope ownership, format, encoding and authenticated bytes',async()=>{
 vi.stubGlobal('crypto',webcrypto);
 const key=await webcrypto.subtle.importKey('raw',new Uint8Array(32).fill(1),{name:'AES-GCM'},false,['encrypt','decrypt']);
 const iv=new Uint8Array(12).fill(2),address='0x'+'1'.repeat(40);
 const ciphertext=await webcrypto.subtle.encrypt({name:'AES-GCM',iv},key,new TextEncoder().encode(JSON.stringify(valid())));
 const blob={version:1,algorithm:'AES-GCM',kdf:'HKDF-SHA-256',address,iv:Buffer.from(iv).toString('base64'),ciphertext:Buffer.from(ciphertext).toString('base64'),updatedAt:0} as const;
 expect((await decryptSettingsPayload(blob,key,address)).savedMessages).toEqual(valid().savedMessages);
 for(const patch of [{version:2},{algorithm:'other'},{kdf:'other'},{address:'0x'+'2'.repeat(40)},{extra:'keep'}, {iv:blob.iv+' '},{iv:'AAAA'}, {ciphertext:'AAAA'},{ciphertext:'!'+blob.ciphertext},{updatedAt:-1}]){
  await expect(decryptSettingsPayload({...blob,...patch} as any,key,address)).rejects.toThrow('paused');
 }
});
