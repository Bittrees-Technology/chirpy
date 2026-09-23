// Every mutation uses Redis time. Bindings are private records supplied by the
// trusted verification authority, never by the browser's send request.
export const ENQUEUE_MAIL = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
-- Recheck the signed authorization at the atomic mutation, after storage delays.
if (tonumber(ARGV[5]) or 0)<=now then return {'expired'} end
local old=redis.call('GET',KEYS[1])
if old then local j=cjson.decode(old); if j.digest~=ARGV[1] then return {'conflict'} end; return {j.status} end
if redis.call('EXISTS',KEYS[7])==1 then return {'denied'} end
local raw=redis.call('GET',KEYS[3]); if not raw then return {'denied'} end
local b=cjson.decode(raw)
if b.version~=ARGV[3] or b.revoked or tonumber(b.expiresAt)<=now then return {'denied'} end
if tonumber(redis.call('GET',KEYS[4]) or '0')>=20 or tonumber(redis.call('GET',KEYS[5]) or '0')>=50 then return {'limited'} end
local j=cjson.decode(ARGV[2]); j.createdAt=now; j.updatedAt=now; j.deadline=now+82800000; j.status='queued'; j.attempts=0
redis.call('SET',KEYS[1],cjson.encode(j),'PX',2592000000)
redis.call('SET',KEYS[6],ARGV[4],'PX',86400000)
-- Keep only hashes so delivered links survive payload deletion and key rotation.
redis.call('SET',KEYS[8],KEYS[7],'NX')
redis.call('ZADD',KEYS[2],now,KEYS[1])
for i=4,5 do if redis.call('INCR',KEYS[i])==1 then redis.call('PEXPIRE',KEYS[i],86400000) end end
return {'queued'}
`;
export const CLAIM_MAIL = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local raw=redis.call('GET',KEYS[1]); if not raw then redis.call('ZREM',KEYS[2],KEYS[1]); return nil end
local j=cjson.decode(raw)
if j.status~='queued' and j.status~='sending' then redis.call('ZREM',KEYS[2],KEYS[1]); return nil end
if j.status=='sending' and tonumber(j.lockedUntil or 0)>now then return nil end
local score=redis.call('ZSCORE',KEYS[2],KEYS[1]); if score and tonumber(score)>now then return nil end
local br=redis.call('GET',KEYS[3]); local b=br and cjson.decode(br) or {}
local payload=redis.call('GET',KEYS[4])
if redis.call('EXISTS',KEYS[5])==1 or j.deadline<=now or j.attempts>=5 or not payload or b.version~=j.bindingVersion or b.revoked or tonumber(b.expiresAt or 0)<=now then
 j.status='stopped'; j.updatedAt=now; redis.call('DEL',KEYS[4]); redis.call('SET',KEYS[1],cjson.encode(j),'KEEPTTL'); redis.call('ZREM',KEYS[2],KEYS[1]); return nil
end
j.status='sending'; j.updatedAt=now; j.attempts=j.attempts+1; j.lease=ARGV[1]; j.lockedUntil=now+60000
redis.call('SET',KEYS[1],cjson.encode(j),'KEEPTTL'); redis.call('ZADD',KEYS[2],j.lockedUntil,KEYS[1])
return {cjson.encode(j),payload}
`;
export const FINISH_MAIL = `
local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
local j=cjson.decode(raw); if j.lease~=ARGV[1] or j.status~='sending' then return 0 end
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
j.providerId=ARGV[3]; j.lockedUntil=0; j.updatedAt=now
if ARGV[2]=='accepted' then j.status='accepted'
elseif ARGV[2]=='stopped' or j.attempts>=5 or now>=j.deadline then j.status='stopped'
else j.status='queued' end
if j.status=='queued' then redis.call('ZADD',KEYS[2],now+math.min(900000,60000*2^(j.attempts-1)),KEYS[1])
else redis.call('ZREM',KEYS[2],KEYS[1]); redis.call('DEL',KEYS[3]) end
redis.call('SET',KEYS[1],cjson.encode(j),'KEEPTTL'); return 1
`;

// Read-only operational snapshot; never expose job identifiers or payloads.
export const MAIL_WORKER_STATUS = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
local first=redis.call('ZRANGE',KEYS[1],0,0,'WITHSCORES')
local age=0
if #first>0 then age=math.max(0,now-tonumber(first[2])) end
return {now,redis.call('ZCARD',KEYS[1]),redis.call('ZCOUNT',KEYS[1],'-inf',now),age,tonumber(redis.call('GET',KEYS[2])) or 0}
`;
export const MAIL_WORKER_HEARTBEAT = `
local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)
redis.call('SET',KEYS[1],now,'EX',86400)
return now
`;

export const APPLY_MAIL_OPTOUT = `
if redis.call('GET',KEYS[1])~=KEYS[2] then return 'unknown' end
redis.call('SET',KEYS[2],ARGV[1],'NX')
return 'opted-out'
`;
