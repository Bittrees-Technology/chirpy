import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
import { fetchRecoveryWelcome } from '../src/welcomeRecovery';
vi.mock('../src/welcomeRecovery', async importOriginal => ({
  ...await importOriginal<typeof import('../src/welcomeRecovery')>(), fetchRecoveryWelcome: vi.fn(),
}));
const wallet = '0x' + 'ab'.repeat(20), id = 'cd'.repeat(16);
function setup() {
  vi.mocked(fetchRecoveryWelcome).mockReset().mockResolvedValue(new Uint8Array([1, 2, 3]));
  const provider = { request: vi.fn(async () => [wallet]) };
  const transport = new XmtpTransport(PERSONAL_ORG, { address: wallet }, provider);
  const conversation = { id, sync: vi.fn(async () => {}), updateConsentState: vi.fn(), send: vi.fn() };
  const client = { inboxId: 'ee'.repeat(32), installationId: 'aa'.repeat(32), conversations: {
    list: vi.fn(async () => []), getConversationById: vi.fn().mockResolvedValueOnce(undefined).mockResolvedValue(conversation),
    recoverMissingWelcome: vi.fn(async () => {}), createDm: vi.fn(),
  }, sendSyncRequest: vi.fn(), revokeInstallations: vi.fn() };
  const changed = vi.fn();
  Object.assign(transport, { status: 'ready', client, changeCallback: changed, sdk: { ConsentState: { Unknown: 0, Allowed: 1, Denied: 2 } } });
  const refresh = vi.spyOn(transport, 'listConversations').mockResolvedValue([]);
  return { transport, provider, conversation, client, changed, refresh };
}
it('recovers only the selection, syncs membership before refresh, and never grants consent or resends', async () => {
  const { transport, client, conversation, refresh, changed } = setup();
  await transport.recoverMissingConversation(id, '42');
  expect(fetchRecoveryWelcome).toHaveBeenCalledExactlyOnceWith('production', client.installationId, 42n);
  expect(client.conversations.recoverMissingWelcome).toHaveBeenCalledExactlyOnceWith(new Uint8Array([1, 2, 3]), id);
  expect(conversation.sync).toHaveBeenCalledTimes(1);
  expect(conversation.sync.mock.invocationCallOrder[0]).toBeLessThan(refresh.mock.invocationCallOrder[0]);
  expect(changed).toHaveBeenCalledOnce();
  for (const fn of [conversation.updateConsentState, conversation.send, client.conversations.createDm, client.sendSyncRequest, client.revokeInstallations]) expect(fn).not.toHaveBeenCalled();
});
it('refuses existing conversations without looking up or importing an invitation', async () => {
  const { transport, client, conversation } = setup();
  client.conversations.getConversationById.mockReset().mockResolvedValue(conversation);
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('already stored');
  expect(fetchRecoveryWelcome).not.toHaveBeenCalled(); expect(client.conversations.recoverMissingWelcome).not.toHaveBeenCalled();
});
it('stops before import if the wallet changes while fetching', async () => {
  const { transport, provider, client } = setup();
  vi.mocked(fetchRecoveryWelcome).mockImplementationOnce(async () => { provider.request.mockResolvedValue([]); return new Uint8Array([1]); });
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('Wallet changed');
  expect(client.conversations.recoverMissingWelcome).not.toHaveBeenCalled();
});
it('does not display success if post-import sync is uncertain and never retries import', async () => {
  const { transport, conversation, client, changed, refresh } = setup();
  conversation.sync.mockRejectedValueOnce(new Error('offline'));
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('offline');
  expect(client.conversations.recoverMissingWelcome).toHaveBeenCalledTimes(1);
  expect(changed).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('already stored');
  expect(client.conversations.recoverMissingWelcome).toHaveBeenCalledTimes(1);
});
it('rejects overlapping requests and a replaced installation', async () => {
  const { transport, client } = setup(); let finish!: (bytes: Uint8Array) => void;
  vi.mocked(fetchRecoveryWelcome).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const first = transport.recoverMissingConversation(id, '42');
  await vi.waitFor(() => expect(fetchRecoveryWelcome).toHaveBeenCalled());
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('already in progress');
  client.installationId = 'bb'.repeat(32); finish(new Uint8Array([1]));
  await expect(first).rejects.toThrow('Wallet changed');
  expect(client.conversations.recoverMissingWelcome).not.toHaveBeenCalled();
});

it('reports only the safe import stage/code and isolates evidence by conversation and installation', async () => {
  const { transport, client } = setup();
  client.conversations.getConversationById.mockReset().mockResolvedValue(undefined);
  client.conversations.recoverMissingWelcome.mockRejectedValueOnce(new Error('[NotFound::PostQuantumPrivateKey] PRIVATE_SECRET'));
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('PRIVATE_SECRET');
  const first = await transport.inspectMessaging(id);
  expect(first.lastRecovery).toEqual({ stage: 'invitation-import', outcome: 'failed', errorCode: 'NotFound::PostQuantumPrivateKey' });
  expect(JSON.stringify(first)).not.toContain('PRIVATE_SECRET');
  first.lastRecovery!.stage = 'tampered';
  expect((await transport.inspectMessaging(id)).lastRecovery?.stage).toBe('invitation-import');
  expect((await transport.inspectMessaging('ef'.repeat(16))).lastRecovery).toBeUndefined();
  client.installationId = 'ff'.repeat(32);
  expect((await transport.inspectMessaging(id)).lastRecovery).toBeUndefined();
  client.installationId = 'aa'.repeat(32);
  Object.assign(transport, { client: { ...client } });
  expect((await transport.inspectMessaging(id)).lastRecovery).toBeUndefined();
  expect(client.conversations.recoverMissingWelcome).toHaveBeenCalledTimes(1);
  expect(fetchRecoveryWelcome).toHaveBeenCalledTimes(1);
});
it.each(['invitation-lookup', 'membership-sync', 'conversation-refresh'])('records %s failure without error details or retries', async stage => {
  const { transport, client, conversation, refresh } = setup();
  const secret = new Error('[Untrusted::PRIVATE_SECRET] PRIVATE_SECRET');
  if (stage === 'invitation-lookup') vi.mocked(fetchRecoveryWelcome).mockRejectedValueOnce(secret);
  if (stage === 'membership-sync') conversation.sync.mockRejectedValueOnce(secret);
  if (stage === 'conversation-refresh') refresh.mockRejectedValueOnce(secret);
  await expect(transport.recoverMissingConversation(id, '42')).rejects.toThrow('PRIVATE_SECRET');
  client.conversations.getConversationById.mockReset().mockResolvedValue(undefined);
  const result = await transport.inspectMessaging(id);
  expect(result.lastRecovery).toEqual({ stage, outcome: 'failed', errorCode: 'unclassified' });
  expect(JSON.stringify(result)).not.toContain('PRIVATE_SECRET');
  expect(fetchRecoveryWelcome).toHaveBeenCalledTimes(1);
});
it('records successful completion without additional recovery operations', async () => {
  const { transport, client } = setup();
  await transport.recoverMissingConversation(id, '42');
  client.conversations.getConversationById.mockReset().mockResolvedValue(undefined);
  expect((await transport.inspectMessaging(id)).lastRecovery).toEqual({ stage: 'complete', outcome: 'succeeded' });
  expect(client.conversations.recoverMissingWelcome).toHaveBeenCalledTimes(1);
});
