import {mailKv} from './mail-service.js';
const outcomes=['idle','queued','published','stopped','uncertain','missing','superseded','error'];
export const INBOUND_WORKER_TICK=`
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local last=cjson.null;local raw=redis.call('GET',KEYS[1])
if raw and string.len(raw)<=1024 then
 local ok,old=pcall(cjson.decode,raw)
 if ok and type(old)=='table' and type(old.lastSuccessAt)=='number' and old.lastSuccessAt<=now then last=old.lastSuccessAt end
end
if ARGV[2]=='1' then last=now end
redis.call('SET',KEYS[1],cjson.encode({lastAttemptAt=now,lastSuccessAt=last,lastOutcome=ARGV[1],successful=ARGV[2]=='1'}),'PX',2592000000)
return now
`;
export const INBOUND_WORKER_HEALTH=`
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local count=redis.call('ZCARD',KEYS[1]);local entries=redis.call('ZRANGE',KEYS[1],0,999,'WITHSCORES')
local due,expired,stale,orphaned,corrupt,oldest,active=0,0,0,0,0,0,false
for i=1,#entries,2 do
 local key=entries[i];local suffix=string.sub(key,string.len(ARGV[1])+1)
 if string.sub(key,1,string.len(ARGV[1]))~=ARGV[1] or string.len(suffix)~=64 or not string.match(suffix,'^[0-9a-f]+$') then corrupt=corrupt+1
 else
  local raw=redis.call('GET',key)
  if not raw then orphaned=orphaned+1
  elseif string.len(raw)>8192 then corrupt=corrupt+1
  else
   local ok,j=pcall(cjson.decode,raw)
   if not ok or type(j)~='table' or type(j.createdAt)~='number' or type(j.deadline)~='number' or j.createdAt>now or (j.status~='queued' and j.status~='sending') then corrupt=corrupt+1
   else
    oldest=math.max(oldest,now-j.createdAt)
    if tonumber(entries[i+1])<=now then due=due+1 end
    if j.deadline<=now then expired=expired+1 end
    if j.status=='sending' then
     if type(j.leaseUntil)~='number' or j.leaseUntil<=now then stale=stale+1
     elseif j.id==ARGV[2] and j.deadline>now then active=true end
    end
   end
  end
 end
end
local heartbeat=cjson.null;local badHeartbeat=false;local raw=redis.call('GET',KEYS[2])
if raw then
 local ok,h=false,nil;if string.len(raw)<=1024 then ok,h=pcall(cjson.decode,raw) end
 if ok and type(h)=='table' and type(h.lastAttemptAt)=='number' and h.lastAttemptAt<=now and h.lastAttemptAt>=0 and type(h.successful)=='boolean' and type(h.lastOutcome)=='string' and (h.lastSuccessAt==cjson.null or (type(h.lastSuccessAt)=='number' and h.lastSuccessAt>=0 and h.lastSuccessAt<=h.lastAttemptAt)) then heartbeat=h else badHeartbeat=true end
end
return cjson.encode({now=now,count=count,due=due,expired=expired,stale=stale,orphaned=orphaned,corrupt=corrupt,oldest=oldest,active=active,heartbeat=heartbeat,badHeartbeat=badHeartbeat})
`;

export async function recordInboundWorkerTick(config,status,blocked,storage=mailKv(config)){
  if(!outcomes.includes(status)||typeof blocked!=='boolean')throw Error('Invalid worker outcome');
  const successful=!blocked&&['idle','published','stopped'].includes(status);
  return storage(['EVAL',INBOUND_WORKER_TICK,'1',`${config.prefix}worker`,status,successful?'1':'0']);
}
export async function inspectInboundWorker(config,journal,storage=mailKv(config)){
  const guard=journal.inspect();
  const raw=await storage(['EVAL',INBOUND_WORKER_HEALTH,'2',`${config.prefix}queue`,`${config.prefix}worker`,`${config.prefix}job:`,guard.eventId||'']);
  if(typeof raw!=='string'||raw.length>4096)throw Error('Invalid worker health response');
  const h=JSON.parse(raw);
  if(!h||!['now','count','due','expired','stale','orphaned','corrupt','oldest'].every(k=>Number.isSafeInteger(h[k])&&h[k]>=0)||
    typeof h.active!=='boolean'||typeof h.badHeartbeat!=='boolean'||(h.heartbeat&&!outcomes.includes(h.heartbeat.lastOutcome)))throw Error('Invalid worker health response');
  const uncertain=guard.blocked&&!h.active;
  const fresh=h.heartbeat&&Number.isSafeInteger(h.heartbeat.lastSuccessAt)&&h.now-h.heartbeat.lastSuccessAt<=300000;
  const healthy=fresh&&h.heartbeat.successful&&!uncertain&&!h.badHeartbeat&&h.count<=1000&&
    h.oldest<=300000&&!h.expired&&!h.stale&&!h.orphaned&&!h.corrupt;
  return {status:healthy?'healthy':'degraded',checkedAt:h.now,
    queue:{pending:h.count,due:h.due,expired:h.expired,staleClaims:h.stale,orphaned:h.orphaned,corrupt:h.corrupt,oldestAgeMs:h.oldest},
    worker:{lastAttemptAt:h.heartbeat?.lastAttemptAt??null,lastSuccessAt:h.heartbeat?.lastSuccessAt??null,lastOutcome:h.heartbeat?.lastOutcome??null},
    sender:{guarded:guard.blocked,uncertain}};
}
