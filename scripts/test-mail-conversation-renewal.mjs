// Disposable dev-only regression. No existing identity, production config or email.
import {spawnSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24||process.argv.length!==3||process.argv[2]!=='--dev')throw Error('Use Linux Node 24 and explicit --dev');
const child=String.raw`import {Client,IdentifierKind,LogLevel} from '@xmtp/node-sdk';
import {generatePrivateKey,privateKeyToAccount} from 'viem/accounts';
import {hexToBytes} from 'viem';
import {mkdtempSync} from 'node:fs';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
const dir=process.argv[2];
const timer=setTimeout(()=>{console.log(JSON.stringify({ok:false,stage:'timeout',productionTouched:false}));process.exit(1)},90000);
let stage='registration';
try {
 const make=async name=>{const a=privateKeyToAccount(generatePrivateKey());return Client.create({type:'EOA',getIdentifier:()=>({identifier:a.address,identifierKind:IdentifierKind.Ethereum}),signMessage:async m=>hexToBytes(await a.signMessage({message:m}))},{env:'dev',dbPath:join(dir,name+'.db3'),dbEncryptionKey:randomBytes(32),disableDeviceSync:true,loggingLevel:LogLevel.Off});};
 const sender=await make('sender'),recipient=await make('recipient');
 stage='old-dm';const old=await sender.conversations.createDm(recipient.inboxId);await old.sendText('Disposable older dev conversation',false);
 stage='recipient-new-dm';const fresh=await recipient.conversations.createDm(sender.inboxId);
 stage='before-sync';const before=await sender.conversations.createDm(recipient.inboxId);
 stage='after-sync';await sender.conversations.sync();const after=await sender.conversations.createDm(recipient.inboxId);
 if(old.id===fresh.id||before.id!==old.id||after.id!==fresh.id)throw Error('DM selection regression');
 stage='fresh-delivery';const messageId=await after.sendText('Disposable renewed dev delivery',false);
 await fresh.sync();const received=await fresh.messages();
 if(!received.some(m=>m.id===messageId&&m.content==='Disposable renewed dev delivery'))throw Error('Fresh delivery absent');
 if(!(await old.messages()).some(m=>m.content==='Disposable older dev conversation'))throw Error('Older sender history absent');
 console.log(JSON.stringify({recipientObserved:true,oldSenderHistoryPreserved:true,network:'dev',oldAndFreshDistinct:old.id!==fresh.id,withoutSyncSelectsOld:before.id===old.id,afterSyncSelectsFresh:after.id===fresh.id,productionTouched:false}));clearTimeout(timer);process.exit(0);
} catch(e){clearTimeout(timer);console.log(JSON.stringify({ok:false,stage,errorType:e?.name,productionTouched:false}));process.exit(1);}
`;
const root=mkdtempSync(join(tmpdir(),'chat-dm-renewal-'));
try {
 const result=spawnSync(process.execPath,['--input-type=module','-',root],{input:child,cwd:fileURLToPath(new URL('../server/',import.meta.url)),env:{PATH:process.env.PATH,HOME:root,LANG:'C.UTF-8'},encoding:'utf8',timeout:110000,maxBuffer:16384});
 const lines=(result.stdout||'').split('\n');
 const evidence=lines.filter(line=>line.startsWith('{')).map(line=>JSON.parse(line));
 if(result.status!==0||result.error||evidence.length!==1||evidence[0].recipientObserved!==true||evidence[0].oldSenderHistoryPreserved!==true)throw Error('Disposable DM renewal check failed');
 console.log(JSON.stringify(evidence[0]));
} finally {rmSync(root,{recursive:true,force:true});}
