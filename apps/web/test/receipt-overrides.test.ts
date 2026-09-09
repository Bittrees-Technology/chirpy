import { afterEach, expect, it, vi } from 'vitest';
import { normalizeReceiptOverrides, receiptOverride, receiptPreferenceKey } from '../src/receiptPreferences';
afterEach(() => vi.unstubAllEnvs());
it('separates transport and network receipt consent', () => {
  vi.stubEnv('VITE_TRANSPORT', 'xmtp'); vi.stubEnv('VITE_XMTP_ENV', 'production');
  const overrides = { [receiptPreferenceKey('dm')]: true };
  expect(receiptOverride(overrides, 'dm')).toBe(true);
  vi.stubEnv('VITE_XMTP_ENV', 'dev');
  expect(receiptOverride(overrides, 'dm')).toBeUndefined();
  vi.stubEnv('VITE_TRANSPORT', 'mock'); vi.stubEnv('VITE_XMTP_ENV', 'production');
  expect(receiptOverride(overrides, 'dm')).toBeUndefined();
});
it('accepts only explicit own boolean settings and scoped conversation IDs', () => {
  const valid = 'xmtp:production:dm';
  expect(normalizeReceiptOverrides({ [valid]: false, 'xmtp:production:other': 'true', bad: true })).toEqual({ [valid]: false });
  expect(normalizeReceiptOverrides(Object.create({ [valid]: true }))).toEqual({});
  expect(normalizeReceiptOverrides([true])).toEqual({});
  expect(normalizeReceiptOverrides(null)).toEqual({});
  expect(normalizeReceiptOverrides(JSON.parse('{"__proto__":true}'))).toEqual({});
});
