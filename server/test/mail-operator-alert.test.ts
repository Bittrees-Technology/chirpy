import {afterEach,describe,expect,it,vi} from 'vitest';
import {mkdtempSync,chmodSync,rmSync,readFileSync,writeFileSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {runOperatorAlert,AlertReviewRequired} from '../../selfhost/mail-operator-alert.mjs';
const roots:string[]=[];
const args=['--failure','chat-mail-inbound-health.service'];
function fixture(){const state=mkdtempSync(join(tmpdir(),'chat-alert-'));chmodSync(state,0o700);roots.push(state);return {CHAT_MAIL_ALERTS_ENABLED:'1',CHAT_MAIL_ALERT_FROM:'chat@example.com',CHAT_MAIL_ALERT_TO:JSON.stringify(['two@example.com','one@example.com']),CHAT_MAIL_ALERT_STATE:state,RESEND_API_KEY:'synthetic-provider-secret'};}
const ok=()=>Response.json({id:'12345678-1234-1234-1234-123456789012'});
const file=(env:any)=>join(env.CHAT_MAIL_ALERT_STATE,args[1]+'.json');
afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
describe('private operator alert delivery',()=>{
 it('does nothing while disabled, including no storage or network',async()=>{
  const request=vi.fn();expect(await runOperatorAlert(args,{}, {request})).toEqual({enabled:false});expect(request).not.toHaveBeenCalled();
 });
 it('sends independently to both recipients and deduplicates repeated failures',async()=>{
  const env=fixture(),request=vi.fn().mockImplementation(ok),now=()=>10000000;
  expect(await runOperatorAlert(args,env,{request,now})).toEqual({enabled:true,status:'provider-accepted',recipients:2});
  expect(request).toHaveBeenCalledTimes(2);
  for(const [url,options] of request.mock.calls){expect(url).toBe('https://api.resend.com/emails');expect(options.redirect).toBe('error');const body=JSON.parse(options.body);expect(body.to).toHaveLength(1);expect(body.text).not.toContain(env.RESEND_API_KEY);expect(body.text).not.toContain('@example.com');}
  expect(request.mock.calls.map(x=>JSON.parse(x[1].body).to[0])).toEqual(['one@example.com','two@example.com']);
  expect(await runOperatorAlert(args,env,{request,now})).toMatchObject({status:'deduplicated'});expect(request).toHaveBeenCalledTimes(2);
 });
 it('durably reserves before sending and retries only the uncertain recipient with the exact payload/key',async()=>{
  const env=fixture();let call=0;const request=vi.fn().mockImplementation(()=>{expect(JSON.parse(readFileSync(file(env),'utf8')).id).toBeTruthy();if(call++===0)throw Error('private failure detail');return ok();});
  await expect(runOperatorAlert(args,env,{request,now:()=>10000000})).rejects.toThrow('incomplete');
  expect(JSON.parse(readFileSync(file(env),'utf8')).accepted).toEqual([false,true]);
  await runOperatorAlert(args,env,{request,now:()=>10001000});
  expect(request).toHaveBeenCalledTimes(3);expect(request.mock.calls[2][1].body).toBe(request.mock.calls[0][1].body);
  expect(request.mock.calls[2][1].headers['Idempotency-Key']).toBe(request.mock.calls[0][1].headers['Idempotency-Key']);
 });
 it('stops uncertain retries before provider idempotency expires and preserves evidence',async()=>{
  const env=fixture(),request=vi.fn().mockRejectedValue(Error('timeout'));
  await expect(runOperatorAlert(args,env,{request,now:()=>10000000})).rejects.toThrow();const before=readFileSync(file(env),'utf8');
  await expect(runOperatorAlert(args,env,{request,now:()=>10000000+23*3600000})).rejects.toBeInstanceOf(AlertReviewRequired);
  expect(request).toHaveBeenCalledTimes(2);expect(readFileSync(file(env),'utf8')).toBe(before);
 });
 it('issues an hourly reminder only after the previous alert was accepted for both recipients',async()=>{
  const env=fixture(),request=vi.fn().mockImplementation(ok);
  await runOperatorAlert(args,env,{request,now:()=>10000000});const first=request.mock.calls[0][1].headers['Idempotency-Key'];
  await runOperatorAlert(args,env,{request,now:()=>10000000+3600000});expect(request).toHaveBeenCalledTimes(4);expect(request.mock.calls[2][1].headers['Idempotency-Key']).not.toBe(first);
 });
 it('rejects changed recipients, corrupted payload hashes and clock rollback without sending',async()=>{
  const env=fixture(),request=vi.fn().mockImplementation(ok);await runOperatorAlert(args,env,{request,now:()=>10000000});request.mockClear();
  for(const change of [{CHAT_MAIL_ALERT_TO:'["new@example.com"]'},{CHAT_MAIL_ALERT_FROM:'other@example.com'}])await expect(runOperatorAlert(args,{...env,...change},{request,now:()=>10000001})).rejects.toBeInstanceOf(AlertReviewRequired);
  await expect(runOperatorAlert(args,env,{request,now:()=>9999999})).rejects.toBeInstanceOf(AlertReviewRequired);
  const state=JSON.parse(readFileSync(file(env),'utf8'));state.payloadHashes[0]='a'.repeat(64);writeFileSync(file(env),JSON.stringify(state));
  await expect(runOperatorAlert(args,env,{request,now:()=>10000001})).rejects.toBeInstanceOf(AlertReviewRequired);expect(request).not.toHaveBeenCalled();
 });
 it('rejects permissive files, symlinks and malformed state without overwriting them',async()=>{
  for(const type of ['permissions','link','corrupt']){
   const env=fixture(),request=vi.fn();
   if(type==='link')symlinkSync('/dev/null',file(env));else {writeFileSync(file(env),'{bad',{mode:0o600});if(type==='permissions')chmodSync(file(env),0o644);}
   await expect(runOperatorAlert(args,env,{request})).rejects.toBeInstanceOf(AlertReviewRequired);expect(request).not.toHaveBeenCalled();expect(readdirSync(env.CHAT_MAIL_ALERT_STATE)).toEqual([args[1]+'.json']);
  }
 });
 it.each(['other.service','../chat-mail-inbound.service','chat-mail-alert@anything.service'])('rejects unapproved service %s before provider access',async unit=>{
  const request=vi.fn();await expect(runOperatorAlert(['--failure',unit],fixture(),{request})).rejects.toBeInstanceOf(AlertReviewRequired);expect(request).not.toHaveBeenCalled();
 });
 it.each(['[]','["same@example.com","SAME@example.com"]','["bad\\r\\n@example.com"]','["a@example.com",false]'])('rejects invalid recipients %s',async recipients=>{
  const request=vi.fn();await expect(runOperatorAlert(args,{...fixture(),CHAT_MAIL_ALERT_TO:recipients},{request})).rejects.toBeInstanceOf(AlertReviewRequired);expect(request).not.toHaveBeenCalled();
 });
 it.each(['redirect','large','invalid'])('preserves pending state after a %s provider response',async mode=>{
  const request=vi.fn().mockImplementation(()=>mode==='redirect'?new Response(null,{status:302}):mode==='large'?new Response('x'.repeat(8193),{headers:{'content-type':'application/json'}}):Response.json({id:null}));const env=fixture();
  await expect(runOperatorAlert(args,env,{request})).rejects.toThrow('incomplete');expect(JSON.parse(readFileSync(file(env),'utf8')).accepted).toEqual([false,false]);
 });
});
