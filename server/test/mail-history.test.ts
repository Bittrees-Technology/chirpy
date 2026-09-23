import {it,expect,vi} from 'vitest';
import {backfillMailHistory} from '../mail-history.js';
import {hash} from '../mail-service.js';
const config={prefix:'test:'},wallet='0x'+'1'.repeat(40),id='a'.repeat(32),key=`test:job:${hash(`${wallet}\n${id}`)}`;
const job={wallet,id,createdAt:1700000000000,deadline:1700082800000,attempts:0,status:'queued'};
it('dry-runs a deduplicated page without writes or reading payloads',async()=>{
 const kv=vi.fn().mockResolvedValueOnce(['25',[key,key,key+':payload']]).mockResolvedValueOnce(JSON.stringify(job));
 expect(await backfillMailHistory(config,kv)).toEqual({cursor:'25',scanned:1,validated:1,indexed:0,missing:0,complete:false,applied:false});expect(kv.mock.calls.map(c=>c[0][0])).toEqual(['SCAN','GET']);
});
it('applies only a validated owned record to its wallet-derived index',async()=>{
 const kv=vi.fn().mockResolvedValueOnce(['0',[key]]).mockResolvedValueOnce(JSON.stringify(job)).mockResolvedValueOnce(1);
 expect(await backfillMailHistory(config,kv,{apply:true})).toMatchObject({indexed:1,complete:true});expect(kv.mock.calls[2][0].slice(2)).toEqual(['2',key,`test:history:${hash(wallet)}`,wallet,id,String(job.createdAt)]);
});
it('handles expiry between scan, read and index mutation',async()=>{
 const kv=vi.fn().mockResolvedValueOnce(['0',[key]]).mockResolvedValueOnce(null);expect(await backfillMailHistory(config,kv,{apply:true})).toMatchObject({missing:1,indexed:0});expect(kv).toHaveBeenCalledTimes(2);
 kv.mockReset().mockResolvedValueOnce(['0',[key]]).mockResolvedValueOnce(JSON.stringify(job)).mockResolvedValueOnce(0);expect(await backfillMailHistory(config,kv,{apply:true})).toMatchObject({validated:1,indexed:0});
});
it.each([{result:['0',Array(257).fill(key)]},{result:['invalid',[]]},{result:['0',['foreign:key']]},{result:null}])('fails closed on malformed or oversized scan pages',async({result})=>{
 const kv=vi.fn().mockResolvedValue(result);await expect(backfillMailHistory(config,kv,{apply:true})).rejects.toThrow('page');expect(kv).toHaveBeenCalledOnce();
});
it.each(['private-content',JSON.stringify({...job,wallet:'0x'+'2'.repeat(40)}),JSON.stringify({...job,attempts:9}),'x'.repeat(16385)])('refuses invalid retained records without writing or exposing their content',async raw=>{
 const kv=vi.fn().mockResolvedValueOnce(['0',[key]]).mockResolvedValueOnce(raw);await expect(backfillMailHistory(config,kv,{apply:true})).rejects.toThrow('Invalid retained mail record.');expect(kv).toHaveBeenCalledTimes(2);
});
it('rejects malformed options before accessing storage',async()=>{
 const kv=vi.fn();await expect(backfillMailHistory(config,kv,{cursor:'-1'})).rejects.toThrow('options');await expect(backfillMailHistory(config,kv,{apply:'yes' as any})).rejects.toThrow('options');expect(kv).not.toHaveBeenCalled();
});
