/** Fixed, purpose-separated file formats. Parameters come from application code, never a file. */
export function recoveryCipher(FORMAT: string, aad: string, limits: {bytes: number; fileBytes: number}) {
  const ITERATIONS = 600_000;
  const AAD = new TextEncoder().encode(aad);
  const encoder = new TextEncoder();
  function invalid(): never { throw new Error('Invalid or unsupported recovery file'); }
  function object(value: unknown, keys: string[]): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) invalid();
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length !== keys.length || keys.some(key => !Object.hasOwn(record, key))) invalid();
    return record;
  }
  function encode(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  }
  function decode(value: unknown, length?: number): Uint8Array<ArrayBuffer> {
    if (typeof value !== 'string' || value.length > limits.fileBytes
      || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) invalid();
    const bytes = Uint8Array.from(atob(value), char => char.charCodeAt(0));
    if ((length !== undefined && bytes.length !== length) || encode(bytes) !== value) invalid();
    return bytes;
  }
  function passwordBytes(password: string): Uint8Array<ArrayBuffer> {
    if (typeof password !== 'string' || password.length < 12 || password.length > 1024 || !password.trim()) {
      throw new Error('Use a recovery passphrase of 12 to 1024 characters');
    }
    // Do not trim or normalize: every entered character contributes to the key.
    return encoder.encode(password);
  }
  async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<CryptoKey> {
    const bytes = passwordBytes(password);
    try {
      const material = await crypto.subtle.importKey('raw', bytes, 'PBKDF2', false, ['deriveKey']);
      return await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' },
        material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    } finally { bytes.fill(0); }
  }

  /** No storage writes, network calls or ownership claims. UI must verify ownership separately. */
  async function encrypt(data: unknown, password: string): Promise<string> {
    passwordBytes(password).fill(0);
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt);
    const plaintext = encoder.encode(JSON.stringify(data));
    if (plaintext.length > limits.bytes) { plaintext.fill(0); invalid(); }
    try {
      const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, plaintext);
      return JSON.stringify({ format: FORMAT, version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256',
        iterations: ITERATIONS, salt: encode(salt), iv: encode(iv), ciphertext: encode(new Uint8Array(ciphertext)) });
    } finally { plaintext.fill(0); }
  }

  /** Authenticates bytes; callers must strictly validate the decrypted payload. */
  async function decrypt(raw: string, password: string): Promise<unknown> {
    if (typeof raw !== 'string' || raw.length > limits.fileBytes
      || encoder.encode(raw).length > limits.fileBytes) invalid();
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { invalid(); }
    const file = object(parsed, ['format', 'version', 'cipher', 'kdf', 'iterations', 'salt', 'iv', 'ciphertext']);
    if (file.format !== FORMAT || file.version !== 1 || file.cipher !== 'AES-256-GCM'
      || file.kdf !== 'PBKDF2-SHA-256' || file.iterations !== ITERATIONS) invalid();
    const salt = decode(file.salt, 16);
    const iv = decode(file.iv, 12);
    const ciphertext = decode(file.ciphertext);
    if (ciphertext.length < 17 || ciphertext.length > limits.bytes + 16) invalid();
    const key = await deriveKey(password, salt);
    let plaintext: ArrayBuffer;
    try {
      plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: AAD, tagLength: 128 }, key, ciphertext);
    } catch { throw new Error('Could not unlock recovery file: incorrect passphrase or damaged file'); }
    let data: unknown;
    try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)); }
    catch { invalid(); }
    finally { new Uint8Array(plaintext).fill(0); }
    return data;
  }

  return {encrypt, decrypt};
}
