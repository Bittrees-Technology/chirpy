import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('holds private monitoring without fresh, matching aggregate receipts and bounds its read-only subprocesses', () => {
  const result = execFileSync('python3', ['-I', fileURLToPath(new URL('../../scripts/test-mail-private-observer.py', import.meta.url))], {
    encoding: 'utf8', timeout: 15_000, maxBuffer: 32_768,
  });
  expect(result).toBe('');
});
