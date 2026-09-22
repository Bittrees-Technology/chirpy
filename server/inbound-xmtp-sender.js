// Runs only inside the supervised sender child, never in an HTTP handler.
import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { validInboundMail, inboundMailScope, inboundMailText } from './inbound-mail-contract.js';
import { checkInboundSource } from './inbound-source-process.js';
import { resolveInboundMail } from './inbound-mail.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const wallet = value => typeof value === 'string' && /^0x[a-f0-9]{40}$/.test(value);
export function inboundSenderIdentity(config) {
  if (!config || !['dev', 'production'].includes(config.network) || !wallet(config.address) ||
    !hex(config.inboxId) || !hex(config.installationId) || !hex(config.databaseKey) ||
    typeof config.directory !== 'string' || !isAbsolute(config.directory) || /[\x00-\x1f\x7f]/.test(config.directory)) {
    throw Error('Invalid dedicated sender configuration');
  }
  let endpoint;
  try { endpoint = new URL(config.identity?.url); } catch { throw Error('Invalid Wallet service configuration'); }
  if (endpoint.protocol !== 'https:' || endpoint.pathname !== '/api/service/inbound' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
    typeof config.identity?.credential !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(config.identity.credential)) throw Error('Invalid Wallet service configuration');
  return hash(JSON.stringify(['chat-mail-sender-v1', config.network, config.address,
    config.inboxId, config.installationId, config.directory, hash(config.databaseKey), endpoint.href]));
}
function privateDatabase(directory) {
  const path = join(directory, 'xmtp.db3');
  for (const [entry, isDirectory] of [[dirname(path), true], [path, false]]) {
    const stat = lstatSync(entry);
    if (stat.isSymbolicLink() || (stat.mode & 0o077) || (isDirectory ? !stat.isDirectory() : !stat.isFile())) {
      throw Error('Private pre-registered sender database required');
    }
  }
  return path;
}
function validateInput(input) {
  if (!input || Object.keys(input).length !== 4 || !validInboundMail(input.event) ||
    !input.recipient || Object.keys(input.recipient).length !== 2 || !wallet(input.recipient.wallet) ||
    !Number.isSafeInteger(input.recipient.expiresAt) || input.recipient.expiresAt <= Date.now() ||
    input.recipient.expiresAt > Date.now() + 23 * 3600000 || input.text !== inboundMailText(input.event)) {
    throw Error('Invalid sender input');
  }
  const expected = { eventId: input.event.id, contentHash: inboundMailScope(input.event).contentHash,
    recipientHash: hash(input.recipient.wallet), textHash: hash(input.text) };
  if (!input.scope || Object.keys(input.scope).length !== 4 ||
    !Object.keys(expected).every(key => Object.hasOwn(input.scope, key) && input.scope[key] === expected[key])) {
    throw Error('Invalid sender scope');
  }
}

export async function publishInboundXmtp(journal, configuration, payload, {
  loadSdk = () => import('@xmtp/node-sdk'),
  sourceCheck = checkInboundSource,
  recipientCheck = resolveInboundMail,
} = {}) {
  // Private deployment config and queued input must not mutate across awaits.
  const config = JSON.parse(JSON.stringify(configuration));
  const input = JSON.parse(JSON.stringify(payload));
  const identity = inboundSenderIdentity(config);
  validateInput(input);
  const dbPath = privateDatabase(config.directory);
  // One durable claim, before importing/opening native SDK code. A restarted
  // child cannot turn an existing armed attempt into a second SDK launch.
  if (!journal.claimLaunch(input.scope, identity)) throw Error('Sender launch already consumed');
  const authorize = async () => {
    validateInput(input);
    if (await sourceCheck(config.source, input.event) !== true) throw Error('Source authorization denied');
    const current = await recipientCheck({ identity: config.identity }, inboundMailScope(input.event));
    if (!current || current.wallet !== input.recipient.wallet || current.expiresAt <= Date.now()) {
      throw Error('Recipient authorization denied');
    }
    validateInput(input); // Original event/recipient deadline cannot be extended.
  };
  await authorize();
  const sdk = await loadSdk();
  const client = await sdk.Client.build({ identifier: config.address, identifierKind: sdk.IdentifierKind.Ethereum }, {
    env: config.network, dbPath, dbEncryptionKey: Buffer.from(config.databaseKey, 'hex'),
    disableDeviceSync: true, disableAutoRegister: true, loggingLevel: sdk.LogLevel.Off,
  });
  if (!client.isRegistered || client.inboxId !== config.inboxId || client.installationId !== config.installationId) {
    throw Error('Dedicated sender identity mismatch');
  }
  const identifier = { identifier: input.recipient.wallet, identifierKind: sdk.IdentifierKind.Ethereum };
  const peer = await client.fetchInboxIdByIdentifier(identifier);
  if (!hex(peer) || peer === config.inboxId) throw Error('Recipient inbox unavailable');
  const dm = await client.conversations.createDm(peer);
  if (dm.peerInboxId !== peer || typeof dm.id !== 'string' || !/^[a-f0-9]{32,64}$/.test(dm.id)) throw Error('Recipient conversation mismatch');
  const members = await dm.members();
  if (members.length !== 2 || ![config.inboxId, peer].every(id => members.some(member => member.inboxId === id))) {
    throw Error('Unexpected conversation membership');
  }
  // Creating/finding the conversation may take time. Recheck all authority after
  // that work and verify that the wallet still resolves to the pinned inbox.
  if (await client.fetchInboxIdByIdentifier(identifier) !== peer) throw Error('Recipient inbox changed');
  await authorize();
  validateInput(input);
  const messageId = await dm.sendText(input.text, false);
  if (!hex(messageId)) throw Error('Invalid published message identifier');
  // Local lookup only: sync/publish/retry could publish an older uncertain intent.
  const message = client.conversations.getMessageById(messageId);
  const type = message?.contentType;
  if (!message || message.id !== messageId || message.deliveryStatus !== sdk.DeliveryStatus.Published ||
    message.kind !== sdk.GroupMessageKind.Application || message.conversationId !== dm.id ||
    message.senderInboxId !== config.inboxId || message.content !== input.text ||
    type?.authorityId !== 'xmtp.org' || type.typeId !== 'text' || type.versionMajor !== 1 || type.versionMinor !== 0) {
    throw Error('Exact publication could not be verified');
  }
  return { scope: input.scope, receipt: { messageId, conversationId: dm.id,
    senderInboxId: config.inboxId, textHash: input.scope.textHash } };
}
