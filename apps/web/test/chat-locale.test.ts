import { afterEach, expect, it, vi } from 'vitest';
import { fmtTime } from '../src/ui';
import { translateStatus } from '../src/i18n/statusMessages';
import es from '../src/i18n/langs/es.json';
afterEach(() => vi.useRealTimers());
it('formats chat timestamps using the selected language rather than the process locale', () => {
  vi.useFakeTimers();
  const now = new Date(2026, 8, 9, 17, 45, 0);
  vi.setSystemTime(now);
  expect(fmtTime(now.getTime(), 'es')).toBe('17:45');
  expect(fmtTime(now.getTime(), 'en')).toMatch(/05:45\s?PM/);
  expect(fmtTime(new Date(2026, 0, 3, 17).getTime(), 'es')).toBe('3 ene');
  expect(fmtTime(NaN, 'es')).toBe('');
});
it('translates known access and privacy denials while retaining unknown diagnostics', () => {
  const t = (key: string, fallback?: string) => es[key] ?? fallback ?? key;
  expect(translateStatus(t, 'Admins only.')).toBe('Solo administradores.');
  expect(translateStatus(t, 'This wallet does not satisfy the room gate.')).toContain('no cumple las reglas');
  expect(translateStatus(t, 'Accept or unblock this conversation before sending messages or reactions.')).toContain('Acepta o desbloquea');
  expect(translateStatus(t, 'Provider-specific diagnostic')).toBe('Provider-specific diagnostic');
});
