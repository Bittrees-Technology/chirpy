// Copied into a fresh runtime by test-mail-browser-bridge.mjs. Dev only.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { provisionInboundSender } from './server/inbound-provisioning.js';
import { InboundSendJournal, guardedInboundSend } from './server/inbound-send-journal.js';
import { inboundSenderIdentity, publishInboundXmtp } from './server/inbound-xmtp-sender.js';
import { inboundMailId, inboundMailScope, inboundMailText, INBOUND_MAIL_SOURCE } from './server/inbound-mail-contract.js';

assert.equal(process.platform, 'linux');
assert.equal(Number(process.versions.node.split('.')[0]), 24);
assert.equal(process.argv.length, 4);
assert.equal(process.argv[2], '--dev');
assert.match(process.argv[3], /^0x[a-f0-9]{40}$/);
const root = mkdtempSync(join(dirname(fileURLToPath(import.meta.url)), 'sender-fixture-'));
const timer = setTimeout(() => process.exit(2), 150_000);
const hash = value => createHash('sha256').update(value).digest('hex');
try {
  const installed = await provisionInboundSender({
    network: 'dev', directory: join(root, 'sender'),
    identity: { url: 'https://wallet.example/api/service/inbound', credential: 'synthetic-development-authority-not-used' },
    source: { python: '/usr/bin/python3', script: '/unavailable/check.py', config: '/unavailable/source.json', state: '/unavailable/source.sqlite' },
  });
  const config = JSON.parse(readFileSync(installed.config, 'utf8'));
  assert.equal(config.network, 'dev');
  assert.equal(config.enabled, false);
  const mailbox = 'synthetic@example.invalid';
  const messageId = hash(randomUUID());
  const event = {
    version: 1, source: INBOUND_MAIL_SOURCE, id: inboundMailId(mailbox, messageId), mailbox,
    bindingId: 'disposable-browser-acceptance', bindingVersion: 1, messageId,
    sourceVersion: hash('synthetic-source'), receivedAt: Date.now(),
    from: 'Synthetic sender <synthetic@example.invalid>', subject: 'Bridge browser acceptance',
    text: `Disposable bridge acceptance ${randomUUID()}`, truncated: false, automated: false, bridgeDepth: 0,
  };
  const recipient = { wallet: process.argv[3], expiresAt: Date.now() + 600_000 };
  const text = inboundMailText(event);
  const scope = { eventId: event.id, contentHash: inboundMailScope(event).contentHash, recipientHash: hash(recipient.wallet), textHash: hash(text) };
  const journal = new InboundSendJournal(config.directory, inboundSenderIdentity(config));
  try {
    let publicationError;
    const result = await guardedInboundSend(journal, scope, async () => {
      try {
        const published = await publishInboundXmtp(journal, config, { event, recipient, text, scope }, {
          // Only external Mail/Wallet authority is synthetic. Registration, SDK,
          // journal, MLS membership, send and exact publication lookup are real.
          sourceCheck: async (_, supplied) => { assert.deepEqual(supplied, event); return true; },
          recipientCheck: async (_, supplied) => { assert.deepEqual(supplied, inboundMailScope(event)); return recipient; },
        });
        return published.receipt;
      } catch (error) { publicationError = error; throw error; }
    });
    if (publicationError) throw publicationError;
    assert.equal(result.status, 'published');
    assert.equal(journal.inspect().blocked, false);
    const duplicate = await guardedInboundSend(journal, scope, () => { throw Error('Duplicate SDK launch'); });
    assert.deepEqual(duplicate, result);
    console.log('BRIDGE_RECEIPT=' + JSON.stringify({ network: 'dev', text, eventId: event.id, receipt: result.receipt }));
  } finally { journal.close(); }
  clearTimeout(timer);
  // Native SDK resources are process-owned. The parent removes the disposable
  // fixture only after this process exits, never while its database is open.
  process.exit(0);
} catch (error) {
  // Synthetic-only errors; no configuration, keys or database contents printed.
  console.error('Disposable bridge failed:', error instanceof Error ? error.message : 'unknown');
  process.exit(1);
}
