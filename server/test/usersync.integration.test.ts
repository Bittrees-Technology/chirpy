import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { keccak256, stringToHex } from "viem";
import { syncGrantMessage, syncWriteMessage, syncRevokeAllMessage, syncRevokeDeviceMessage } from "../../packages/core/src/syncAuth";
const container = process.env.CHIRPY_TEST_REDIS_CONTAINER;
const exec = promisify(execFile);
const service = "https://chirpy.test/api/usersync";
// A dedicated ephemeral Redis container is supplied locally or by the CI service.
describe.skipIf(!container)("real Redis sync transactions", () => {
  let server; let handler; let writeDelay = 0; let beforeWrite: (() => Promise<void>) | undefined;
  const ownedKeys = new Set<string>();
  async function redis(args: string[]) {
    const { stdout } = await exec("docker", ["exec", container!, "redis-cli", "--json", ...args], { maxBuffer: 2_000_000 });
    return JSON.parse(stdout);
  }
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      try {
        let body = ""; for await (const chunk of req) body += chunk;
        const command = JSON.parse(body) as string[];
        if (command[0] === "EVAL") for (const key of command.slice(3, 3 + Number(command[2]))) ownedKeys.add(key);
        if (writeDelay && command[0] === "EVAL" && Number(command[2]) === 4) await new Promise((resolve) => setTimeout(resolve, writeDelay));
        if (beforeWrite && command[0] === 'EVAL' && Number(command[2]) === 4) await beforeWrite();
        const result = await redis(command);
        res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ result }));
      } catch { res.statusCode = 503; res.end('{}'); }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    vi.stubEnv("KV_REST_API_URL", `http://127.0.0.1:${server.address().port}`);
    vi.stubEnv("KV_REST_API_TOKEN", "synthetic-test"); vi.stubEnv("CHIRPY_SYNC_SERVICE_URL", service);
    vi.resetModules(); handler = (await import("../../api/usersync.js")).default;
  });
  afterAll(async () => {
    if (ownedKeys.size) await redis(["DEL", ...ownedKeys]);
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(resolve));
    vi.unstubAllEnvs();
  });
  async function call(body: any, method = "POST") {
    const response = { code: 0, body: null as any, setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
    await handler({ method, headers: { "content-type": "application/json" }, query: { address: body.address }, body }, response);
    return response;
  }
  async function session() {
    const wallet = privateKeyToAccount(generatePrivateKey()); const device = privateKeyToAccount(generatePrivateKey());
    const grant = { version: 2 as const, service, address: wallet.address, device: device.address, epoch: 0, issuedAt: Date.now(), expiresAt: Date.now() + 60_000 };
    const authorization = { ...grant, signature: await wallet.signMessage({ message: syncGrantMessage(grant) }) };
    const write = async (blob: string, expectedRevision = 0) => ({ action: "write", address: wallet.address, authorization, blob, expectedRevision, signature: await device.signMessage({ message: syncWriteMessage(grant, expectedRevision, keccak256(stringToHex(blob))) }) });
    return { wallet, device, grant, authorization, write };
  }
  it("executes CAS and revoke-all atomically under concurrent signed requests", async () => {
    const sessionA = await session();
    const a = await sessionA.write("first"); const b = await sessionA.write("second");
    const results = await Promise.all([call(a), call(b)]);
    expect(results.map((result) => result.code).sort()).toEqual([200, 409]);
    const expiresAt = Date.now() + 60_000;
    const revoke = { action: "revoke-all", address: sessionA.wallet.address, epoch: 0, expiresAt, signature: await sessionA.wallet.signMessage({ message: syncRevokeAllMessage(service, sessionA.wallet.address, 0, expiresAt) }) };
    const delayed = await sessionA.write("racing", 1);
    const race = await Promise.all([call(delayed), call(revoke)]);
    expect([200, 403]).toContain(race[0].code); expect(race[1].code).toBe(200);
    const latest = await call({ address: sessionA.wallet.address }, "GET");
    expect(latest.body.epoch).toBe(1);
    expect((await call(await sessionA.write("after-revocation", latest.body.revision))).code).toBe(403);
    expect((await call(revoke)).code).toBe(409);
  });
  it("rejects a grant that expires while its write is waiting for storage", async () => {
    const sessionA = await session();
    sessionA.authorization.expiresAt = Date.now() + 500;
    sessionA.grant.expiresAt = sessionA.authorization.expiresAt;
    sessionA.authorization.signature = await sessionA.wallet.signMessage({ message: syncGrantMessage(sessionA.grant) });
    writeDelay = 750;
    try { expect((await call(await sessionA.write("expired-in-transit"))).code).toBe(401); }
    finally { writeDelay = 0; }
  });
  it("stores a real expiring device denial and rejects later valid signatures", async () => {
    const sessionA = await session();
    const request = { action: "revoke-device", address: sessionA.wallet.address, authorization: sessionA.authorization, signature: await sessionA.device.signMessage({ message: syncRevokeDeviceMessage(sessionA.grant) }) };
    expect((await call(request)).code).toBe(200);
    expect((await call(await sessionA.write("denied"))).code).toBe(403);
    const revocation = Array.from(ownedKeys).find((key) => key.startsWith(`chirpy:usersync:revoked:${sessionA.wallet.address.toLowerCase()}:`));
    expect(await redis(["PTTL", revocation!])).toBeGreaterThan(0);
  });
  const upgraded = (address: string, payloadVersion = 2) => JSON.stringify({ version: 1, algorithm: 'AES-GCM', kdf: 'HKDF-SHA-256', address, iv: Buffer.alloc(12).toString('base64'), ciphertext: Buffer.alloc(16).toString('base64'), updatedAt: 1, payloadVersion });
  it("serializes racing old/new-format clients and permanently rejects downgrade after an accepted upgrade", async () => {
    const current = await session(), upgradedBlob = upgraded(current.wallet.address);
    const races = await Promise.all([call(await current.write('legacy')), call(await current.write(upgradedBlob))]);
    expect(races.map(result => result.code).sort()).toEqual([200,409]);
    let latest = await call({address:current.wallet.address},'GET');
    if (latest.body.minPayloadVersion === 1) {
      expect(latest.body.blob).toBe('legacy');
      expect((await call(await current.write(upgradedBlob,latest.body.revision))).code).toBe(200);
      latest = await call({address:current.wallet.address},'GET');
    }
    expect(latest.body.minPayloadVersion).toBe(2);
    const revision=latest.body.revision,key='chirpy:usersync:payload-v2:'+current.wallet.address.toLowerCase(),raw=await redis(['GET',key]);
    for (const blob of ['legacy offline copy', JSON.stringify({version:1,ciphertext:'old'}), upgraded(current.wallet.address,3)]) {
      expect([400,426]).toContain((await call(await current.write(blob,revision))).code);
      expect(await redis(['GET',key])).toBe(raw);
    }
    expect((await call(await current.write(upgradedBlob,revision))).code).toBe(200);
    expect((await call({address:current.wallet.address},'GET')).body).toMatchObject({revision:revision+1,minPayloadVersion:2,blob:upgradedBlob});
    expect(await redis(['TTL',key])).toBe(-1);
  });
  it("a grant expiring during an upgrade cannot advance the format floor", async () => {
    const current=await session();expect((await call(await current.write('legacy'))).code).toBe(200);
    current.grant.expiresAt=Date.now()+500;current.authorization.expiresAt=current.grant.expiresAt;
    current.authorization.signature=await current.wallet.signMessage({message:syncGrantMessage(current.grant)});
    writeDelay=750;
    try {expect((await call(await current.write(upgraded(current.wallet.address),1))).code).toBe(401);} finally {writeDelay=0;}
    expect((await call({address:current.wallet.address},'GET')).body).toMatchObject({revision:1,minPayloadVersion:1,blob:'legacy'});
  });
  it("keeps safe-integer revisions exact and refuses corrupt floors without changing bytes", async () => {
    const current=await session(),key='chirpy:usersync:'+current.wallet.address.toLowerCase();ownedKeys.add(key);
    await redis(['SET',key,JSON.stringify({blob:'legacy',revision:Number.MAX_SAFE_INTEGER-2,updatedAt:1})]);
    expect((await call(await current.write(upgraded(current.wallet.address),Number.MAX_SAFE_INTEGER-2))).code).toBe(200);
    const upgradedKey='chirpy:usersync:payload-v2:'+current.wallet.address.toLowerCase();
    const stored=await redis(['GET',upgradedKey]);expect(stored).toContain('"revision":9007199254740990');
    expect((await call(await current.write(upgraded(current.wallet.address),Number.MAX_SAFE_INTEGER-1))).code).toBe(409);
    expect(await redis(['GET',upgradedKey])).toBe(stored);
    await redis(['DEL',upgradedKey]);
    for (const raw of ['bad bytes',JSON.stringify({blob:'legacy',updatedAt:1,revision:0,minPayloadVersion:2}),JSON.stringify({blob:'legacy',updatedAt:1,revision:0,minPayloadVersion:99})]) {
      await redis(['SET',key,raw]);expect((await call({address:current.wallet.address},'GET')).code).toBe(503);
      expect((await call(await current.write(upgraded(current.wallet.address)))).code).toBe(503);expect(await redis(['GET',key])).toBe(raw);
    }
  });

  it("an old deployed API can modify only the retained legacy slot after upgrade", async () => {
    const current=await session(),legacy='chirpy:usersync:'+current.wallet.address.toLowerCase();
    expect((await call(await current.write('legacy initial'))).code).toBe(200);
    const blob=upgraded(current.wallet.address);expect((await call(await current.write(blob,1))).code).toBe(200);
    const protectedKey='chirpy:usersync:payload-v2:'+current.wallet.address.toLowerCase(),snapshot=await redis(['GET',protectedKey]);
    // Original deployed CAS behavior: it knows only the legacy data key.
    const oldCas=`local raw=redis.call('GET',KEYS[1]); local current=raw and cjson.decode(raw) or {}; local revision=tonumber(current.revision) or 0; if revision~=tonumber(ARGV[1]) then return {0,revision} end; local next=cjson.decode(ARGV[2]); next.revision=revision+1; redis.call('SET',KEYS[1],cjson.encode(next)); return {1,next.revision}`;
    expect(await redis(['EVAL',oldCas,'1',legacy,'1',JSON.stringify({blob:'older handler update',updatedAt:2})])).toEqual([1,2]);
    expect(await redis(['GET',protectedKey])).toBe(snapshot);
    expect((await call({address:current.wallet.address},'GET')).body).toMatchObject({blob,revision:2,minPayloadVersion:2});
    expect((await call(await current.write('legacy current API attempt',2))).code).toBe(426);
    // Even broken legacy storage cannot hide the upgraded copy.
    await redis(['SET',legacy,'damaged legacy bytes']);
    expect((await call({address:current.wallet.address},'GET')).body.blob).toBe(blob);
    expect((await call(await current.write(blob,2))).code).toBe(200);
    await redis(['SET',legacy,JSON.stringify({blob:'readable legacy',revision:99,updatedAt:1})]);
    await redis(['SET',protectedKey,'damaged upgraded bytes']);
    expect((await call({address:current.wallet.address},'GET')).code).toBe(503);
    expect((await call(await current.write(blob,3))).code).toBe(503);
    expect(await redis(['GET',protectedKey])).toBe('damaged upgraded bytes');
  });
  it("a legacy write between snapshot and upgrade forces a reread without creating the protected slot", async () => {
    const current=await session(),legacy='chirpy:usersync:'+current.wallet.address.toLowerCase();
    expect((await call(await current.write('initial'))).code).toBe(200);
    let entered=false,release!:()=>void;beforeWrite=()=>new Promise(resolve=>{entered=true;release=resolve;});
    const request=await current.write(upgraded(current.wallet.address),1),pending=call(request);
    try {
      await vi.waitFor(()=>expect(entered).toBe(true));
      const concurrent=JSON.stringify({blob:'concurrent legacy write',updatedAt:2,revision:1});
      await redis(['SET',legacy,concurrent]);release();expect((await pending).code).toBe(409);
      expect(await redis(['GET','chirpy:usersync:payload-v2:'+current.wallet.address.toLowerCase()])).toBe(null);
      expect(await redis(['GET',legacy])).toBe(concurrent);
    } finally {beforeWrite=undefined;release?.();await pending;}
  });

  it("revocation while an upgrade waits at storage prevents the protected record from being established", async () => {
    const current=await session();expect((await call(await current.write('legacy'))).code).toBe(200);
    let entered=false,release!:()=>void;beforeWrite=()=>new Promise(resolve=>{entered=true;release=resolve;});
    const pending=call(await current.write(upgraded(current.wallet.address),1));
    try {
      await vi.waitFor(()=>expect(entered).toBe(true));
      expect((await call({action:'revoke-device',address:current.wallet.address,authorization:current.authorization,signature:await current.device.signMessage({message:syncRevokeDeviceMessage(current.grant)})})).code).toBe(200);
      release();expect((await pending).code).toBe(403);
      expect(await redis(['GET','chirpy:usersync:payload-v2:'+current.wallet.address.toLowerCase()])).toBe(null);
      expect((await call({address:current.wallet.address},'GET')).body).toMatchObject({blob:'legacy',revision:1,minPayloadVersion:1});
    } finally {beforeWrite=undefined;release?.();await pending;}
  });

  it('runs real client crypto, capability negotiation and signed upgrade against Redis while old clients replay legacy data', async () => {
    const current = await session(), owner = current.wallet.address.toLowerCase();
    const { readVersionedSync, decryptVersionedSync, authorizeVersionedSync, writeVersionedSync } = await import('../../apps/web/src/versionedSyncTransport');
    const { encryptSyncPayloadV2 } = await import('../../apps/web/src/versionedSyncCipher');
    const { editSyncPayloadV2 } = await import('../../apps/web/src/versionedSync');
    const key = await crypto.subtle.importKey('raw', new Uint8Array(32).fill(8), 'AES-GCM', false, ['encrypt', 'decrypt']);
    const legacy = { version: 1, settingsPrefs: { readReceiptsDefault: false, syncAcrossDevices: true, blocked: [current.device.address] }, savedMessages: [{ id: 'legacy', body: 'preserve before explicit deletion', custom: { synthetic: true } }], updatedAt: 10 };
    const iv = new Uint8Array(12).fill(9), encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(legacy)));
    const oldBlob = JSON.stringify({ version: 1, algorithm: 'AES-GCM', kdf: 'HKDF-SHA-256', address: owner, iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(encrypted).toString('base64'), updatedAt: 10 });
    expect((await call(await current.write(oldBlob))).code).toBe(200);
    const realFetch = globalThis.fetch;
    vi.stubGlobal('window', { location: { href: 'https://chirpy.test/' } });
    vi.stubGlobal('fetch', async (input, options) => {
      const url = new URL(String(input), 'https://chirpy.test');
      if (url.href.startsWith(service)) {
        const result = options?.method === 'POST' ? await call(JSON.parse(options.body)) : await call({ address: url.searchParams.get('address') }, 'GET');
        return new Response(JSON.stringify(result.body), { status: result.code, headers: { 'content-type': 'application/json' } });
      }
      return realFetch(input, options);
    });
    try {
      const guard = () => {}, initial = await readVersionedSync(owner, 1, guard);
      const authorization = await authorizeVersionedSync(initial, message => current.wallet.signMessage({ message }), guard);
      const decoded = await decryptVersionedSync(initial, key);
      expect(decoded!.savedMessages.legacy.value).toEqual(legacy.savedMessages[0]);
      const deleted = editSyncPayloadV2(decoded, { kind: 'savedMessage', id: 'legacy', value: null }, 20);
      const unblocked = editSyncPayloadV2(deleted, { kind: 'block', address: current.device.address, value: false }, 21);
      const envelope = await encryptSyncPayloadV2(unblocked, key, owner);
      const latest = await writeVersionedSync(initial, authorization, envelope, guard);
      expect(latest).toMatchObject({ revision: 2, minimum: 2 });
      expect(await decryptVersionedSync(latest, key)).toEqual(unblocked);
      await expect(writeVersionedSync(initial, authorization, envelope, guard)).rejects.toMatchObject({ reason: 'stale' });
      expect((await call(await current.write(oldBlob, 2))).code).toBe(426);
      // Simulate an immutable older handler, which only knows the retained legacy slot.
      await redis(['SET', 'chirpy:usersync:' + owner, JSON.stringify({ blob: oldBlob, updatedAt: Date.now(), revision: 100 })]);
      const reread = await readVersionedSync(owner, 2, guard);
      expect(reread.revision).toBe(2); expect(await decryptVersionedSync(reread, key)).toEqual(unblocked);
      expect(await redis(['TTL', 'chirpy:usersync:payload-v2:' + owner])).toBe(-1);
    } finally { vi.unstubAllGlobals(); }
  });

});
