import { describe, expect, it, vi } from 'vitest';
import { fetchRecoveryWelcome, validateRecoverySelection } from '../src/welcomeRecovery';

const installation = 'ab'.repeat(32);
const concat = (...arrays: Uint8Array[]) => new Uint8Array(arrays.flatMap(array => Array.from(array)));
const frame = (bytes: Uint8Array, flag = 0) => {
  const result = new Uint8Array(bytes.length + 5);
  result[0] = flag; new DataView(result.buffer).setUint32(1, bytes.length); result.set(bytes, 5); return result;
};
const trailer = (status = '0') => frame(new TextEncoder().encode(`grpc-status: ${status}\r\n`), 128);
function envelope(id = 42, key = 0xab) {
  // Independent fixture: outer V1; id=42, recipient=32 bytes, synthetic ciphertext.
  const v1 = new Uint8Array([8, id, 26, 32, ...Array(32).fill(key), 34, 1, 7]);
  return new Uint8Array([10, v1.length, ...v1]);
}
function response(message = envelope(), suffix = trailer()) {
  return concat(frame(new Uint8Array([10, message.length, ...message])), suffix);
}
const fetchBytes = (body: Uint8Array, headers: Record<string, string> = {}) => vi.fn(async () =>
  new Response(body, { headers: { 'content-type': 'application/grpc-web+proto', ...headers } })) as unknown as typeof fetch;

describe('explicit invitation lookup', () => {
  it('queries one exact predecessor on the chosen network and returns only the selected envelope', async () => {
    const fetcher = fetchBytes(response());
    expect(await fetchRecoveryWelcome('dev', installation, 42n, fetcher)).toEqual(envelope());
    const [url, init] = vi.mocked(fetcher).mock.calls[0];
    expect(url).toBe('https://api.dev.xmtp.network:5558/xmtp.mls.api.v1.MlsApi/QueryWelcomeMessages');
    expect(init).toMatchObject({ credentials: 'omit', redirect: 'error', cache: 'no-store', method: 'POST' });
    const body = Array.from(init!.body as Uint8Array);
    expect(body.slice(0, 7)).toEqual([0, 0, 0, 0, 42, 10, 32]);
    expect(body.slice(7, 39)).toEqual(Array(32).fill(0xab));
    expect(body.slice(39)).toEqual([18, 6, 8, 1, 16, 1, 24, 41]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['different invitation', response(envelope(43))],
    ['different installation', response(envelope(42, 0xcd))],
    ['provider error', response(envelope(), trailer('7'))],
    ['missing status', response(envelope(), new Uint8Array())],
    ['truncated frame', new Uint8Array([0, 0, 0, 0, 99, 10])],
    ['compressed frame', concat(frame(new Uint8Array([10, 0]), 1), trailer())],
    ['duplicate data frame', concat(response(), response())],
    ['duplicate selected envelope', concat(frame(concat(new Uint8Array([10, envelope().length]), envelope(), new Uint8Array([10, envelope().length]), envelope())), trailer())],
    ['wrong version', response(new Uint8Array([18, 0]))],
    ['invalid tag', response(new Uint8Array([0, 0]))],
    ['oversized response', new Uint8Array(1_048_576 + 65_537)],
  ])('rejects %s without returning recovery input', async (_, body) => {
    await expect(fetchRecoveryWelcome('production', installation, 42n, fetchBytes(body))).rejects.toThrow();
  });

  it('rejects conflicting header and trailer status', async () => {
    await expect(fetchRecoveryWelcome('dev', installation, 42n, fetchBytes(response(), { 'grpc-status': '7' }))).rejects.toThrow();
  });
  it('does not accept an HTML success response', async () => {
    await expect(fetchRecoveryWelcome('dev', installation, 42n, fetchBytes(response(), { 'content-type': 'text/html' }))).rejects.toThrow();
  });
  it.each(['0', '-1', '01', '1.1', '9223372036854775808', '1e3'])('rejects invalid invitation selection %s', value => {
    expect(() => validateRecoverySelection('ac'.repeat(16), value)).toThrow();
  });
  it('validates group and installation scope before any request', async () => {
    expect(validateRecoverySelection('ac'.repeat(16), '42')).toBe(42n);
    expect(() => validateRecoverySelection('abc', '42')).toThrow();
    const fetcher = fetchBytes(response());
    await expect(fetchRecoveryWelcome('dev', '00', 42n, fetcher)).rejects.toThrow();
    await expect(fetchRecoveryWelcome('dev', installation, 0n, fetcher)).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
