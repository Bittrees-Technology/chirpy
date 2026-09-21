import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const wallet = '0x' + 'ab'.repeat(20);
function setup() {
  const provider = { request: vi.fn(async () => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const client = { sendSyncRequest: vi.fn(async () => {}), revokeInstallations: vi.fn() };
  Object.assign(transport, { status: 'ready', client });
  return { transport, provider, client };
}
it('only explicitly requests history and consent from the bound SDK client', async () => {
  const { transport, client, provider } = setup();
  expect(client.sendSyncRequest).not.toHaveBeenCalled();
  await transport.requestHistorySync();
  expect(provider.request).toHaveBeenCalledWith({ method: 'eth_accounts' });
  expect(client.sendSyncRequest).toHaveBeenCalledExactlyOnceWith();
  expect(client.revokeInstallations).not.toHaveBeenCalled();
  expect(transport.status).toBe('ready');
});
it.each([[], ['0x' + 'cd'.repeat(20)], [null], 'invalid'])('denies disconnected/wrong accounts: %j', async accounts => {
  const { transport, client, provider } = setup();
  provider.request.mockResolvedValue(accounts as any);
  await expect(transport.requestHistorySync()).rejects.toThrow('Wallet changed');
  expect(client.sendSyncRequest).not.toHaveBeenCalled();
});
it('denies a client replacement while checking the wallet', async () => {
  const { transport, client, provider } = setup();
  provider.request.mockImplementation(async () => { Object.assign(transport, { client: {} }); return [wallet]; });
  await expect(transport.requestHistorySync()).rejects.toThrow('Wallet changed');
  expect(client.sendSyncRequest).not.toHaveBeenCalled();
});
it('denies before messaging is enabled', async () => {
  const { transport, client } = setup(); Object.assign(transport, { status: 'idle' });
  await expect(transport.requestHistorySync()).rejects.toThrow('not enabled');
  expect(client.sendSyncRequest).not.toHaveBeenCalled();
});
it('coalesces concurrent requests and allows an explicit retry after failure', async () => {
  const { transport, client } = setup();
  let reject!: (error: Error) => void;
  client.sendSyncRequest.mockImplementationOnce(() => new Promise((_, fail) => { reject = fail; }));
  const first = transport.requestHistorySync(); const second = transport.requestHistorySync();
  await Promise.resolve();
  const rejected = Promise.allSettled([first, second]); reject(new Error('offline'));
  expect((await rejected).map(result => result.status)).toEqual(['rejected', 'rejected']);
  expect(client.sendSyncRequest).toHaveBeenCalledTimes(1);
  expect(transport.status).toBe('ready');
  await transport.requestHistorySync(); expect(client.sendSyncRequest).toHaveBeenCalledTimes(2);
});
