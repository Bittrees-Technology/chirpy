export const NATIVE_ORIGINS = Object.freeze(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
export function configuredNativeOrigins(value = '') {
  const origins = String(value).split(',').map(origin => origin.trim()).filter(Boolean);
  if (origins.some(origin => !NATIVE_ORIGINS.includes(origin))) throw new Error('Only standard Tauri origins may be added to the native gate allowlist.');
  return new Set(origins);
}
