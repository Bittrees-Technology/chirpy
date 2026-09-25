import {it,expect,afterEach} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {inboundSourceConfig,checkInboundSource,runSourceCheck} from '../inbound-source-process.js';
import {inboundEvent} from './helpers/inbound-mail-fixture.js';
const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const config={python:'/usr/bin/python3',script:'/private/source_check.py',config:'/private/source.json',state:'/private/outbox.sqlite'};
function fixture(code:string){const root=mkdtempSync(join(tmpdir(),'chat-source-process-'));roots.push(root);const script=join(root,'source_check.py');writeFileSync(script,code);return {...config,script};}
it('requires all configured absolute trusted paths',()=>{
 expect(inboundSourceConfig({})).toBeNull();
 const env={CHAT_MAIL_SOURCE_PYTHON:config.python,CHAT_MAIL_SOURCE_CHECK_SCRIPT:config.script,CHAT_MAIL_SOURCE_CONFIG:config.config,CHAT_MAIL_SOURCE_STATE:config.state};expect(inboundSourceConfig(env)).toEqual(config);
 for(const value of ['relative','/path\nargument'])expect(inboundSourceConfig({...env,CHAT_MAIL_SOURCE_CHECK_SCRIPT:value})).toBeNull();
});
it('validates exact source scope, freshness and original deadline',async()=>{
 const event=inboundEvent();const reply=async(_c,input)=>({...input,authorized:true,checkedAt:Date.now(),sourceDeadline:event.receivedAt+23*3600000});
 expect(await checkInboundSource(config,event,reply)).toBe(true);
 for(const patch of [{eventId:'ff'.repeat(32)},{contentHash:'ff'.repeat(32)},{authorized:'true'},{checkedAt:Date.now()-6000},{checkedAt:Date.now()+5000},{sourceDeadline:Date.now()+3600000},{extra:'private'}])await expect(checkInboundSource(config,event,async(c,i)=>({...await reply(c,i),...patch}))).rejects.toThrow();
 expect(await checkInboundSource(config,event,async(_c,input)=>({...input,authorized:false}))).toBe(false);
});
it('expired source events never invoke a checker',async()=>{
 expect(await checkInboundSource(config,{...inboundEvent(),receivedAt:1},async()=>{throw Error('must not run');})).toBe(false);
});
it('executes an actual bounded child, passes exact stdin and does not inherit secret environment',async()=>{
 const c=fixture("import json,sys,os\nr=json.load(sys.stdin)\nassert 'CHAT_TEST_PRIVATE' not in os.environ\nassert sys.argv[1:]==['--config','/private/source.json','--state','/private/outbox.sqlite']\nprint(json.dumps(dict(**r,authorized=False)))\n");
 const old=process.env.CHAT_TEST_PRIVATE;process.env.CHAT_TEST_PRIVATE='do-not-inherit';
 try{expect(await checkInboundSource(c,inboundEvent())).toBe(false);}finally{if(old===undefined)delete process.env.CHAT_TEST_PRIVATE;else process.env.CHAT_TEST_PRIVATE=old;}
},20000); // Allow cold system-Python startup; the actual checker still enforces its 15s deadline.
it('rejects unavailable processes, private errors and oversized output',async()=>{
 for(const c of [{...config,python:'/missing/python'},fixture("import sys\nprint('private secret',file=sys.stderr)\nsys.exit(1)"),fixture("print('x'*4097)"),fixture("import sys\nprint('x'*4097,file=sys.stderr)")])await expect(runSourceCheck(c,{eventId:'a'})).rejects.toThrow('Source authority unavailable');
});
it('kills hung checker processes instead of treating a timeout as permission',async()=>{
 const c=fixture('import time\ntime.sleep(60)');await expect(runSourceCheck(c,{},{timeoutMs:100})).rejects.toThrow('Source authority unavailable');
});
it('rejects malformed JSON and invalid UTF8 without exposing output',async()=>{
 for(const code of ["print('private invalid response')","import sys\nsys.stdout.buffer.write(bytes([255]))"])await expect(runSourceCheck(fixture(code),{})).rejects.toThrow('Invalid source authority response');
});

it('accepts one operator socket and rejects ambiguous transport configuration',()=>{
 expect(inboundSourceConfig({CHAT_MAIL_SOURCE_SOCKET:'/run/chat-mail-source/check.sock'})).toEqual({socket:'/run/chat-mail-source/check.sock'});
 expect(inboundSourceConfig({CHAT_MAIL_SOURCE_SOCKET:'/run/check.sock',CHAT_MAIL_SOURCE_PYTHON:'/usr/bin/python3'})).toBeNull();
 for(const socket of ['relative','/bad\npath','/'+'a'.repeat(104)])expect(inboundSourceConfig({CHAT_MAIL_SOURCE_SOCKET:socket})).toBeNull();
});
it('uses a real local socket for exact scoped authority without exposing event text',async()=>{
 const {createServer}=await import('node:net');const root=mkdtempSync('/tmp/chat-src-');roots.push(root);const path=join(root,'check.sock');
 const event=inboundEvent();let received:any;
 const server=createServer({allowHalfOpen:true},socket=>{let raw='';socket.on('data',c=>raw+=c);socket.on('end',()=>{received=JSON.parse(raw);socket.end(JSON.stringify({...received,authorized:true,checkedAt:Date.now(),sourceDeadline:event.receivedAt+23*3600000}));});});
 await new Promise<void>(resolve=>server.listen(path,resolve));
 try{expect(await checkInboundSource({socket:path},event)).toBe(true);expect(Object.keys(received).sort()).toEqual(['contentHash','eventId']);}
 finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
});
it('fails closed for unavailable, oversized and stalled socket replies',async()=>{
 const {createServer}=await import('node:net');const root=mkdtempSync('/tmp/chat-src-');roots.push(root);const path=join(root,'check.sock');
 await expect(runSourceCheck({socket:path},{},{timeoutMs:100})).rejects.toThrow('Source authority unavailable');
 for(const reply of ['x'.repeat(4097),null]){
  const connections:any[]=[];const server=createServer({allowHalfOpen:true},socket=>{connections.push(socket);socket.on('error',()=>{});socket.on('data',()=>{});socket.on('end',()=>{if(reply!==null)socket.end(reply);});});
  await new Promise<void>(resolve=>server.listen(path,resolve));
  try{await expect(runSourceCheck({socket:path},{},{timeoutMs:100})).rejects.toThrow('Source authority unavailable');}
  finally{connections.forEach(c=>c.destroy());await new Promise<void>(resolve=>server.close(()=>resolve()));}
 }
});
