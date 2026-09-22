// @vitest-environment node
import {afterEach,expect,it,vi} from 'vitest';
import {readFileSync} from 'node:fs';
import {decryptRecoveryArchive} from '../src/recoveryArchive';
import {decryptWalletEmailArchive,encryptWalletEmailArchive,validateWalletEmailArchive,MAX_EMAIL_ARCHIVE_FILE_BYTES} from '../src/walletEmailArchive';
import {recoveryCipher} from '../src/recoveryCipher';
const wallet='0x'+'1'.repeat(40),service='https://chat.example/api/mail',password='synthetic test passphrase';
const fixture=()=>({version:1 as const,wallet,service,createdAt:1,active:'a'.repeat(32),ids:['a'.repeat(32),'b'.repeat(32)]});
afterEach(()=>vi.restoreAllMocks());
it('opens a synthetic settings file generated before the shared cipher refactor',async()=>{
 const raw=readFileSync(new URL('./fixtures/recovery-v1.json',import.meta.url),'utf8');
 expect(await decryptRecoveryArchive(raw,password,wallet)).toEqual({version:1,source:'chirpy',wallet,createdAt:1,contacts:[],notes:[],preferences:{blocked:[],readReceiptsDefault:false,readReceiptOverrides:{}}});
 await expect(decryptWalletEmailArchive(raw,password,wallet,service)).rejects.toThrow();
});
it('round trips lookup IDs without revealing wallet, service or IDs and uses fresh encryption',async()=>{
 const a=await encryptWalletEmailArchive(fixture(),password),b=await encryptWalletEmailArchive(fixture(),password);
 for(const value of [wallet,service,...fixture().ids])expect(a).not.toContain(value);
 expect(await decryptWalletEmailArchive(a,password,wallet,service)).toEqual(fixture());expect(a).not.toBe(b);
 await expect(decryptRecoveryArchive(a,password,wallet)).rejects.toThrow();
});
it('rejects the wrong password, wallet and service',async()=>{
 const raw=await encryptWalletEmailArchive(fixture(),password);
 for(const args of [[password+' ',wallet,service],[password,'0x'+'2'.repeat(40),service],[password,wallet,'https://other.example/api/mail']]){
  await expect(decryptWalletEmailArchive(raw,...args as [string,string,string])).rejects.toThrow();
 }
});
it.each(['salt','iv','ciphertext'])('rejects authenticated %s tampering',async(field)=>{
 const file=JSON.parse(await encryptWalletEmailArchive(fixture(),password));const bytes=Buffer.from(file[field],'base64');bytes[0]^=1;file[field]=bytes.toString('base64');
 await expect(decryptWalletEmailArchive(JSON.stringify(file),password,wallet,service)).rejects.toThrow();
});
it('bounds untrusted files and rejects altered metadata before deriving keys',async()=>{
 const file=JSON.parse(await encryptWalletEmailArchive(fixture(),password));const spy=vi.spyOn(crypto.subtle,'deriveKey');
 for(const mutation of [{iterations:1e12},{format:'chat-recovery'},{version:2},{iv:'AAAA'},{salt:'!!!!'},{extra:'secret'}])await expect(decryptWalletEmailArchive(JSON.stringify({...file,...mutation}),password,wallet,service)).rejects.toThrow();
 await expect(decryptWalletEmailArchive(' '.repeat(MAX_EMAIL_ARCHIVE_FILE_BYTES+1),password,wallet,service)).rejects.toThrow();expect(spy).not.toHaveBeenCalled();
});
it('strictly validates decrypted IDs and rejects extra retry authority even with valid encryption',async()=>{
 const cipher=recoveryCipher('chat-email-requests','Chat email requests v1;AES-256-GCM;PBKDF2-SHA-256;600000',{bytes:8192,fileBytes:16384});
 const raw=await cipher.encrypt({...fixture(),digest:'f'.repeat(64)},password);
 await expect(decryptWalletEmailArchive(raw,password,wallet,service)).rejects.toThrow();
 for(const patch of [{ids:['a'.repeat(32),'a'.repeat(32)]},{ids:['bad']},{active:'c'.repeat(32)},{createdAt:-1},{createdAt:Infinity},{version:2},{privateKey:'secret'},{ids:Array.from({length:101},(_,i)=>i.toString(16).padStart(32,'0'))}])expect(()=>validateWalletEmailArchive({...fixture(),...patch},wallet,service)).toThrow();
});
