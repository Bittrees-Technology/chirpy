// Redis server time and immutable claim tokens fence concurrent workers. A lease
// expiry never clears the separate durable SDK journal or authorizes a resend.
export const CLAIM_INBOUND_JOB = `
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local candidates=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',now,'LIMIT',0,50)
for _,key in ipairs(candidates) do
  local suffix=string.sub(key,string.len(ARGV[1])+1)
  if string.sub(key,1,string.len(ARGV[1]))~=ARGV[1] or string.len(suffix)~=64 or not string.match(suffix,'^[0-9a-f]+$') then
    redis.call('ZREM',KEYS[1],key)
  else
    local raw=redis.call('GET',key)
    if not raw then redis.call('ZREM',KEYS[1],key)
    else
      local ok,j=pcall(cjson.decode,raw)
      if not ok or type(j)~='table' or (j.status~='queued' and j.status~='sending') then
        redis.call('ZREM',KEYS[1],key)
      elseif j.status=='sending' and tonumber(j.leaseUntil or 0)>now then
        redis.call('ZADD',KEYS[1],j.leaseUntil,key)
      else
        j.status='sending';j.token=ARGV[2];j.leaseUntil=now+120000;j.attempts=tonumber(j.attempts or 0)+1
        redis.call('SET',key,cjson.encode(j),'KEEPTTL');redis.call('ZADD',KEYS[1],j.leaseUntil,key)
        return cjson.encode({key=key,job=j})
      end
    end
  end
end
return false
`;

export const FENCE_INBOUND_JOB = `
local raw=redis.call('GET',KEYS[1]);if not raw then return 0 end
local j=cjson.decode(raw);local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
if j.status~='sending' or j.token~=ARGV[1] or j.leaseUntil<=now or j.deadline<=now or redis.call('EXISTS',KEYS[2])~=1 then return 0 end
return 1
`;

export const FINISH_INBOUND_JOB = `
local raw=redis.call('GET',KEYS[1]);if not raw then return 'missing' end
local j=cjson.decode(raw)
if j.status~='sending' or j.token~=ARGV[1] then return 'superseded' end
local t=redis.call('TIME');local now=tonumber(t[1])*1000+math.floor(tonumber(t[2])/1000)
local status=ARGV[2]
if status~='queued' and status~='published' and status~='stopped' and status~='uncertain' then return redis.error_reply('Invalid outcome') end
if status=='queued' and (tonumber(j.deadline or 0)<=now or redis.call('EXISTS',KEYS[2])~=1) then status='stopped' end
j.status=status;j.token=nil;j.leaseUntil=nil;j.updatedAt=now
if status=='published' then j.publicationHash=ARGV[3] end
redis.call('SET',KEYS[1],cjson.encode(j),'KEEPTTL')
if status=='queued' then
  local delay=math.min(3600000,30000*2^math.min(7,j.attempts-1))
  redis.call('ZADD',KEYS[3],now+delay,KEYS[1])
else
  redis.call('ZREM',KEYS[3],KEYS[1])
  if status~='uncertain' then redis.call('DEL',KEYS[2]) end
end
return status
`;
