import {expect,it,vi} from 'vitest';
import {checkAvailability} from '../../scripts/production-availability.mjs';
const health=()=>Response.json({readiness:{syncReady:true,gateReady:false,releaseReady:false}});
it('reports availability separately from launch readiness and makes bounded credential-free requests',async()=>{
 const request=vi.fn(async(url:string)=>url.endsWith('/api/health')?health():new Response('Mail'));
 expect(await checkAvailability(request)).toMatchObject({availabilityPassed:true,checks:[{name:'chat',releaseReady:false},{name:'mail',available:true}],liveDependencyVerificationRequired:true});
 for(const [,options]of request.mock.calls)expect(options).toMatchObject({redirect:'error',credentials:'omit',signal:expect.any(AbortSignal)});
});
it.each([()=>new Response('private failure',{status:503}),()=>Response.json({readiness:{syncReady:false,gateReady:false,releaseReady:false}}),()=>Response.json({readiness:{syncReady:true}}),()=>new Response('x'.repeat(16385),{headers:{'content-type':'application/json'}}),()=>new Response('not json',{headers:{'content-type':'application/json'}})])('fails closed on bad health without printing response bodies',async(make)=>{
 const report=await checkAvailability(async()=>make());expect(report.availabilityPassed).toBe(false);expect(JSON.stringify(report)).not.toContain('private failure');
});
it('contains network errors and redirects',async()=>{
 const report=await checkAvailability(async()=>{throw Error('secret network detail')});expect(report.availabilityPassed).toBe(false);expect(JSON.stringify(report)).not.toContain('secret');
 const response=health();Object.defineProperty(response,'redirected',{value:true});expect((await checkAvailability(async()=>response)).availabilityPassed).toBe(false);
});
