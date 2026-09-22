import { afterEach, describe, expect, it, vi } from 'vitest';
import { optOutMail, mailConfig } from '../mail-service.js';
import handler from '../../api/mail-optout.js';
const env={CHIRPY_MAIL_ENABLED:'0',CHIRPY_MAIL_SERVICE_URL:'https://chirpy.test/api/mail',KV_REST_API_URL:'https://kv.test',KV_REST_API_TOKEN:'test',CHIRPY_MAIL_FROM:'service@example.com',CHIRPY_MAIL_SENDERS:`0x${'3'.repeat(40)}`,CHIRPY_MAIL_DATA_KEY:'ab'.repeat(32),CHIRPY_MAIL_WORKER_SECRET:'test'.repeat(10),RESEND_API_KEY:'test'};
const token='ab'.repeat(32);
function res(){return {code:0,body:null as any,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;}};}
afterEach(()=>{vi.unstubAllEnvs();vi.unstubAllGlobals();});
describe('recipient opt-out',()=>{
  it('rejects invalid capabilities before storage and fails closed on corrupt mappings',async()=>{
    const config=mailConfig({...env,CHIRPY_MAIL_ENABLED:'1'});const kv=vi.fn();
    for(const value of [null,'',token.toUpperCase(),token+'ab',[]])expect((await optOutMail(config,value,kv)).status).toBe('invalid');
    expect(kv).not.toHaveBeenCalled();kv.mockResolvedValue('other-service:suppressed:hash');
    await expect(optOutMail(config,token,kv)).rejects.toThrow('invalid opt-out record');expect(kv).toHaveBeenCalledOnce();
  });
  it('never changes preferences on GET and rejects cross-origin or malformed posts',async()=>{
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    const get=res();await handler({method:'GET',headers:{},query:{token}},get);expect(get.code).toBe(405);
    const cross=res();await handler({method:'POST',headers:{origin:'https://evil.test'},body:{token}},cross);expect(cross.code).toBe(403);
    for(const body of [null,[],{token:'bad'},{token,extra:true}]){const response=res();await handler({method:'POST',headers:{'content-type':'application/json'},body},response);expect(response.code).toBe(400);}
    expect(fetcher).not.toHaveBeenCalled();
  });
  it.each([false,true])('works while sending is paused with partial Wallet configuration=%s',async(partial)=>{
    for(const [key,value] of Object.entries(env))vi.stubEnv(key,value);
    const fetcher=vi.fn();vi.stubGlobal('fetch',fetcher);
    if(partial)vi.stubEnv('CHIRPY_MAIL_IDENTITY_URL','https://wallet.example/api/service/delivery');
    fetcher.mockResolvedValue({ok:true,json:async()=>({result:null})});
    const missing=res();await handler({method:'POST',headers:{'content-type':'application/json'},body:{token}},missing);expect(missing.code).toBe(404);
    const config=mailConfig({...env,CHIRPY_MAIL_ENABLED:'1'});fetcher.mockResolvedValueOnce({ok:true,json:async()=>({result:`${config.prefix}suppressed:${'cd'.repeat(32)}`})}).mockResolvedValueOnce({ok:true,json:async()=>({result:'opted-out'})});
    const good=res();await handler({method:'POST',headers:{'content-type':'application/json'},body:{token}},good);expect(good.code).toBe(200);expect(good.body).toEqual({status:'opted-out'});
    fetcher.mockRejectedValue(Error('private details'));const failed=res();await handler({method:'POST',headers:{'content-type':'application/json'},body:{token}},failed);expect(failed.code).toBe(503);expect(JSON.stringify(failed.body)).not.toContain('private details');
  });
});
