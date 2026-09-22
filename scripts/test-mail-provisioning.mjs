// Explicit disposable XMTP dev drill. Never accepts a production network or
// existing identity/database. No email, member wallet or message is involved.
import {mkdtempSync,readFileSync,rmSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';

if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24||process.argv.length!==4||process.argv[2]!=='--register-dev')throw Error('Use Linux Node 24 and explicit --register-dev /isolated/runtime');
const app=realpathSync(resolve(process.argv[3]));
const {provisionInboundSender}=await import(pathToFileURL(join(app,'server/inbound-provisioning.js')).href);
const {InboundSendJournal}=await import(pathToFileURL(join(app,'server/inbound-send-journal.js')).href);
const {inboundSenderIdentity}=await import(pathToFileURL(join(app,'server/inbound-xmtp-sender.js')).href);
const root=realpathSync(mkdtempSync(join(tmpdir(),'chat-mail-provision-dev-')));
let complete=false;
try{
 const request={network:'dev',directory:join(root,'sender'),identity:{url:'https://wallet.example/api/service/inbound',credential:'synthetic-development-authority-not-used'},source:{python:'/usr/bin/python3',script:'/unavailable/check.py',config:'/unavailable/source.json',state:'/unavailable/source.sqlite'}};
 const result=await provisionInboundSender(request);
 const config=JSON.parse(readFileSync(result.config,'utf8'));
 if(config.enabled!==false||config.network!=='dev'||Object.hasOwn(config,'privateKey'))throw Error('Unexpected installed configuration');
 const journal=new InboundSendJournal(config.directory,inboundSenderIdentity(config));
 if(journal.inspect().blocked)throw Error('Unexpected journal guard');journal.close();
 // A separate process proves the closed installed database can reopen without
 // the wallet signer, re-registration, device sync or publication methods.
 const reopened=spawnSync(process.execPath,['--input-type=module','-e',`
  import {readFileSync} from 'node:fs';import {join} from 'node:path';
  import {Client,IdentifierKind,LogLevel} from '@xmtp/node-sdk';
  const c=JSON.parse(readFileSync(process.argv[1],'utf8'));
  const timer=setTimeout(()=>process.exit(2),45000);
  try{
   if(c.enabled!==false||c.network!=='dev')throw Error('Not a disabled dev fixture');
   const client=await Client.build({identifier:c.address,identifierKind:IdentifierKind.Ethereum},{env:'dev',dbPath:join(c.directory,'xmtp.db3'),dbEncryptionKey:Buffer.from(c.databaseKey,'hex'),disableDeviceSync:true,disableAutoRegister:true,loggingLevel:LogLevel.Off});
   if(!client.isRegistered||client.inboxId!==c.inboxId||client.installationId!==c.installationId||(await client.conversations.list({limit:1})).length!==0)throw Error('Reopen mismatch');
   clearTimeout(timer);process.exit(0);
  }catch{process.exit(1);}
 `,result.config],{cwd:app,env:{HOME:process.env.HOME||'',PATH:'/usr/bin:/bin',LANG:'C.UTF-8'},encoding:'utf8',timeout:50000,maxBuffer:4096});
 if(reopened.error||reopened.status!==0)throw Error('Installed dev database could not be verified');
 let refused=false;try{await provisionInboundSender(request);}catch{refused=true;}
 if(!refused)throw Error('Existing identity was reused');
 complete=true;
 console.log('Fresh XMTP dev registration, installed database reopen, matching journal and no-resume guard passed. No messages sent.');
}finally{
 // This is disposable, newly generated dev-only state. Production setup never
 // deletes its reservation, identity, journal or failed state automatically.
 if(complete)rmSync(root,{recursive:true,force:true});
 else console.error('Incomplete disposable dev drill; retained private fixture at '+root);
}
