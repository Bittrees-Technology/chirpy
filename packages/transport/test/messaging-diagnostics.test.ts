import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const wallet = '0x' + 'ab'.repeat(20); const id = 'cd'.repeat(16);
function setup() {
  const provider = { request: vi.fn(async () => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const conversation = { id, isActive: vi.fn(async () => true), consentState: vi.fn(async () => 0), countMessages: vi.fn(async () => 2n), secret: 'NEVER_INCLUDE' };
  const client = { inboxId: 'aa'.repeat(32), installationId: 'bb'.repeat(32), conversations: {
    list: vi.fn(async () => [conversation]), getConversationById: vi.fn(async () => conversation), sync: vi.fn(), syncAll: vi.fn(), createDm: vi.fn(),
  }, sendSyncRequest: vi.fn(), revokeInstallations: vi.fn() };
  Object.assign(transport, { status: 'ready', client, sdk: { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 } } });
  return { transport, provider, client, conversation };
}
it('only reads bounded local metadata and never returns contents or invokes network mutations', async () => {
  const { transport, client } = setup();
  const result = await transport.inspectMessaging(id);
  expect(client.conversations.list).toHaveBeenCalledExactlyOnceWith({ limit: 100n, consentStates: [0, 1, 2] });
  expect(result.conversation).toEqual({ id, found: true, active: true, consent: 0, messageCount: '2' });
  expect(JSON.stringify(result)).not.toContain('NEVER_INCLUDE');
  for (const fn of [client.conversations.sync, client.conversations.syncAll, client.conversations.createDm, client.sendSyncRequest, client.revokeInstallations]) expect(fn).not.toHaveBeenCalled();
});
it('rejects invalid identifiers and a changed wallet before reading', async () => {
  const { transport, client, provider } = setup();
  await expect(transport.inspectMessaging('bad')).rejects.toThrow('Invalid');
  provider.request.mockResolvedValue([]);
  await expect(transport.inspectMessaging()).rejects.toThrow('Wallet changed');
  expect(client.conversations.list).not.toHaveBeenCalled();
});
it('discards data when the client or wallet changes during a local read', async () => {
  const { transport, client, provider } = setup();
  client.conversations.list.mockImplementationOnce(async () => { provider.request.mockResolvedValue([]); return []; });
  await expect(transport.inspectMessaging()).rejects.toThrow('Wallet changed');
});
it('reports a missing local conversation without attempting recovery', async () => {
  const { transport, client } = setup(); client.conversations.getConversationById.mockResolvedValue(undefined as any);
  expect((await transport.inspectMessaging(id)).conversation).toEqual({ id, found: false });
  expect(client.sendSyncRequest).not.toHaveBeenCalled();
});
