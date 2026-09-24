import {describe,expect,it,vi} from 'vitest';
import {spawnSync} from 'node:child_process';
import {mailWorkerRequest,runMailApiScheduler} from '../../selfhost/mail-api-scheduler.mjs';

const env={CHIRPY_MAIL_SERVICE_URL:'https://mail.example.com/api/mail',
  CHIRPY_MAIL_WORKER_SECRET:'test-worker-capability-'.repeat(3),
  CHIRPY_MAIL_PROVIDER:'resend',CHAT_MAIL_API_SCHEDULER_ENABLED:'1'};
const healthy={status:'ok',workerHealthy:true,providerBlocked:false,checkedAt:1000000,
  lastSuccessfulTickAt:999000,queued:2,due:1,oldestDueAgeMs:500,uncertainCount:0};
const reply=(body:unknown)=>Response.json(body);

describe('Resend API scheduler',()=>{
  it('does no network work without explicit enablement, including status checks',async()=>{
    const request=vi.fn();
    for(const flag of [undefined,'0','true','']){
      expect(await runMailApiScheduler(['--once'],{CHAT_MAIL_API_SCHEDULER_ENABLED:flag},request)).toEqual({exitCode:0,result:{enabled:false,status:'disabled'}});
      expect((await runMailApiScheduler(['--status'],{CHAT_MAIL_API_SCHEDULER_ENABLED:flag},request)).exitCode).toBe(2);
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('performs exactly one tick followed by read-only health, without provider credentials',async()=>{
    const request=vi.fn().mockResolvedValueOnce(reply({processed:1})).mockResolvedValueOnce(reply(healthy));
    expect(await runMailApiScheduler(['--once'],env,request)).toEqual({exitCode:0,result:{enabled:true,processed:1,...healthy}});
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls.map(([,options])=>JSON.parse(options.body).action)).toEqual(['tick','status']);
    const [url,options]=request.mock.calls[0];
    expect(String(url)).toBe('https://mail.example.com/api/mail-worker');
    expect(options).toMatchObject({method:'POST',redirect:'error',credentials:'omit',headers:{Authorization:`Bearer ${env.CHIRPY_MAIL_WORKER_SECRET}`}});
    expect(options.signal).toBeInstanceOf(AbortSignal);
  });

  it('never drains on status and reports degraded health with a failing supervisor exit',async()=>{
    const degraded={...healthy,status:'degraded',workerHealthy:false,providerBlocked:true};
    const request=vi.fn().mockResolvedValue(reply(degraded));
    expect(await runMailApiScheduler(['--status'],env,request)).toEqual({exitCode:2,result:{enabled:true,...degraded}});
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({action:'status'});
  });

  it('does not mistake tick acceptance for health or repeat an uncertain tick',async()=>{
    const request=vi.fn().mockResolvedValueOnce(reply({processed:1})).mockRejectedValueOnce(Error('status unavailable'));
    await expect(runMailApiScheduler(['--once'],env,request)).rejects.toThrow();
    expect(request).toHaveBeenCalledTimes(2);
    const failed=vi.fn().mockRejectedValue(Error('reply lost after submission'));
    await expect(runMailApiScheduler(['--once'],env,failed)).rejects.toThrow();
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it('rejects the SMTP provider and invalid supervisor commands before network access',async()=>{
    const request=vi.fn();
    await expect(runMailApiScheduler(['--once'],{...env,CHIRPY_MAIL_PROVIDER:'smtp'},request)).rejects.toThrow();
    for(const args of [[],['--profile'],['--once','extra']])await expect(runMailApiScheduler(args,env,request)).rejects.toThrow();
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects ambiguous service URLs and malformed worker capabilities before requests',async()=>{
    const request=vi.fn();
    for(const url of ['http://mail.example.com/api/mail','https://u:p@mail.example.com/api/mail',
      'https://mail.example.com/api/mail?secret=private','https://mail.example.com/api/mail#secret',
      'https://mail.example.com:8443/api/mail','https://mail.example.com/api/other']){
      await expect(mailWorkerRequest('tick',{...env,CHIRPY_MAIL_SERVICE_URL:url},request)).rejects.toThrow();
    }
    for(const key of ['', 'short', 'x'.repeat(513), 'x'.repeat(40)+'\r\nother:value']){
      await expect(mailWorkerRequest('tick',{...env,CHIRPY_MAIL_WORKER_SECRET:key},request)).rejects.toThrow();
    }
    expect(request).not.toHaveBeenCalled();
  });

  it('rejects redirects and error/HTML responses without interpreting their private bodies',async()=>{
    const redirected=reply({processed:1});Object.defineProperty(redirected,'redirected',{value:true});
    for(const response of [redirected,new Response('private provider error',{status:503}),new Response('<html>login</html>')]){
      await expect(mailWorkerRequest('tick',env,vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
  });

  it('cancels oversized streamed bodies even without a content-length header',async()=>{
    const cancel=vi.fn();
    const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array(8193));},cancel});
    await expect(mailWorkerRequest('tick',env,vi.fn().mockResolvedValue(new Response(body,{headers:{'content-type':'application/json'}})))).rejects.toThrow();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('rejects invalid UTF-8, malformed JSON and wrong result shapes',async()=>{
    for(const body of [new Uint8Array([255]),'{',JSON.stringify(null),JSON.stringify([]),JSON.stringify({processed:-1}),JSON.stringify({processed:2}),JSON.stringify({processed:0,uncertain:0})]){
      const response=new Response(body,{headers:{'content-type':'application/json'}});
      await expect(mailWorkerRequest('tick',env,vi.fn().mockResolvedValue(response))).rejects.toThrow();
    }
  });

  it('projects only content-free result fields',async()=>{
    const privateData={recipient:'private@example.com',secret:'private-token',message:'private body'};
    expect(await mailWorkerRequest('tick',env,vi.fn().mockResolvedValue(reply({processed:1,...privateData})))).toEqual({processed:1});
    expect(await mailWorkerRequest('status',env,vi.fn().mockResolvedValue(reply({...healthy,...privateData})))).toEqual(healthy);
  });

  it('rejects impossible counts and falsely healthy status',async()=>{
    for(const change of [{due:3},{queued:-1},{uncertainCount:0.5},{checkedAt:0},{lastSuccessfulTickAt:0},
      {lastSuccessfulTickAt:1000001},{lastSuccessfulTickAt:null},{oldestDueAgeMs:300001},
      {providerBlocked:true},{uncertainCount:1},{workerHealthy:'true'},{status:'healthy'}]){
      await expect(mailWorkerRequest('status',env,vi.fn().mockResolvedValue(reply({...healthy,...change})))).rejects.toThrow();
    }
  });

  it('redacts CLI errors and rejects extra arguments without running a worker',()=>{
    for(const entry of ['selfhost/mail-api-scheduler.mjs','scripts/mail-worker.mjs']){
      const run=spawnSync(process.execPath,[entry,'private-accidental-argument'],{env,encoding:'utf8'});
      expect(run.status).toBe(1);
      expect(run.stdout).toBe('');
      expect(run.stderr).not.toContain('private-accidental-argument');
      expect(run.stderr).not.toContain(env.CHIRPY_MAIL_WORKER_SECRET);
      expect(run.stderr).not.toContain(env.CHIRPY_MAIL_SERVICE_URL);
    }
    const disabled=spawnSync(process.execPath,['selfhost/mail-api-scheduler.mjs','--status'],{env:{},encoding:'utf8'});
    expect(disabled.status).toBe(2);
    expect(JSON.parse(disabled.stdout)).toEqual({enabled:false,status:'disabled'});
  });
});
