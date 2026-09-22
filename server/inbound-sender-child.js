// Entrypoint for inbound-sender-process.js, not an operator retry command.
import { openSync, fstatSync, readSync, closeSync, constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { InboundSendJournal } from './inbound-send-journal.js';
import { inboundSenderIdentity, publishInboundXmtp } from './inbound-xmtp-sender.js';

function terminate() {
  try { process.kill(-process.pid, 'SIGKILL'); } catch { process.kill(process.pid, 'SIGKILL'); }
}
// This deadline survives loss of the supervising parent. Kill this process group
// rather than just rejecting an async operation with native work still running.
const originalParent = Number(process.argv[5]);
if (!Number.isSafeInteger(originalParent) || originalParent <= 1 || process.ppid !== originalParent) terminate();
setTimeout(terminate, 55000);
setInterval(() => { if (process.ppid !== originalParent) terminate(); }, 250);
process.on('SIGTERM', terminate);
process.on('SIGINT', terminate);
process.stdout.on('error', terminate);

async function main() {
  if (process.platform === 'win32' || process.argv.length !== 6 || process.argv[2] !== '--config' || process.argv[4] !== '--parent-pid' || !isAbsolute(process.argv[3])) {
    throw Error('Invalid sender invocation');
  }
  const fd = openSync(process.argv[3], constants.O_RDONLY | constants.O_NOFOLLOW);
  let config;
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) || stat.size > 16384) throw Error('Private sender configuration required');
    const buffer = Buffer.alloc(16385); let bytes = 0;
    while (bytes < buffer.length) {
      const count = readSync(fd, buffer, bytes, buffer.length - bytes, null);
      if (!count) break; bytes += count;
    }
    if (bytes > 16384) throw Error('Sender configuration too large');
    config = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, bytes)));
  } finally { closeSync(fd); }
  if (config?.enabled !== true) throw Error('Sender disabled');
  const chunks = []; let bytes = 0;
  for await (const chunk of process.stdin) {
    bytes += chunk.length; if (bytes > 131072) throw Error('Input too large'); chunks.push(chunk);
  }
  const input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  const journal = new InboundSendJournal(config.directory, inboundSenderIdentity(config));
  try {
    const result = await publishInboundXmtp(journal, config, input);
    const output = JSON.stringify(result);
    if (Buffer.byteLength(output) > 4096) throw Error('Invalid sender output');
    // Explicit exit terminates the native runtime. The parent waits for close
    // before persisting the verified receipt and releasing its durable guard.
    process.stdout.write(output, () => process.exit(0));
  } finally { journal.close(); }
}
main().catch(() => {
  process.stderr.write('Sender outcome uncertain. Do not retry or reset the journal.\n', () => process.exit(1));
});
