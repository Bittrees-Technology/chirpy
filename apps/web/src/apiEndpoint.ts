export function resolveSyncEndpoint(apiOrigin: string | undefined, href: string, native = false) {
  const page = new URL(href);
  const packaged = native || !['http:', 'https:'].includes(page.protocol) || page.hostname === 'tauri.localhost';
  if (apiOrigin) {
    const origin = new URL(apiOrigin);
    if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== apiOrigin) {
      throw new Error('Sync requires an HTTPS API origin without a path or credentials.');
    }
    const service = `${origin.origin}/api/usersync`;
    return { requestUrl: service, service };
  }
  if (packaged) throw new Error('This native build has no sync API origin configured.');
  return { requestUrl: '/api/usersync', service: new URL('/api/usersync', href).href };
}

export function syncEndpoint() {
  return resolveSyncEndpoint(import.meta.env.VITE_API_ORIGIN, window.location.href, '__TAURI_INTERNALS__' in window);
}
