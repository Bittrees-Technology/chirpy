import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('preview selects the canonical native policy and the browser enforces it', async ({ page }) => {
  const policy = JSON.parse(readFileSync('apps/web/src-tauri/tauri.conf.json', 'utf8')).app.security.csp;
  const response = await page.goto('/');
  const header = await response!.headerValue('content-security-policy');
  if (process.env.CHIRPY_TEST_NATIVE_CSP !== '1') {
    expect(header).not.toBe(policy);
    return;
  }
  expect(header).toBe(policy);
  const violation = await page.evaluate(() => new Promise<{ directive: string; disposition: string } | null>(resolve => {
    const script = document.createElement('script');
    let timer: ReturnType<typeof setTimeout>;
    const stop = (value: { directive: string; disposition: string } | null) => {
      clearTimeout(timer); document.removeEventListener('securitypolicyviolation', listener); script.remove(); resolve(value);
    };
    const listener = (event: SecurityPolicyViolationEvent) => {
      if (event.blockedURI.startsWith('https://example.invalid')) stop({ directive: event.effectiveDirective, disposition: event.disposition });
    };
    document.addEventListener('securitypolicyviolation', listener);
    timer = setTimeout(() => stop(null), 3000);
    script.src = 'https://example.invalid/native-policy-check.js';
    document.head.append(script);
  }));
  expect(violation?.disposition).toBe('enforce');
  expect(['script-src', 'script-src-elem']).toContain(violation?.directive);
});
