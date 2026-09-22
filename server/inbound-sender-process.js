// Self-hosted POSIX worker boundary. The SDK runs only in the trusted child.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { guardedInboundSend } from './inbound-send-journal.js';
import { validInboundMail, inboundMailScope, inboundMailText } from './inbound-mail-contract.js';

const hash = value => createHash('sha256').update(value).digest('hex');
function validConfig(config) {
  return config && Object.keys(config).length === 3 && ['node', 'script', 'config'].every(key =>
    Object.hasOwn(config, key) && typeof config[key] === 'string' && config[key].length <= 4096 &&
    isAbsolute(config[key]) && !/[\x00-\x1f\x7f]/.test(config[key]));
}

function run(config, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    // A separate process group also contains subprocesses used to recheck Mail.
    // No NODE_OPTIONS, signing keys, provider credentials or shell are inherited.
    const child = spawn(config.node, [config.script, '--config', config.config, '--parent-pid', String(process.pid)], {
      detached: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: { HOME: process.env.HOME || '', PATH: '/usr/bin:/bin', LANG: 'C.UTF-8' },
    });
    let failed = false, bytes = 0, errors = 0;
    const output = [];
    const stop = () => {
      failed = true;
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
      }
    };
    const timer = setTimeout(stop, timeoutMs);
    child.stdout.on('data', chunk => { bytes += chunk.length; if (bytes > 4096) stop(); else output.push(chunk); });
    child.stderr.on('data', chunk => { errors += chunk.length; if (errors > 4096) stop(); });
    child.stdin.on('error', stop);
    child.on('error', stop);
    // Do not resolve on stdout, exit, or a Promise timeout: close follows process
    // termination and closed pipes. An ambiguous outcome leaves the journal armed.
    child.on('close', code => {
      clearTimeout(timer);
      if (failed || code !== 0) { reject(Error('Sender outcome uncertain')); return; }
      try {
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(output)));
        if (!result || Object.keys(result).length !== 2 || !result.scope ||
          Object.keys(result.scope).length !== 4 ||
          !Object.keys(input.scope).every(key => Object.hasOwn(result.scope, key) && result.scope[key] === input.scope[key])) {
          throw Error('Invalid sender result');
        }
        resolve(result.receipt);
      } catch { reject(Error('Sender outcome uncertain')); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}

// The executable is trusted deployment code, never a path supplied by an email.
// It must recheck live source + pinned Wallet authority, verify the exact SDK
// Published message, emit {scope,receipt}, and terminate. This boundary does not
// manufacture that evidence or supply a placeholder successful sender.
export async function sendInboundInProcess(journal, config, event, recipient, { timeoutMs = 60000 } = {}) {
  if (process.platform === 'win32' || process.pid <= 1 || !validConfig(config) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60000) {
    throw Error('Isolated sender is not configured');
  }
  if (!validInboundMail(event) || !recipient || Object.keys(recipient).length !== 2 ||
    !/^0x[a-f0-9]{40}$/.test(recipient.wallet || '') || !Number.isSafeInteger(recipient.expiresAt) ||
    recipient.expiresAt <= Date.now() || recipient.expiresAt > Date.now() + 23 * 3600000) {
    throw Error('Invalid inbound send authorization');
  }
  const text = inboundMailText(event);
  const scope = { eventId: event.id, contentHash: inboundMailScope(event).contentHash,
    recipientHash: hash(recipient.wallet), textHash: hash(text) };
  const input = { scope, event, recipient, text };
  if (Buffer.byteLength(JSON.stringify(input)) > 131072) throw Error('Inbound send too large');
  // Snapshot before journal access so a caller cannot mutate scope/body during
  // the asynchronous child lifetime. Retry of an armed event never launches it.
  const snapshot = JSON.parse(JSON.stringify(input));
  return guardedInboundSend(journal, scope, () => run(config, snapshot, timeoutMs));
}
