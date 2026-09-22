import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InboundSendJournal } from '../inbound-send-journal.js';
import { sendInboundInProcess } from '../inbound-sender-process.js';
import { inboundEvent } from './helpers/inbound-mail-fixture.js';

const roots: string[] = [], journals: any[] = [];
const recipient = () => ({ wallet: '0x' + '3'.repeat(40), expiresAt: Date.now() + 60000 });
const identity = 'ab'.repeat(32);
function setup(body: string) {
  const root = mkdtempSync(join(tmpdir(), 'chat-sender-')); roots.push(root);
  const script = join(root, 'child.mjs'), marker = join(root, 'started');
  writeFileSync(script, `import {writeFileSync} from 'node:fs';
let raw='';for await(const part of process.stdin)raw+=part;
const input=JSON.parse(raw);writeFileSync(${JSON.stringify(marker)},String(process.pid));
const result={scope:input.scope,receipt:{messageId:'9a'.repeat(32),conversationId:'bc'.repeat(16),senderInboxId:'de'.repeat(32),textHash:input.scope.textHash}};
${body}`);
  const directory = join(root, 'bridge');
  const journal = InboundSendJournal.provision(directory, identity); journals.push(journal);
  return { root, marker, directory, journal, config: { node: process.execPath, script, config: join(root, 'config.json') } };
}
afterEach(() => {
  for (const journal of journals.splice(0)) try { journal.close(); } catch {}
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
it('stores an exact receipt only after child termination and never launches a duplicate', async () => {
  const s = setup('process.stdout.write(JSON.stringify(result));');
  const event = inboundEvent(), auth = recipient();
  expect((await sendInboundInProcess(s.journal, s.config, event, auth)).status).toBe('published');
  const pid = readFileSync(s.marker, 'utf8');
  expect(() => process.kill(Number(pid), 0)).toThrow();
  expect((await sendInboundInProcess(s.journal, s.config, event, auth)).status).toBe('published');
  expect(readFileSync(s.marker, 'utf8')).toBe(pid);
});
it('does not accept a printed receipt until a still-running sender is killed and closed', async () => {
  const s = setup('process.stdout.write(JSON.stringify(result));setInterval(()=>{},1000);');
  const event = inboundEvent();
  expect((await sendInboundInProcess(s.journal, s.config, event, recipient(), { timeoutMs: 700 })).status).toBe('uncertain');
  expect(() => process.kill(Number(readFileSync(s.marker, 'utf8')), 0)).toThrow();
  s.journal.close(); const reopened = new InboundSendJournal(s.directory, identity); journals.push(reopened);
  expect(reopened.inspect()).toEqual({ blocked: true, eventId: event.id });
  const pid = readFileSync(s.marker, 'utf8');
  expect((await sendInboundInProcess(reopened, s.config, event, recipient())).status).toBe('uncertain');
  expect(readFileSync(s.marker, 'utf8')).toBe(pid);
});
it.each([
  'process.stdout.write(JSON.stringify(result));process.exitCode=42;',
  'result.scope.recipientHash="ff".repeat(32);process.stdout.write(JSON.stringify(result));',
  'result.receipt.textHash="ff".repeat(32);process.stdout.write(JSON.stringify(result));',
  'process.stdout.write(Buffer.from([255]));',
  'process.stdout.write("x".repeat(4097));',
  'process.stderr.write("secret".repeat(1000));setInterval(()=>{},1000);',
])('leaves the journal armed on crash, mismatched or unbounded output (%#)', async body => {
  const s = setup(body), event = inboundEvent();
  expect((await sendInboundInProcess(s.journal, s.config, event, recipient())).status).toBe('uncertain');
  expect(s.journal.inspect()).toEqual({ blocked: true, eventId: event.id });
});
it('isolates the environment and does not open another sender while the guard is active', async () => {
  const s = setup('if(Object.keys(process.env).some(k=>!["HOME","PATH","LANG","__CF_USER_TEXT_ENCODING"].includes(k)))process.exit(3);process.stdout.write(JSON.stringify(result));');
  expect((await sendInboundInProcess(s.journal, s.config, inboundEvent(), recipient())).status).toBe('published');
  const other = setup('process.stdout.write(JSON.stringify(result));'), event = inboundEvent();
  other.journal.begin({ eventId: 'ef'.repeat(32), contentHash: '12'.repeat(32), recipientHash: '34'.repeat(32), textHash: '56'.repeat(32) });
  expect((await sendInboundInProcess(other.journal, other.config, event, recipient())).status).toBe('blocked');
  expect(existsSync(other.marker)).toBe(false);
});
it('rejects invalid configuration or expired authorization without arming or launching', async () => {
  const s = setup('process.stdout.write(JSON.stringify(result));'), event = inboundEvent();
  await expect(sendInboundInProcess(s.journal, { ...s.config, script: 'relative.mjs' }, event, recipient())).rejects.toThrow();
  await expect(sendInboundInProcess(s.journal, s.config, event, { ...recipient(), expiresAt: 1 })).rejects.toThrow();
  expect(s.journal.inspect().blocked).toBe(false); expect(existsSync(s.marker)).toBe(false);
});

it('kills the process group when a descendant keeps pipes open after the sender exits', async () => {
  const s = setup(`const {spawn}=await import('node:child_process');
const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit'});
writeFileSync(${JSON.stringify('PLACEHOLDER')},String(child.pid));
process.stdout.write(JSON.stringify(result));process.exit(0);`);
  const pidFile = join(s.root, 'descendant');
  writeFileSync(s.config.script, readFileSync(s.config.script, 'utf8').replace(JSON.stringify('PLACEHOLDER'), JSON.stringify(pidFile)));
  expect((await sendInboundInProcess(s.journal, s.config, inboundEvent(), recipient(), {timeoutMs:700})).status).toBe('uncertain');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  // Reaping an orphan is OS-owned; wait briefly for it without treating a printed
  // receipt as success. No message can be attempted while its guard remains set.
  let alive = true;
  for (let i=0;i<50;i++) { try {process.kill(pid,0);} catch {alive=false;break;} await new Promise(r=>setTimeout(r,20)); }
  expect(alive).toBe(false);expect(s.journal.inspect().blocked).toBe(true);
});

it('keeps the reservation durable when the configured executable cannot start', async () => {
  const s = setup('process.stdout.write(JSON.stringify(result));');
  expect((await sendInboundInProcess(s.journal, {...s.config,node:join(s.root,'missing-node')}, inboundEvent(), recipient())).status).toBe('uncertain');
  expect(s.journal.inspect().blocked).toBe(true);expect(existsSync(s.marker)).toBe(false);
});
