import {afterEach,it,expect} from 'vitest';
import {privateKeyToAccount} from 'viem/accounts';
import {mkdtempSync,realpathSync,rmSync,writeFileSync,readFileSync,existsSync,readdirSync,statSync,mkdirSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {provisionInboundSender,runRegistrationProcess,writePrivateNew} from '../inbound-provisioning.js';
import {registerInboundIdentity} from '../inbound-registration.js';
import {InboundSendJournal} from '../inbound-send-journal.js';
import {inboundSenderIdentity} from '../inbound-xmtp-sender.js';
const roots:string[]=[];
const receipt={address:'0x'+'11'.repeat(20),inboxId:'22'.repeat(32),installationId:'33'.repeat(32)};
function setup(){const root=realpathSync(mkdtempSync(join(tmpdir(),'chat-provision-')));roots.push(root);const directory=join(root,'bridge');return {root,directory,stage:join(root,'.bridge.provision'),config:{network:'dev',directory,identity:{url:'https://wallet.example/api/service/inbound',credential:'s'.repeat(40)},source:{python:'/usr/bin/python3',script:'/opt/mail/check.py',config:'/private/mail.json',state:'/private/mail.sqlite'}}};}
function database(stage:string){for(const name of ['xmtp.db3','xmtp.db3-wal','xmtp.db3-shm'])writeFileSync(join(stage,'sdk',name),name,{mode:0o600});writeFileSync(join(stage,'sdk','xmtp.db3.sqlcipher_salt'),'ab'.repeat(16),{mode:0o400});return {...receipt,address:privateKeyToAccount(JSON.parse(readFileSync(join(stage,'registration.json'),'utf8')).privateKey).address.toLowerCase()};}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('installs closed database/WAL with a matching fresh journal and disabled config, retaining custody separately',async()=>{
 const {config,stage,directory}=setup();
 const result=await provisionInboundSender(config,{register:async s=>database(s)});
 expect(result.enabled).toBe(false);const sender=JSON.parse(readFileSync(result.config,'utf8'));
 expect(sender.enabled).toBe(false);expect(sender.privateKey).toBeUndefined();expect(JSON.stringify(result)).not.toContain(sender.databaseKey);
 const custody=JSON.parse(readFileSync(join(stage,'registration.json'),'utf8'));expect(custody.privateKey).toMatch(/^0x[a-f0-9]{64}$/);
 expect(sender.databaseKey).toBe(custody.databaseKey);expect(readdirSync(join(stage,'sdk'))).toEqual([]);
 for(const name of ['xmtp.db3','xmtp.db3-wal','xmtp.db3-shm'])expect(readFileSync(join(directory,name),'utf8')).toBe(name);
 expect(readFileSync(join(directory,'xmtp.db3.sqlcipher_salt'),'utf8')).toBe('ab'.repeat(16));
 const journal=new InboundSendJournal(directory,inboundSenderIdentity(sender));expect(journal.inspect().blocked).toBe(false);journal.close();
 expect(statSync(result.config).mode&0o077).toBe(0);
 await expect(provisionInboundSender(config,{register:async()=>{throw Error('must not run');}})).rejects.toThrow('never overwrites');
});
it('refuses existing final or staging paths without registration or modifying existing files',async()=>{
 for(const which of ['directory','stage'] as const){const s=setup();mkdirSync(s[which]);writeFileSync(join(s[which],'keep'),'original');let calls=0;
 await expect(provisionInboundSender(s.config,{register:async()=>{calls++;return receipt;}})).rejects.toThrow();expect(calls).toBe(0);expect(readFileSync(join(s[which],'keep'),'utf8')).toBe('original');}
});
it('retains uncertain registration state and denies automatic retries',async()=>{
 const {config,stage,directory}=setup();let calls=0;
 await expect(provisionInboundSender(config,{register:async s=>{calls++;database(s);throw Error('lost result');}})).rejects.toThrow();
 expect(existsSync(join(stage,'sdk/xmtp.db3'))).toBe(true);expect(existsSync(directory)).toBe(false);
 await expect(provisionInboundSender(config,{register:async()=>{calls++;return receipt;}})).rejects.toThrow();expect(calls).toBe(1);
});
it('rejects malformed receipts and unexpected, shared or exposed database files before installing',async()=>{
 for(const kind of ['receipt','wrong-wallet','missing','missing-salt','bad-salt','extra','symlink','hardlink','public']){const {config,directory}=setup();
 await expect(provisionInboundSender(config,{register:async stage=>{
  if(kind==='receipt')return {...receipt,extra:true};
  const registered=database(stage);if(kind==='wrong-wallet')return receipt;const sdk=join(stage,'sdk');
  if(kind==='missing')rmSync(join(sdk,'xmtp.db3'));
  if(kind==='missing-salt')rmSync(join(sdk,'xmtp.db3.sqlcipher_salt'));
  if(kind==='bad-salt'){rmSync(join(sdk,'xmtp.db3.sqlcipher_salt'));writeFileSync(join(sdk,'xmtp.db3.sqlcipher_salt'),'z'.repeat(32),{mode:0o400});}
  if(kind==='extra')writeFileSync(join(sdk,'other'),'x');
  if(kind==='symlink'){rmSync(join(sdk,'xmtp.db3'));symlinkSync('/dev/null',join(sdk,'xmtp.db3'));}
  if(kind==='hardlink')linkSync(join(sdk,'xmtp.db3'),join(stage,'duplicate'));
  if(kind==='public'){rmSync(join(sdk,'xmtp.db3'));writeFileSync(join(sdk,'xmtp.db3'),'x',{mode:0o644});}
  return registered;
 }})).rejects.toThrow();expect(existsSync(directory)).toBe(false);}
});
it('validates request before writing or generating a custody file',async()=>{
 for(const change of [{network:'unknown'},{extra:true},{identity:{url:'http://wallet.example/api/service/inbound',credential:'s'.repeat(40)}},{source:{python:'relative'}}]){
 const s=setup();await expect(provisionInboundSender({...s.config,...change})).rejects.toThrow();expect(existsSync(s.stage)).toBe(false);}
});
it('a partial final installation remains disabled and cannot be reset by rerunning setup',async()=>{
 const {config,directory,stage}=setup();
 // Simulate a filesystem failure after creation of the final state. The request
 // cannot resume regardless of how little of the installation exists.
 mkdirSync(stage,{mode:0o700});mkdirSync(directory,{mode:0o700});writePrivateNew(join(stage,'registration-started.json'),{version:1});
 await expect(provisionInboundSender(config)).rejects.toThrow();expect(existsSync(join(directory,'sender.json'))).toBe(false);
});
function child(stage:string,source:string){const path=join(stage,'fixture.mjs');writeFileSync(path,source);return path;}
it('requires child exit and closed pipes, strips inherited secrets and keeps output bounded',async()=>{
 const {root}=setup();process.env.CHAT_PROVISION_TEST_SECRET='not-for-child';
 try{
 const path=child(root,`if(process.env.CHAT_PROVISION_TEST_SECRET)process.exit(4);console.log(JSON.stringify(${JSON.stringify(receipt)}));`);
 expect(await runRegistrationProcess(root,{script:path})).toEqual(receipt);
 const hanging=child(root,`console.log(JSON.stringify(${JSON.stringify(receipt)}));setInterval(()=>{},1000);`);
 await expect(runRegistrationProcess(root,{script:hanging,timeoutMs:100})).rejects.toThrow('uncertain');
 const noisy=child(root,`process.stdout.write('x'.repeat(5000));`);await expect(runRegistrationProcess(root,{script:noisy})).rejects.toThrow();
 const failed=child(root,`console.log(JSON.stringify(${JSON.stringify(receipt)}));process.exit(1);`);await expect(runRegistrationProcess(root,{script:failed})).rejects.toThrow();
 }finally{delete process.env.CHAT_PROVISION_TEST_SECRET;}
});
function registrationFixture(){const s=setup();mkdirSync(s.stage,{mode:0o700});mkdirSync(join(s.stage,'sdk'),{mode:0o700});writePrivateNew(join(s.stage,'registration.json'),{network:'dev',privateKey:'0x'+'44'.repeat(32),databaseKey:'55'.repeat(32)});return s;}
it('claims once before loading SDK and registers with isolated storage and device sync disabled',async()=>{
 const s=registrationFixture();let calls=0;
 const options={loadAccounts:async()=>({privateKeyToAccount:()=>({address:receipt.address,signMessage:async()=> '0x1234'})}),loadSdk:async()=>{
 expect(existsSync(join(s.stage,'registration-started.json'))).toBe(true);
 return {IdentifierKind:{Ethereum:0},LogLevel:{Off:0},Client:{create:async(signer:any,options:any)=>{calls++;expect(options.disableDeviceSync).toBe(true);expect(options.dbPath).toBe(join(s.stage,'sdk/xmtp.db3'));expect(await signer.getIdentifier()).toEqual({identifier:receipt.address,identifierKind:0});expect(await signer.signMessage('registration')).toEqual(Buffer.from('1234','hex'));return {isRegistered:true,...receipt,fetchInboxIdByIdentifier:async()=>receipt.inboxId,conversations:{list:async()=>[]}};}}};}};
 expect(await registerInboundIdentity(s.stage,options)).toEqual(receipt);
 await expect(registerInboundIdentity(s.stage,options)).rejects.toThrow();expect(calls).toBe(1);
});
it('uncertain SDK registration never grants a second SDK launch, and existing SDK files are refused',async()=>{
 const s=registrationFixture();let calls=0;
 const options={loadAccounts:async()=>{calls++;throw Error('failure');}};
 await expect(registerInboundIdentity(s.stage,options)).rejects.toThrow();await expect(registerInboundIdentity(s.stage,options)).rejects.toThrow();expect(calls).toBe(1);
 const other=registrationFixture();writeFileSync(join(other.stage,'sdk/xmtp.db3'),'existing');
 await expect(registerInboundIdentity(other.stage,{loadAccounts:async()=>{throw Error('must not load');}})).rejects.toThrow('empty');expect(existsSync(join(other.stage,'registration-started.json'))).toBe(false);
});
it('refuses mismatched registration or pre-existing conversations without claiming success',async()=>{
 for(const mode of ['unregistered','inbox','history']){const s=registrationFixture();await expect(registerInboundIdentity(s.stage,{
 loadAccounts:async()=>({privateKeyToAccount:()=>({address:receipt.address})}),loadSdk:async()=>({IdentifierKind:{Ethereum:0},LogLevel:{Off:0},Client:{create:async()=>({isRegistered:mode!=='unregistered',...receipt,fetchInboxIdByIdentifier:async()=>mode==='inbox'?'ff'.repeat(32):receipt.inboxId,conversations:{list:async()=>mode==='history'?[{}]:[]}})}})
 })).rejects.toThrow();expect(existsSync(join(s.stage,'registration-started.json'))).toBe(true);}
});
