// Server-only deployment access. This never substitutes for Wallet authorization.
const token = value => typeof value === 'string' && /^[\x21-\x7e]{32,512}$/.test(value);

export function walletAccessConfig(endpoint, credential, origin, secret) {
  if ((origin === undefined || origin === '') && (secret === undefined || secret === '')) return null;
  if (typeof origin !== 'string' || !origin || !token(secret) || secret === credential) {
    throw Error('Invalid Wallet deployment access configuration');
  }
  const pin = new URL(origin), target = new URL(endpoint);
  if (pin.protocol !== 'https:' || pin.username || pin.password || pin.search || pin.hash ||
    pin.port || pin.pathname !== '/' || (origin !== pin.origin && origin !== pin.origin + '/') ||
    pin.origin !== target.origin) {
    throw Error('Invalid Wallet deployment access origin');
  }
  return {origin: pin.origin, secret};
}

export function walletServiceHeaders(identity, path) {
  const endpoint = new URL(identity.url);
  if (!['/api/service/delivery', '/api/service/inbound'].includes(path) ||
    endpoint.protocol !== 'https:' || endpoint.username || endpoint.password ||
    endpoint.search || endpoint.hash || endpoint.pathname !== path || !token(identity.credential)) {
    throw Error('Invalid Wallet service configuration');
  }
  const headers = {Authorization: `Bearer ${identity.credential}`, 'Content-Type': 'application/json'};
  if (identity.access !== undefined) {
    const access = identity.access;
    if (!access || typeof access !== 'object' || Array.isArray(access) ||
      Object.keys(access).length !== 2 || !Object.hasOwn(access, 'origin') || !Object.hasOwn(access, 'secret')) {
      throw Error('Invalid Wallet deployment access configuration');
    }
    const validated = walletAccessConfig(endpoint.href, identity.credential, access.origin, access.secret);
    if (!validated) throw Error('Incomplete Wallet deployment access configuration');
    headers['x-vercel-protection-bypass'] = validated.secret;
  }
  return headers;
}
