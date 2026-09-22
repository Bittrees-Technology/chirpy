import { afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { InboundSendJournal } from '../inbound-send-journal.js';
import { inboundSenderIdentity, publishInboundXmtp } from '../inbound-xmtp-sender.js';
import { inboundEvent } from './helpers/inbound-mail-fixture.js';
import { inboundMailScope, inboundMailText } from '../inbound-mail-contract.js';
const roots: string[] = [], journals: any[] = [];
const hash = s => createHash('sha256').update(s).digest('hex');
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'chat-xmtp-sender-')); roots.push(root);
  const config = { network:'dev', address:'0x'+'1'.repeat(40), inboxId:'ab'.repeat(32), installationId:'cd'.repeat(32),
    databaseKey:'ef'.repeat(32), directory:join(root,'bridge'), source:{}, identity:{url:"https://wallet.example/api/service/inbound",credential:"test-credential-".repeat(4)} };
  const identity = inboundSenderIdentity(config), journal = InboundSendJournal.provision(config.directory, identity); journals.push(journal);
  writeFileSync(join(config.directory,'xmtp.db3'),'fixture only',{mode:0o600});
  const event = inboundEvent(), text = inboundMailText(event), recipient = {wallet:'0x'+'3'.repeat(40),expiresAt:Date.now()+60000};
  const scope = {eventId:event.id,contentHash:inboundMailScope(event).contentHash,recipientHash:hash(recipient.wallet),textHash:hash(text)};
  const input = {event,text,recipient,scope};journal.begin(scope);
  const peer = '12'.repeat(32), messageId = '34'.repeat(32), conversationId = '56'.repeat(16);
  const message = {id:messageId,conversationId,senderInboxId:config.inboxId,content:text,deliveryStatus:1,kind:0,
    contentType:{authorityId:'xmtp.org',typeId:'text',versionMajor:1,versionMinor:0}};
  const dm = {id:conversationId,peerInboxId:peer,members:vi.fn(async()=>[{inboxId:config.inboxId},{inboxId:peer}]),sendText:vi.fn(async()=>messageId)};
  const client = {isRegistered:true,inboxId:config.inboxId,installationId:config.installationId,
    fetchInboxIdByIdentifier:vi.fn(async()=>peer),conversations:{createDm:vi.fn(async()=>dm),getMessageById:vi.fn(()=>message)}};
  const build = vi.fn(async()=>client), loadSdk = vi.fn(async()=>({Client:{build},IdentifierKind:{Ethereum:0},LogLevel:{Off:'Off'},DeliveryStatus:{Published:1},GroupMessageKind:{Application:0}}));
  const dependencies = {loadSdk,sourceCheck:vi.fn(async()=>true),recipientCheck:vi.fn(async()=>recipient)};
  return {config,identity,journal,input,client,dm,message,dependencies,build};
}
afterEach(()=>{for(const j of journals.splice(0))try{j.close();}catch{};for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('uses the registered installation without a signer, rechecks authority and verifies exact publication',async()=>{
  const s=setup();const result=await publishInboundXmtp(s.journal,s.config,s.input,s.dependencies);
  expect(result.receipt.messageId).toBe(s.message.id);expect(s.dependencies.sourceCheck).toHaveBeenCalledTimes(2);expect(s.dependencies.recipientCheck).toHaveBeenCalledTimes(2);
  expect(s.build.mock.calls[0][1]).toMatchObject({disableDeviceSync:true,disableAutoRegister:true,dbPath:join(s.config.directory,'xmtp.db3')});
  expect(s.dm.sendText).toHaveBeenCalledExactlyOnceWith(s.input.text,false);
  expect(s.journal.inspect().blocked).toBe(true); // Only the parent records after child termination.
  await expect(publishInboundXmtp(s.journal,s.config,s.input,s.dependencies)).rejects.toThrow('consumed');expect(s.dependencies.loadSdk).toHaveBeenCalledTimes(1);
});
it('consumes launch authority durably before SDK startup, including denial or lost acknowledgement',async()=>{
  const s=setup();s.dependencies.sourceCheck.mockResolvedValue(false);
  await expect(publishInboundXmtp(s.journal,s.config,s.input,s.dependencies)).rejects.toThrow();expect(s.dependencies.loadSdk).not.toHaveBeenCalled();
  s.journal.close();const reopened=new InboundSendJournal(s.config.directory,s.identity);journals.push(reopened);
  expect(reopened.claimLaunch(s.input.scope,s.identity)).toBe(false);expect(reopened.inspect().blocked).toBe(true);
});
it('does not send after revocation during conversation creation or recipient retargeting',async()=>{
  const s=setup();s.dependencies.sourceCheck.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(publishInboundXmtp(s.journal,s.config,s.input,s.dependencies)).rejects.toThrow();expect(s.dm.sendText).not.toHaveBeenCalled();
  const t=setup();t.client.fetchInboxIdByIdentifier.mockResolvedValueOnce('12'.repeat(32)).mockResolvedValue('78'.repeat(32));
  await expect(publishInboundXmtp(t.journal,t.config,t.input,t.dependencies)).rejects.toThrow();expect(t.dm.sendText).not.toHaveBeenCalled();
});
it.each(['identity','membership','wallet'])('rejects incorrect %s before sending',async reason=>{
  const s=setup();
  if(reason==='identity')s.client.installationId='99'.repeat(32);
  if(reason==='membership')s.dm.members.mockResolvedValue([{inboxId:s.config.inboxId},{inboxId:'12'.repeat(32)},{inboxId:'99'.repeat(32)}]);
  if(reason==='wallet')s.dependencies.recipientCheck.mockResolvedValue({...s.input.recipient,wallet:'0x'+'9'.repeat(40)});
  await expect(publishInboundXmtp(s.journal,s.config,s.input,s.dependencies)).rejects.toThrow();expect(s.dm.sendText).not.toHaveBeenCalled();
});
it.each(['deliveryStatus','content','senderInboxId','conversationId','contentType','kind'])('never reports publication on mismatched %s',async field=>{
  const s=setup();s.message[field]=field==='deliveryStatus'?0:field==='kind'?1:field==='contentType'?{authorityId:'other'}:'wrong';
  await expect(publishInboundXmtp(s.journal,s.config,s.input,s.dependencies)).rejects.toThrow();expect(s.dm.sendText).toHaveBeenCalledTimes(1);expect(s.journal.inspect().blocked).toBe(true);
});
it('rejects altered content or sender configuration before SDK loading',async()=>{
  const s=setup();await expect(publishInboundXmtp(s.journal,s.config,{...s.input,text:'changed'},s.dependencies)).rejects.toThrow();
  await expect(publishInboundXmtp(s.journal,{...s.config,installationId:'99'.repeat(32)},s.input,s.dependencies)).rejects.toThrow();expect(s.dependencies.loadSdk).not.toHaveBeenCalled();
});
it('migrates old journals without granting another launch for preexisting attempts',()=>{
  const s=setup();s.journal.close();const db=new DatabaseSync(join(s.config.directory,'send-journal.sqlite'));
  db.exec('DROP TABLE launches;PRAGMA user_version=1;');db.close();
  const reopened=new InboundSendJournal(s.config.directory,s.identity);journals.push(reopened);
  expect(reopened.claimLaunch(s.input.scope,s.identity)).toBe(false);expect(reopened.inspect().blocked).toBe(true);
});
it('allows only one child to claim an armed event across independent journal connections',()=>{
  const s=setup();const other=new InboundSendJournal(s.config.directory,s.identity);journals.push(other);
  expect(s.journal.claimLaunch(s.input.scope,s.identity)).toBe(true);expect(other.claimLaunch(s.input.scope,s.identity)).toBe(false);
});

it('real child refuses a consumed claim without opening the SDK or leaking config',()=>{
 const s=setup();s.journal.claimLaunch(s.input.scope,s.identity);
 const path=join(s.config.directory,'config.json');writeFileSync(path,JSON.stringify({...s.config,enabled:true}),{mode:0o600});
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../inbound-sender-child.js',import.meta.url)),'--config',path,'--parent-pid',String(process.pid)],{input:JSON.stringify(s.input),encoding:'utf8',timeout:5000});
 expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(result.stderr).toBe('Sender outcome uncertain. Do not retry or reset the journal.\n');
 expect(s.journal.inspect().blocked).toBe(true);
});
it('real child refuses disabled configuration without modifying the journal',()=>{
 const s=setup();const path=join(s.config.directory,'config.json');writeFileSync(path,JSON.stringify({...s.config,enabled:false}),{mode:0o600});
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../inbound-sender-child.js',import.meta.url)),'--config',path,'--parent-pid',String(process.pid)],{input:JSON.stringify(s.input),encoding:'utf8',timeout:5000});
 expect(result.status).toBe(1);expect(result.stdout).toBe('');expect(s.journal.claimLaunch(s.input.scope,s.identity)).toBe(true);
});

it('real child terminates before configuration or SDK access when its expected parent is absent',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../inbound-sender-child.js',import.meta.url)),'--config','/missing-config','--parent-pid','1'],{input:'{}',encoding:'utf8',timeout:5000});
 expect(result.signal).toBe('SIGKILL');expect(result.stdout).toBe('');
});
