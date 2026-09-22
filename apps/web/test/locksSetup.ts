import { beforeEach } from 'vitest';
beforeEach(() => {
  if (typeof navigator === 'undefined') return;
  const pending = new Map<string, Promise<unknown>>();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: {
    request: (name: string, _options: unknown, callback: () => unknown) => {
      const next = (pending.get(name) ?? Promise.resolve()).catch(() => {}).then(callback);
      pending.set(name, next); return next;
    },
  } });
});
