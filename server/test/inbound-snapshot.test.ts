import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,realpathSync,rmSync,mkdirSync,writeFileSync,readFileSync,readdirSync,existsSync,chmodSync,symlinkSync,linkSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join} from 'node:path';import {spawn} from 'node:child_process';import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import {InboundSendJournal} from '../inbound-send-journal.js';
import {inboundSenderIdentity} from '../inbound-xmtp-sender.js';
import {acquireInboundState,STATE_LOCK,RECOVERY_QUARANTINE} from '../inbound-state-lock.js';
import {captureInboundSnapshot,verifyInboundSnapshot,SNAPSHOT_MANIFEST} from '../inbound-snapshot.js';
const roots:string[]=[];
const scope={eventId:'11'.repeat(32),contentHash:'22'.repeat(32),recipientHash:'33'.repeat(32),textHash:'44'.repeat(32)};
const receipt={messageId:'55'.repeat(32),conversationId:'66'.repeat(16),senderInboxId:'77'.repeat(32),textHash:scope.textHash};
function fixture(){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'chat-snapshot-')));roots.push(root);const source=join(root,'sender'),output=join(root,'backup');
 const config={enabled:true,network:'dev',directory:source,address:'0x'+'11'.repeat(20),inboxId:'77'.repeat(32),installationId:'88'.repeat(32),databaseKey:'99'.repeat(32),identity:{url:'https://wallet.example/api/service/inbound',credential:'a'.repeat(40)},source:{python:'/usr/bin/python3',script:'/opt/mail/check.py',config:'/private/mail.json',state:'/private/mail.sqlite'}};
 const identity=inboundSenderIdentity(config),journal=InboundSendJournal.provision(source,identity);journal.close();
 writeFileSync(join(source,'sender.json'),JSON.stringify(config),{mode:0o600});writeFileSync(join(source,'xmtp.db3'),'synthetic SDK state; snapshot never opens it',{mode:0o600});writeFileSync(join(source,'xmtp.db3.sqlcipher_salt'),'ab'.repeat(16),{mode:0o400});
 return {root,source,output,identity,config};
}
function hashes(directory:string){return Object.fromEntries(readdirSync(directory).map(name=>[name,createHash('sha256').update(readFileSync(join(directory,name))).digest('hex')]));}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('serializes state ownership and never expires or steals an existing lock',()=>{
 const f=fixture(),lock=acquireInboundState(f.source);
 expect(()=>acquireInboundState(f.source)).toThrow();expect(()=>captureInboundSnapshot(f.source,f.output)).toThrow();expect(existsSync(f.output)).toBe(false);
 lock.release();lock.release();acquireInboundState(f.source).release();
 mkdirSync(join(f.source,STATE_LOCK),{mode:0o700});writeFileSync(join(f.source,STATE_LOCK,'owner.json'),JSON.stringify({pid:999999,token:'old'}),{mode:0o600});
 expect(()=>acquireInboundState(f.source)).toThrow();expect(existsSync(join(f.source,STATE_LOCK,'owner.json'))).toBe(true);
});
it('process death leaves ownership reserved instead of admitting a new SDK writer',async()=>{
 const f=fixture();const module=pathToFileURL(join(process.cwd(),'server/inbound-state-lock.js')).href;
 const child=spawn(process.execPath,['--input-type=module','-e',`import {acquireInboundState} from ${JSON.stringify(module)};acquireInboundState(process.argv[1]);process.stdout.write('locked');setInterval(()=>{},1000);`,f.source],{stdio:['ignore','pipe','pipe']});
 try{await new Promise<void>((resolve,reject)=>{child.stdout.once('data',()=>resolve());child.once('error',reject);child.once('exit',()=>reject(Error('Child exited before ownership')));});
 child.kill('SIGKILL');await new Promise(resolve=>child.once('close',resolve));expect(()=>acquireInboundState(f.source)).toThrow();expect(()=>captureInboundSnapshot(f.source,f.output)).toThrow();
 }finally{if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
});
it('cannot release another owner after replacement',()=>{
 const f=fixture(),lock=acquireInboundState(f.source);const path=join(f.source,STATE_LOCK,'owner.json');writeFileSync(path,JSON.stringify({pid:process.pid,token:'replacement'}));
 expect(()=>lock.release()).toThrow('ownership changed');expect(existsSync(path)).toBe(true);
});
it('captures a private disabled joint copy without mutating live state, and refuses backup journal access',()=>{
 const f=fixture(),before=hashes(f.source),result=captureInboundSnapshot(f.source,f.output);
 expect(hashes(f.source)).toEqual(before);expect(result.blocked).toBe(false);expect(verifyInboundSnapshot(f.output,result.manifestSha256).identity).toBe(f.identity);
 expect(JSON.parse(readFileSync(join(f.output,'sender.json'),'utf8')).enabled).toBe(false);
 expect(()=>new InboundSendJournal(f.output,f.identity)).toThrow('quarantined');expect(()=>acquireInboundState(f.output)).toThrow('quarantined');
 expect(readFileSync(join(f.output,'xmtp.db3'),'utf8')).toContain('synthetic SDK');
 expect(()=>captureInboundSnapshot(f.source,f.output)).toThrow();expect(existsSync(join(f.source,STATE_LOCK))).toBe(false);
});
it('preserves published receipts and armed launch claims, including journal WAL',()=>{
 const f=fixture(),journal=new InboundSendJournal(f.source,f.identity);journal.begin(scope);journal.recordPublished(scope,receipt);
 const next={...scope,eventId:'aa'.repeat(32)};journal.begin(next);journal.claimLaunch(next,f.identity);
 try{
  const before=hashes(f.source),result=captureInboundSnapshot(f.source,f.output);expect(result.blocked).toBe(true);expect(verifyInboundSnapshot(f.output,result.manifestSha256).blocked).toBe(true);expect(hashes(f.source)).toEqual(before);
  // Test-only offline restore into an isolated journal-only fixture: no SDK is
  // opened, and neither this fixture nor the original source is a live sender.
  const restored=join(f.root,'journal-check');mkdirSync(restored,{mode:0o700});
  for(const name of readdirSync(f.output).filter(n=>n.startsWith('send-journal.sqlite')))writeFileSync(join(restored,name),readFileSync(join(f.output,name)),{mode:0o600});
  const copy=new InboundSendJournal(restored,f.identity);try{expect(copy.outcome(scope.eventId,scope.contentHash)).toEqual({status:'published',receipt});expect(copy.outcome(next.eventId,next.contentHash)).toEqual({status:'uncertain'});expect(copy.claimLaunch(next,f.identity)).toBe(false);expect(copy.begin({...scope,eventId:'bb'.repeat(32)})).toEqual({status:'blocked'});}finally{copy.close();}
 }finally{journal.close();}
});
it('rejects missing salt/journal, links, public files and unexpected state',()=>{
 for(const kind of ['salt','journal','symlink','hardlink','public','extra']){
  const f=fixture();if(kind==='salt')rmSync(join(f.source,'xmtp.db3.sqlcipher_salt'));if(kind==='journal')rmSync(join(f.source,'send-journal.sqlite'));
  if(kind==='symlink'){rmSync(join(f.source,'xmtp.db3'));symlinkSync('/dev/null',join(f.source,'xmtp.db3'));}
  if(kind==='hardlink')linkSync(join(f.source,'xmtp.db3'),join(f.root,'duplicate'));
  if(kind==='public')chmodSync(join(f.source,'xmtp.db3'),0o644);if(kind==='extra')writeFileSync(join(f.source,'extra'),'x');
  expect(()=>captureInboundSnapshot(f.source,f.output)).toThrow();expect(existsSync(join(f.source,STATE_LOCK))).toBe(false);
 }
});
it('requires the independently trusted manifest and detects state, marker, config and file-list tampering',()=>{
 for(const kind of ['hash','sdk','journal','marker','config','extra','manifest']){
  const f=fixture(),result=captureInboundSnapshot(f.source,f.output);
  if(kind==='sdk'||kind==='journal')writeFileSync(join(f.output,kind==='sdk'?'xmtp.db3':'send-journal.sqlite'),'corrupt');
  if(kind==='marker')rmSync(join(f.output,RECOVERY_QUARANTINE));
  if(kind==='config')writeFileSync(join(f.output,'sender.json'),JSON.stringify({...f.config,enabled:true}));
  if(kind==='extra')writeFileSync(join(f.output,'extra'),'x');
  if(kind==='manifest')writeFileSync(join(f.output,SNAPSHOT_MANIFEST),'{}');
  expect(()=>verifyInboundSnapshot(f.output,kind==='hash'?'ff'.repeat(32):result.manifestSha256)).toThrow();
 }
});
it('keeps incomplete snapshot copies quarantined when the journal identity is invalid',()=>{
 const f=fixture();writeFileSync(join(f.source,'sender.json'),JSON.stringify({...f.config,inboxId:'aa'.repeat(32)}));
 expect(()=>captureInboundSnapshot(f.source,f.output)).toThrow();expect(existsSync(join(f.output,RECOVERY_QUARANTINE))).toBe(true);expect(existsSync(join(f.output,SNAPSHOT_MANIFEST))).toBe(false);expect(()=>new InboundSendJournal(f.output,f.identity)).toThrow('quarantined');expect(existsSync(join(f.source,STATE_LOCK))).toBe(false);
});
it('refuses snapshots inside live state and nonprivate destinations',()=>{
 const f=fixture();for(const name of ['backup','..backup']){expect(()=>captureInboundSnapshot(f.source,join(f.source,name))).toThrow();expect(existsSync(join(f.source,name))).toBe(false);}const parent=join(f.root,'public');mkdirSync(parent,{mode:0o755});expect(()=>captureInboundSnapshot(f.source,join(parent,'backup'))).toThrow();expect(existsSync(join(f.source,STATE_LOCK))).toBe(false);
});
