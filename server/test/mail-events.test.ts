import { afterEach, describe, expect, it, vi } from 'vitest';
import {APPLY_MAIL_DELIVERY_EVENT} from '../mail-delivery.js';
import { Webhook } from 'svix';
import { handleMailEvent, mailEventConfig, readMailEventBody, APPLY_MAIL_EVENT } from '../mail-events.js';
const secret=`whsec_${Buffer.alloc(32,7).toString('base64')}`;
const env={CHIRPY_MAIL_ENABLED:'0',CHIRPY_MAIL_WEBHOOK_ENABLED:'1',RESEND_WEBHOOK_SECRET:secret,CHIRPY_MAIL_SERVICE_URL:'https://chirpy.test/api/mail',KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'test',CHIRPY_MAIL_FROM:'service@example.com',CHIRPY_MAIL_SENDERS:`0x${'3'.repeat(40)}`,CHIRPY_MAIL_DATA_KEY:'ab'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),RESEND_API_KEY:'test'};
const event=()=>({type:'email.complained',data:{from:env.CHIRPY_MAIL_FROM,to:['member@example.com'],email_id:'provider-1',subject:'private subject'}});
function request(raw=JSON.stringify(event()),time=Date.now(),headers={}) {
  const id='msg_synthetic';const date=new Date(time);
  return new Request('https://chirpy.test/api/mail-events',{method:'POST',body:raw,headers:{'Content-Type':'application/json','svix-id':id,'svix-timestamp':String(Math.floor(time/1000)),'svix-signature':new Webhook(secret).sign(id,date,raw),...headers}});
}
afterEach(()=>{vi.useRealTimers();});
describe('signed mail provider events',()=>{
  it('requires independent configuration, rejects previews and works while sending is paused',async()=>{
    expect(mailEventConfig(env)).not.toBeNull();
    const partial={...env,CHIRPY_MAIL_IDENTITY_URL:'https://wallet.example/api/service/delivery'};
    const stored=vi.fn().mockResolvedValue('applied');expect((await handleMailEvent(request(),partial,stored)).status).toBe(200);expect(stored).toHaveBeenCalledOnce();
    for(const patch of [{CHIRPY_MAIL_WEBHOOK_ENABLED:'0'},{RESEND_WEBHOOK_SECRET:''},{RESEND_WEBHOOK_SECRET:'whsec_YQ=='},{VERCEL_ENV:'preview'}]) {
      const kv=vi.fn();const result=await handleMailEvent(request(),{...env,...patch},kv);expect(result.status).toBe(503);expect(kv).not.toHaveBeenCalled();
    }
  });
  it.each(['email.bounced','email.complained'])('applies %s only after verifying the exact body',async(type)=>{
    const kv=vi.fn().mockResolvedValue('applied');const body={...event(),type};
    const response=await handleMailEvent(request(JSON.stringify(body,null,2)),env,kv);
    expect(response.status).toBe(200);expect(await response.json()).toEqual({status:'applied'});
    expect(kv).toHaveBeenCalledOnce();const command=kv.mock.calls[0][0];expect(command.slice(0,3)).toEqual(['EVAL',APPLY_MAIL_DELIVERY_EVENT,'4']);
    expect(JSON.stringify(command)).not.toContain('member@example.com');expect(JSON.stringify(command)).not.toContain('private subject');
    expect(JSON.parse(command[9]).reason).toBe(type==='email.bounced'?'bounce':'complaint');
  });
  it('rejects signature, body, ID and timestamp tampering before storage',async()=>{
    const kv=vi.fn();const original=request();const headers=Object.fromEntries(original.headers);
    const cases=[request(undefined,Date.now()-600000),request(undefined,Date.now()+600000),request(undefined,Date.now(),{'svix-id':'msg_changed'}),request(undefined,Date.now(),{'svix-signature':'v1,forged'}),request(undefined,Date.now(),{'svix-id':''}),new Request(original.url,{method:'POST',headers,body:JSON.stringify(event())+' '})];
    for(const req of cases)expect((await handleMailEvent(req,env,kv)).status).toBe(401);
    expect(kv).not.toHaveBeenCalled();
  });
  it('ignores other applications and non-suppression events, rejects ambiguous recipients',async()=>{
    const kv=vi.fn();
    for(const body of [{...event(),type:'email.received'},{...event(),data:{...event().data,from:'other@example.com'}}])expect(await (await handleMailEvent(request(JSON.stringify(body)),env,kv)).json()).toEqual({status:'ignored'});
    for(const data of [{...event().data,to:['a@example.com','b@example.com']},{...event().data,to:['bad']},{...event().data,from:undefined},{...event().data,email_id:''}])expect((await handleMailEvent(request(JSON.stringify({...event(),data})),env,kv)).status).toBe(400);
    expect(kv).not.toHaveBeenCalled();
  });
  it('rejects malformed JSON, unsupported media and oversized bodies without storage',async()=>{
    const kv=vi.fn();
    for(const req of [request('{bad'),request('x'.repeat(65537)),request('{}',Date.now(),{'content-length':'65537'})])expect((await handleMailEvent(req,env,kv)).status).toBe(400);
    expect((await handleMailEvent(request('{}',Date.now(),{'content-type':'text/plain'}),env,kv)).status).toBe(415);expect(kv).not.toHaveBeenCalled();
  });
  it('bounds a stalled body and cancels the stream',async()=>{
    vi.useFakeTimers();const cancel=vi.fn();const stream=new ReadableStream({cancel});
    const req=new Request('https://chirpy.test',{method:'POST',body:stream,duplex:'half'} as any);
    const result=expect(readMailEventBody(req)).rejects.toThrow('timeout');await vi.advanceTimersByTimeAsync(5001);await result;expect(cancel).toHaveBeenCalledOnce();
  });
  it('acknowledges durable duplicates, rejects identity conflicts and retries failed storage',async()=>{
    for(const [result,status] of [['duplicate',200],['conflict',409],['unexpected',503]] as const)expect((await handleMailEvent(request(),env,vi.fn().mockResolvedValue(result))).status).toBe(status);
    const response=await handleMailEvent(request(),env,vi.fn().mockRejectedValue(Error('secret storage detail')));
    expect(response.status).toBe(503);expect(await response.text()).not.toContain('secret');
  });
});

it.each(['sent','delivered','delivery_delayed','failed','suppressed'])('accepts a signed timed %s report without suppressing the recipient',async type=>{
 const kv=vi.fn().mockResolvedValue('applied'),body={...event(),type:'email.'+type,created_at:new Date(Date.now()-1000).toISOString()};
 expect((await handleMailEvent(request(JSON.stringify(body)),env,kv)).status).toBe(200);const args=kv.mock.calls[0][0];expect(args.slice(0,3)).toEqual(['EVAL',APPLY_MAIL_DELIVERY_EVENT,'4']);expect(args[9]).toBe('');expect(args[10]).toBe(type);expect(JSON.stringify(args)).not.toMatch(/member@example|private subject|provider-1/);
});
it.each([undefined,'invalid','2026-99-99T01:00:00Z',new Date(Date.now()+600000).toISOString()])('rejects invalid delivery report times before storage',async created_at=>{
 const kv=vi.fn();const body={...event(),type:'email.delivered',created_at};expect((await handleMailEvent(request(JSON.stringify(body)),env,kv)).status).toBe(400);expect(kv).not.toHaveBeenCalled();
});
it.each(['email.opened','email.clicked'])('ignores tracking reports rather than claiming read receipts: %s',async type=>{
 const kv=vi.fn();expect(await (await handleMailEvent(request(JSON.stringify({...event(),type})),env,kv)).json()).toEqual({status:'ignored'});expect(kv).not.toHaveBeenCalled();
});

// Named senders from other Resend applications must not cause repeated delivery.
it.each(['Bittrees News <main@example.com>', '"Bittrees, News" <main@example.com>', 'service@example.com <main@example.com>'])('ignores a signed unrelated sender %s without touching Chat storage',async from=>{
 const kv=vi.fn();const body={...event(),data:{from}};
 const result=await handleMailEvent(request(JSON.stringify(body)),env,kv);
 expect(result.status).toBe(200);expect(await result.json()).toEqual({status:'ignored'});expect(kv).not.toHaveBeenCalled();
 expect((await handleMailEvent(request(JSON.stringify(body),Date.now(),{'svix-signature':'v1,forged'}),env,kv)).status).toBe(401);
});
it('tracks the exact Chat sender with a provider display name identically to a plain sender',async()=>{
 const plain=vi.fn().mockResolvedValue('applied'),named=vi.fn().mockResolvedValue('applied');
 await handleMailEvent(request(),env,plain);
 const body={...event(),data:{...event().data,from:`Chat <${env.CHIRPY_MAIL_FROM}>`}};
 expect((await handleMailEvent(request(JSON.stringify(body)),env,named)).status).toBe(200);
 expect(named.mock.calls).toEqual(plain.mock.calls);
});
it.each(['Chat <service@example.com>, News <other@example.com>', 'Chat <service@example.com> extra', 'Chat <service@example.com>\r\nX: value', 'Chat <bad>', '<service@example.com>', 'News <other@example.com><service@example.com>'])('rejects malformed or ambiguous provider sender %s',async from=>{
 const kv=vi.fn();const body={...event(),data:{...event().data,from}};
 expect((await handleMailEvent(request(JSON.stringify(body)),env,kv)).status).toBe(400);expect(kv).not.toHaveBeenCalled();
});
