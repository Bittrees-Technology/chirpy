import {createHash} from 'node:crypto';
const hash=value=>createHash('sha256').update(value).digest('hex');
// Match provider evidence to the exact service, provider ID and private recipient key.
export const mailDeliveryKey=(config,providerId,recipientKey)=>`${config.prefix}delivery:${hash(`${providerId}\n${recipientKey}`)}`;

// Keep independent facts so arrival order cannot turn a bounce into a success.
// No job/payload/queue writes; existing expiry is never extended.
export const APPLY_MAIL_DELIVERY_EVENT=`
local prior=redis.call('GET',KEYS[1])
if prior then if prior==ARGV[1] then return 'duplicate' else return 'conflict' end end
local legacy=redis.call('GET',KEYS[3])
if legacy and legacy~=ARGV[2] then return 'conflict' end
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local at=tonumber(ARGV[5]); if not at or at<0 or at>now+300000 or at~=math.floor(at) then return 'invalid' end
local allowed={sent=true,delivered=true,delivery_delayed=true,failed=true,bounced=true,complained=true,suppressed=true}
if not allowed[ARGV[4]] then return 'invalid' end
-- Suppression remains durable even if separately stored delivery evidence is damaged.
if ARGV[3]~='' then
 redis.call('SET',KEYS[4],ARGV[3],'NX')
 redis.call('SET',KEYS[3],ARGV[2],'NX','EX',2592000)
end
if at==0 then
 if ARGV[3]=='' then return 'invalid' end
 redis.call('SET',KEYS[1],ARGV[1],'EX',2592000); return 'applied'
end
local raw=redis.call('GET',KEYS[2]); local events={}; local seen={}; local found=false
if raw then
 if #raw>2048 then return 'invalid' end
 local data=cjson.decode(raw)
 if data.version~=1 or type(data.events)~='table' or #data.events>7 then return 'invalid' end
 for _,e in ipairs(data.events) do
  if type(e)~='table' or not allowed[e.type] or seen[e.type] or type(e.occurredAt)~='number' or e.occurredAt<=0 or e.occurredAt>now+300000 or e.occurredAt~=math.floor(e.occurredAt) then return 'invalid' end
  seen[e.type]=true
  if e.type==ARGV[4] then e.occurredAt=math.max(e.occurredAt,at); found=true end
  table.insert(events,{type=e.type,occurredAt=e.occurredAt})
 end
 if redis.call('PTTL',KEYS[2])<=0 then return 'invalid' end
end
if not found then table.insert(events,{type=ARGV[4],occurredAt=at}) end
local value=cjson.encode({version=1,events=events})
if raw then redis.call('SET',KEYS[2],value,'KEEPTTL') else redis.call('SET',KEYS[2],value,'PX',2592000000) end
redis.call('SET',KEYS[1],ARGV[1],'EX',2592000)
return 'applied'
`;
