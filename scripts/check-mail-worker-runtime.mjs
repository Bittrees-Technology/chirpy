// Linux runtime acceptance; optional explicit disposable dev registration drill.
// Default checks create no SDK client. Neither path sends a message.
import {mkdtempSync,mkdirSync,copyFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';

if(process.platform!=='linux'||Number(process.versions.node.split('.')[0])!==24)throw Error('Use Linux and Node 24');
const repo=fileURLToPath(new URL('../',import.meta.url));
const root=mkdtempSync(join(tmpdir(),'chat-mail-runtime-'));
const app=join(root,'app');mkdirSync(app);
const env={PATH:process.env.PATH,HOME:process.env.HOME,LANG:'C.UTF-8',
  npm_config_cache:join(root,'cache'),npm_config_userconfig:join(root,'user.npmrc'),npm_config_globalconfig:join(root,'global.npmrc')};
function run(command,args,cwd=app){
  const result=spawnSync(command,args,{cwd,env,stdio:'inherit',timeout:240000});
  if(result.error||result.status!==0)throw Error('Runtime validation failed');
}
try{
  writeFileSync(env.npm_config_userconfig,'',{mode:0o600});writeFileSync(env.npm_config_globalconfig,'',{mode:0o600});
  // Only committed source enters the fixture; local .env and node_modules do not.
  run('git',['archive','--format=tar','--output',join(root,'source.tar'),'HEAD','server','packages/core','selfhost'],repo);
  run('tar',['-xf',join(root,'source.tar'),'-C',app]);
  copyFileSync(join(repo,'selfhost/mail-worker.package.json'),join(app,'package.json'));
  copyFileSync(join(repo,'selfhost/mail-worker.package-lock.json'),join(app,'package-lock.json'));
  run('npm',['ci','--ignore-scripts','--omit=dev','--no-fund','--registry=https://registry.npmjs.org']);
  run('npm',['audit','--omit=dev','--audit-level=moderate','--registry=https://registry.npmjs.org']);
  run(process.execPath,['--input-type=module','-e',`
    import {Client,contentTypeText,DeliveryStatus,GroupMessageKind} from '@xmtp/node-sdk';
    import {InboundSendJournal} from './server/inbound-send-journal.js';
    if(typeof Client.build!=='function'||contentTypeText().typeId!=='text'||DeliveryStatus.Published!==1||GroupMessageKind.Application!==0)throw Error('Unexpected SDK contract');
    const directory=process.argv[1],identity='11'.repeat(32);
    const scope={eventId:'22'.repeat(32),contentHash:'33'.repeat(32),recipientHash:'44'.repeat(32),textHash:'55'.repeat(32)};
    const first=InboundSendJournal.provision(directory,identity);first.begin(scope);first.close();
    const second=new InboundSendJournal(directory,identity);
    if(!second.inspect().blocked||!second.claimLaunch(scope,identity))throw Error('Guard did not persist');second.close();
    const third=new InboundSendJournal(directory,identity);
    if(third.claimLaunch(scope,identity))throw Error('Duplicate launch allowed');third.close();
    console.log('Native SDK loaded; synthetic journal restart guard verified. No SDK client created.');
  `,join(root,'synthetic-journal')]);
  for(const mode of ['--once','--status']){
    const result=spawnSync(process.execPath,[resolve(app,'selfhost/mail-inbound-worker.mjs'),mode],{
      cwd:app,env:{...env,CHAT_MAIL_INBOUND_WORKER_ENABLED:'0'},encoding:'utf8',timeout:10000});
    if(result.error||result.status!==(mode==='--once'?0:2)||JSON.parse(result.stdout).enabled!==false)throw Error('Disabled worker contract failed');
  }
  for(const mode of ['--once','--status']){
    const result=spawnSync(process.execPath,[resolve(app,'selfhost/mail-outbound-worker.mjs'),mode],{
      cwd:app,env:{...env,CHAT_MAIL_OUTBOUND_WORKER_ENABLED:'0'},encoding:'utf8',timeout:10000});
    if(result.error||result.status!==(mode==='--once'?0:2)||JSON.parse(result.stdout).enabled!==false)throw Error('Disabled outbound worker contract failed');
  }
  console.log('Isolated worker dependency and disabled command checks passed.');
  if(process.env.CHAT_TEST_SYSTEMD_INSTALL==='1'){
    if(process.env.GITHUB_ACTIONS!=='true')throw Error('Administrator acceptance is for disposable CI only');
    run('sudo',['-n','env','GITHUB_ACTIONS=true','/usr/bin/python3','-I',join(repo,'scripts/test-mail-outbound-systemd.py'),app,process.execPath]);
  }
  if(process.env.XMTP_MAIL_PROVISION_DRILL==='1')run(process.execPath,[join(repo,'scripts/test-mail-provisioning.mjs'),'--register-dev',app]);
}finally{
  // Exact mkdtemp folder only; no parent traversal and no deployed state.
  rmSync(root,{recursive:true,force:true});
}
