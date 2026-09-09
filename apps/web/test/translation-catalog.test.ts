import { expect, it } from 'vitest';
import en from '../src/i18n/langs/en.json';
import es from '../src/i18n/langs/es.json';
import { translateStatus } from '../src/i18n/statusMessages';
it('provides matching nonempty Spanish entries and interpolation fields', () => {
  expect(Object.keys(es).sort()).toEqual(Object.keys(en).sort());
  const fields = (value: string) => [...value.matchAll(/\{([a-zA-Z][a-zA-Z0-9]*)\}/g)].map(match => match[1]).sort();
  for (const [key, english] of Object.entries(en)) {
    expect(es[key]?.trim(), key).toBeTruthy();
    expect(fields(es[key]), key).toEqual(fields(english));
  }
});
it('localizes known sync results and preserves unknown provider diagnostics', () => {
  const t = (key: string, fallback?: string) => es[key] ?? fallback ?? key;
  expect(translateStatus(t, 'Encrypted sync is enabled for this browser session, for up to 24 hours.')).toContain('La sincronización cifrada');
  expect(translateStatus(t, 'Invalid JSON')).toBe('JSON no válido');
  expect(translateStatus(t, 'Invalid org config: chain.chainId is invalid')).toBe('Configuración de organización no válida: chain.chainId no es válido');
  expect(translateStatus(t, 'Provider error 123')).toBe('Provider error 123');
  expect(translateStatus(t, 'constructor')).toBe('constructor');
});
