const nativeOrigins = new Set(['tauri://localhost', 'http://tauri.localhost', 'https://tauri.localhost']);
function validOrigin(value) {
  if (nativeOrigins.has(value)) return true;
  try { const url = new URL(value); return url.protocol === 'https:' && url.origin === value; }
  catch { return false; }
}

// CORS only grants browser access. Every mutation still requires its scoped signature.
export function syncCors(req, res, { service, allowedOrigins = '' }) {
  res.setHeader('Vary', 'Origin');
  const origin = req.headers?.origin;
  const extra = allowedOrigins.split(',').map(value => value.trim()).filter(Boolean);
  if (extra.some(value => !validOrigin(value))) return { status: 503, body: { error: 'Sync origin configuration is invalid.' } };
  const allowed = new Set(extra);
  try { allowed.add(new URL(service).origin); } catch { /* Handler reports missing service identity. */ }
  if (origin !== undefined && (typeof origin !== 'string' || origin === 'null' || !allowed.has(origin))) {
    return { status: 403, body: { error: 'Origin is not allowed.' } };
  }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method === 'OPTIONS') {
    const method = req.headers?.['access-control-request-method'];
    const headers = String(req.headers?.['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
    if (!origin || !['GET', 'POST'].includes(method) || headers.some(header => header !== 'content-type')) {
      return { status: 400, body: { error: 'Invalid sync preflight.' } };
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST');
    res.setHeader('Access-Control-Allow-Headers', 'content-type');
    return { status: 204, body: undefined };
  }
  return null;
}
