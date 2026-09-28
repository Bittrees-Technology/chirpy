import { spawn } from 'node:child_process';
import { join } from 'node:path';

export function send(runtime: string, wallet: string): Promise<{ network: string; eventId: string; text: string; receipt: { conversationId: string; messageId: string } }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(runtime, 'sender.mjs'), '--dev', wallet], {
      cwd: runtime, env: { PATH: '/usr/bin:/bin', HOME: runtime, LANG: 'C.UTF-8' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '', errors = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 160_000);
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { errors = (errors + chunk).slice(-4000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`Disposable sender failed (${code}): ${errors}`));
      const line = output.split('\n').find(value => value.startsWith('BRIDGE_RECEIPT='));
      if (!line) return reject(new Error('Missing exact bridge publication receipt'));
      try { resolve(JSON.parse(line.slice('BRIDGE_RECEIPT='.length))); } catch (error) { reject(error); }
    });
  });
}
