import { constants, lstatSync, realpathSync } from 'node:fs';
import { open, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const gateReceiptName = 'chat-gate-installation.json';
export const gateAttemptName = 'chat-gate-registration-attempt.json';
const hexId = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const keyDigest = config => createHash('sha256').update(config.databaseKey).digest('hex');
function owned(meta) {
  return meta.uid === process.getuid() && !(meta.mode & 0o022);
}
export function requireGateDirectory(path) {
  const meta = lstatSync(path);
  if (!meta.isDirectory() || meta.isSymbolicLink() || meta.uid !== process.getuid() || (meta.mode & 0o077)) {
    throw new Error('Gate storage must be an existing private owned directory.');
  }
  return realpathSync(path);
}
export function gateDatabasePath(directory, inboxId, { mustExist = true } = {}) {
  if (!hexId(inboxId)) throw new Error('Invalid gate inbox identifier.');
  const path = join(directory, `chirpy-xmtp-gatekeeper-${inboxId}.db3`);
  for (const suffix of ['', '-wal', '-shm']) {
    let meta;
    try { meta = lstatSync(path + suffix); }
    catch (error) { if (error.code === 'ENOENT' && (suffix || !mustExist)) continue; throw error; }
    if (!meta.isFile() || meta.isSymbolicLink() || meta.nlink !== 1 || !owned(meta) || (!suffix && !meta.size)) {
      throw new Error('Gate database metadata is unsafe; reconcile storage before startup.');
    }
  }
  return path;
}
async function syncDirectory(directory) {
  const fd = await open(directory, constants.O_RDONLY);
  try { await fd.sync(); } finally { await fd.close(); }
}
async function exclusiveJson(directory, name, value) {
  const fd = await open(join(directory, name), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { await fd.writeFile(JSON.stringify(value) + '\n'); await fd.sync(); } finally { await fd.close(); }
  await syncDirectory(directory);
}
export async function reserveGateRegistration(config, address) {
  // An empty directory is an explicit first provision, never a recovery shortcut.
  try { await mkdir(config.dataDir, { mode: 0o700 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  const directory = requireGateDirectory(config.dataDir);
  if ((await readdir(directory)).length) throw new Error('Gate storage is not empty; never retry registration or overwrite an installation.');
  await exclusiveJson(directory, gateAttemptName, { version: 1, operation: randomUUID(), address, network: config.network, startedAt: Date.now() });
  return directory;
}
export async function readGateInstallation(config, address) {
  const directory = requireGateDirectory(config.dataDir);
  const fd = await open(join(directory, gateReceiptName), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let receipt;
  try {
    const meta = await fd.stat();
    if (!meta.isFile() || meta.nlink !== 1 || meta.uid !== process.getuid() || (meta.mode & 0o077) || meta.size > 4096) throw new Error('Unsafe gate installation receipt.');
    const bytes = Buffer.alloc(4097);
    const { bytesRead } = await fd.read(bytes, 0, bytes.length, 0);
    if (bytesRead > 4096) throw new Error('Oversized gate installation receipt.');
    receipt = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'));
  } finally { await fd.close(); }
  if (receipt?.version !== 1 || receipt.address !== address || receipt.network !== config.network || receipt.databaseKeyDigest !== keyDigest(config) || !hexId(receipt.inboxId) || !hexId(receipt.installationId)) {
    throw new Error('Gate installation binding does not match; preserve storage and reconcile.');
  }
  gateDatabasePath(directory, receipt.inboxId);
  return { directory, receipt };
}
export function requireRegisteredGate(client, receipt) {
  if (client.isRegistered !== true || !hexId(client.inboxId) || !hexId(client.installationId) ||
    (receipt && (receipt.inboxId !== client.inboxId || receipt.installationId !== client.installationId))) {
    throw new Error('Gate installation is unregistered or changed; automatic registration is forbidden.');
  }
}
export async function sealGateInstallation(directory, config, address, client) {
  requireRegisteredGate(client);
  gateDatabasePath(directory, client.inboxId);
  const receipt = { version: 1, address, network: config.network, databaseKeyDigest: keyDigest(config), inboxId: client.inboxId, installationId: client.installationId };
  await exclusiveJson(directory, gateReceiptName, receipt);
  return receipt;
}
