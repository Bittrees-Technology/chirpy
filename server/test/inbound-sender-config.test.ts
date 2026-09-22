import {afterEach,it,expect} from 'vitest';
import {mkdtempSync,writeFileSync,symlinkSync,chmodSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {readInboundSenderConfig} from '../inbound-sender-config.js';
const roots:string[]=[];
function file(){const root=mkdtempSync(join(tmpdir(),'chat-sender-config-'));roots.push(root);return join(root,'config.json');}
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('reads only bounded private regular configuration files',()=>{
 const path=file();writeFileSync(path,JSON.stringify({enabled:false}),{mode:0o600});expect(readInboundSenderConfig(path)).toEqual({enabled:false});
 chmodSync(path,0o644);expect(()=>readInboundSenderConfig(path)).toThrow();chmodSync(path,0o600);
 symlinkSync(path,path+'.link');expect(()=>readInboundSenderConfig(path+'.link')).toThrow();
 writeFileSync(path,' '.repeat(16385));expect(()=>readInboundSenderConfig(path)).toThrow();
 writeFileSync(path,Buffer.from([255]));expect(()=>readInboundSenderConfig(path)).toThrow();expect(()=>readInboundSenderConfig('relative.json')).toThrow();
});
it('leaves the real worker disabled without reading an unavailable sender config or contacting services',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../selfhost/mail-inbound-worker.mjs',import.meta.url)),'--once'],{
  env:{PATH:'/usr/bin:/bin',CHAT_MAIL_INBOUND_WORKER_ENABLED:'0',CHAT_MAIL_SENDER_CONFIG:'/missing'},encoding:'utf8',timeout:5000});
 expect(result.status).toBe(0);expect(JSON.parse(result.stdout)).toEqual({enabled:false});expect(result.stderr).toBe('');
});

it('the real status command reports disabled as unready without reading private state',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('../../selfhost/mail-inbound-worker.mjs',import.meta.url)),'--status'],{
  env:{PATH:'/usr/bin:/bin',CHAT_MAIL_INBOUND_WORKER_ENABLED:'0',CHAT_MAIL_SENDER_CONFIG:'/missing'},encoding:'utf8',timeout:5000});
 expect(result.status).toBe(2);expect(JSON.parse(result.stdout)).toEqual({enabled:false,status:'disabled'});expect(result.stderr).toBe('');
});
