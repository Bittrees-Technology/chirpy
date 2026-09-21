// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { decryptRecoveryArchive, encryptRecoveryArchive, MAX_RECOVERY_FILE_BYTES, validateRecoveryData } from '../src/recoveryArchive';

const wallet = '0x' + 'ab'.repeat(20);
const other = '0x' + 'cd'.repeat(20);
const password = 'a long unique recovery passphrase 🔑';
const fixture = () => ({
  version: 1, source: 'chirpy', wallet, createdAt: 1_800_000_000_000,
  contacts: [{ address: other, label: 'Colleague' }],
  notes: [{ id: 'note-1', text: 'Private note 🌳', sentAtMs: 1_799_000_000_000 }],
  preferences: { blocked: [other], readReceiptsDefault: false, readReceiptOverrides: { 'xmtp:production:thread-1': false } },
});

describe('encrypted recovery archive', () => {
  it('round trips all allowed fields, with no plaintext identity or content in the file', async () => {
    const raw = await encryptRecoveryArchive(fixture(), password);
    for (const secret of [wallet, other, 'Colleague', 'Private note', 'thread-1']) expect(raw).not.toContain(secret);
    expect(await decryptRecoveryArchive(raw, password, wallet.toUpperCase().replace('0X', '0x'))).toEqual(fixture());
  });
  it('uses fresh salt and nonce for identical exports', async () => {
    const a = JSON.parse(await encryptRecoveryArchive(fixture(), password));
    const b = JSON.parse(await encryptRecoveryArchive(fixture(), password));
    expect(a.salt).not.toEqual(b.salt); expect(a.iv).not.toEqual(b.iv); expect(a.ciphertext).not.toEqual(b.ciphertext);
  });
  it('round trips a large supported file without truncating notes', async () => {
    const data = { ...fixture(), notes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: 'x'.repeat(50_000), sentAtMs: 0 })) };
    const raw = await encryptRecoveryArchive(data, password);
    expect(await decryptRecoveryArchive(raw, password, wallet)).toEqual(data);
  });
  it('validates decrypted payloads even when a file has valid encryption', async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const material = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: 600_000, hash: 'SHA-256' }, material,
      { name: 'AES-GCM', length: 256 }, false, ['encrypt']);
    const payload = { ...fixture(), preferences: { ...fixture().preferences, syncAcrossDevices: true } };
    const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv,
      additionalData: new TextEncoder().encode('Chat recovery v1;AES-256-GCM;PBKDF2-SHA-256;600000') }, key, new TextEncoder().encode(JSON.stringify(payload)));
    const raw = JSON.stringify({ format: 'chat-recovery', version: 1, cipher: 'AES-256-GCM', kdf: 'PBKDF2-SHA-256', iterations: 600_000,
      salt: Buffer.from(salt).toString('base64'), iv: Buffer.from(iv).toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') });
    await expect(decryptRecoveryArchive(raw, password, wallet)).rejects.toThrow('Invalid or unsupported');
  });
  it('rejects wrong passphrases without silently normalizing them', async () => {
    const raw = await encryptRecoveryArchive(fixture(), password);
    await expect(decryptRecoveryArchive(raw, password + ' ', wallet)).rejects.toThrow('Could not unlock');
  });
  it('rejects another wallet even with the correct passphrase', async () => {
    const raw = await encryptRecoveryArchive(fixture(), password);
    await expect(decryptRecoveryArchive(raw, password, other)).rejects.toThrow('different wallet');
  });
  it.each(['salt', 'iv', 'ciphertext'])('authenticates %s against tampering', async field => {
    const file = JSON.parse(await encryptRecoveryArchive(fixture(), password));
    const bytes = Buffer.from(file[field], 'base64'); bytes[0] ^= 1; file[field] = bytes.toString('base64');
    await expect(decryptRecoveryArchive(JSON.stringify(file), password, wallet)).rejects.toThrow('Could not unlock');
  });
  it('rejects unsupported metadata before running expensive key derivation', async () => {
    const file = JSON.parse(await encryptRecoveryArchive(fixture(), password));
    const spy = vi.spyOn(crypto.subtle, 'deriveKey');
    try {
      for (const mutation of [{ iterations: 1 }, { iterations: 1e12 }, { version: 2 }, { cipher: 'AES-CBC' },
        { kdf: 'PBKDF2-SHA-1' }, { format: 'other' }, { extra: 'private-key' }, { iv: 'AAAA' }, { salt: '!!!!' }, { ciphertext: '' }]) {
        await expect(decryptRecoveryArchive(JSON.stringify({ ...file, ...mutation }), password, wallet)).rejects.toThrow();
      }
      expect(spy).not.toHaveBeenCalled();
    } finally { spy.mockRestore(); }
  });
  it('bounds file input before parsing', async () => {
    await expect(decryptRecoveryArchive(' '.repeat(MAX_RECOVERY_FILE_BYTES + 1), password, wallet)).rejects.toThrow();
    await expect(decryptRecoveryArchive('{', password, wallet)).rejects.toThrow();
  });
  it.each(['short', ' '.repeat(12), 'x'.repeat(1025)])('rejects unsuitable passphrases', async value => {
    await expect(encryptRecoveryArchive(fixture(), value)).rejects.toThrow('passphrase');
  });
});

describe('recovery schema boundary', () => {
  it('rejects credentials and arbitrary storage snapshots at every level', () => {
    for (const mutation of [
      { ...fixture(), privateKey: 'secret' },
      { ...fixture(), preferences: { ...fixture().preferences, syncAcrossDevices: true } },
      { ...fixture(), contacts: [{ ...fixture().contacts[0], signature: 'secret' }] },
      { ...fixture(), notes: [{ ...fixture().notes[0], walletKey: 'secret' }] },
      JSON.parse('{"__proto__":{},"constructor":{}}'),
    ]) expect(() => validateRecoveryData(mutation)).toThrow();
  });
  it('does not mutate caller data and normalizes address casing', () => {
    const data = fixture(); data.wallet = wallet.toUpperCase().replace('0X', '0x');
    const snapshot = structuredClone(data);
    expect(validateRecoveryData(data).wallet).toEqual(wallet); expect(data).toEqual(snapshot);
  });
  it('rejects duplicates instead of losing ambiguous data', () => {
    const data = fixture();
    for (const key of ['contacts', 'notes'] as const) expect(() => validateRecoveryData({ ...data, [key]: [...data[key], ...data[key]] })).toThrow();
    expect(() => validateRecoveryData({ ...data, preferences: { ...data.preferences, blocked: [other, other.toUpperCase().replace('0X', '0x')] } })).toThrow();
  });
  it('rejects global preferences without protocol and network attribution', () => {
    for (const overrides of [{ thread: true }, { 'xmtp:production:t': 'true' }, JSON.parse('{"__proto__":true}')]) {
      expect(() => validateRecoveryData({ ...fixture(), preferences: { ...fixture().preferences, readReceiptOverrides: overrides } })).toThrow();
    }
  });
  it('bounds counts, individual strings and combined UTF-8 bytes', () => {
    expect(() => validateRecoveryData({ ...fixture(), contacts: Array(1001).fill(fixture().contacts[0]) })).toThrow();
    expect(() => validateRecoveryData({ ...fixture(), notes: [{ id: 'n', text: 'x'.repeat(50_001), sentAtMs: 0 }] })).toThrow();
    expect(() => validateRecoveryData({ ...fixture(), notes: Array.from({ length: 10 }, (_, i) => ({ id: String(i), text: '🌳'.repeat(20_000), sentAtMs: 0 })) })).toThrow();
  });
  it.each([NaN, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER])('rejects invalid timestamps %s', createdAt => {
    expect(() => validateRecoveryData({ ...fixture(), createdAt })).toThrow();
  });
  it('rejects invalid wallets, sources, missing fields and wrong primitive types', () => {
    for (const mutation of [{ wallet: '0x1234' }, { source: 'attacker' }, { version: '1' }, { notes: null }, { contacts: {} }]) {
      expect(() => validateRecoveryData({ ...fixture(), ...mutation })).toThrow();
    }
    expect(() => validateRecoveryData({})).toThrow();
  });
});
