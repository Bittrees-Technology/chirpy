import { expect, it, vi } from 'vitest';
import { PERSONAL_ORG } from '@app/core';
import { XmtpTransport } from '../src/xmtp';
const self = '0x'+'1'.repeat(40), peer = '0x'+'2'.repeat(40), selected = '0x'+'3'.repeat(40);
const me = 'a'.repeat(64), them = 'b'.repeat(64);
const identifier = (identifier: string) => ({identifier, identifierKind: 0});
function setup() {
  const read = vi.fn(async (network, wallets) => wallets.map(wallet => ({version: 1, wallet, network, revision: wallet === peer ? 1 : 0, updatedAt: wallet === peer ? 1 : 0, inboxId: wallet === peer ? them : null, displayWallet: wallet === peer ? selected : null})));
  const t = new XmtpTransport(PERSONAL_ORG, {address: self}, null, read) as any; t.status = 'ready';
  const states = vi.fn(async ids => ids.map(inboxId => ({inboxId, accountIdentifiers: (inboxId === me ? [self] : [peer, selected]).map(identifier), recoveryIdentifier: identifier(inboxId === me ? self : peer)})));
  t.sdk = {IdentifierKind: {Ethereum: 0}, ConversationType: {Group: 'group'}, ContentType: {Text: 'text', Reply: 'reply'}, SortDirection: {Descending: 'desc'}, ConsentState: {Allowed: 1}, ReactionAction: {Added:'added',Removed:'removed'}, ReactionSchema: {Unicode:'unicode'}, isText: message => typeof message.content === 'string', isTextReply: () => false, isReply: () => false};
  const raw = [{id:'m1',conversationId:'dm',senderInboxId:them,sentAtNs:1n,content:'peer message',reactions:[]},{id:'m2',conversationId:'dm',senderInboxId:me,sentAtNs:2n,content:'self message',reactions:[]}];
  const dm = {id:'dm',peerInboxId:async()=>them,messages:async()=>raw,sync:vi.fn(),sendReaction:vi.fn(),consentState:async()=>1,isActive:async()=>true,isPendingRemoval:async()=>false};
  const client = {inboxId: me,preferences:{fetchInboxStates:states},conversations:{getMessageById:async()=>raw[0]}};
  t.client = client; t.conversations.set('dm',dm); t.peerByConversation.set('dm','old permanent value');
  return {t,read,states,dm,client};
}
it('uses the linked display identity without persisting it into legacy peer caches or changing reaction authority', async () => {
  const {t,dm} = setup(); expect(await t.resolvePeer(dm)).toBe(selected); expect(t.peerByConversation.get('dm')).toBe('old permanent value');
  const page = await t.listMessagePage('dm'); expect(page.messages.map(message=>message.sender)).toEqual([selected,self]); expect(t.senderInboxByMessage.get('m1')).toBe(them);
  await t.react('dm','m1','👍'); expect(dm.sendReaction).toHaveBeenCalledWith({reference:'m1',referenceInboxId:them,action:'added',content:'👍',schema:'unicode'});
});
it('refresh drops chosen peer labels immediately and revalidates current SDK membership', async () => {
  const {t,dm,states} = setup(); expect(await t.resolvePeer(dm)).toBe(selected); t.refreshDisplayWallets(); expect(t.addressForInbox('dm',them)).toBe(them);
  states.mockResolvedValue([{inboxId:them,accountIdentifiers:[identifier(peer)],recoveryIdentifier:identifier(peer)}]); expect(await t.resolvePeer(dm)).toBe(peer);
});
it('does not apply an in-flight identity lookup after an explicit display refresh', async () => {
  const {t,read,dm} = setup(); let finish!: (value: any) => void; read.mockImplementation(()=>new Promise(resolve=>{finish=resolve;}));
  const pending = t.resolvePeer(dm); await vi.waitFor(()=>expect(finish).toBeTypeOf('function')); t.refreshDisplayWallets(); finish([]);
  expect(await pending).toBeUndefined(); expect(t.displayPeerByConversation.size).toBe(0);
});
it('offers only current SDK-linked wallets and rejects wallet/client changes during editor context loading', async () => {
  const {t,states,client} = setup(); expect(await t.getDisplayWalletContext()).toMatchObject({wallet:self,inboxId:me,wallets:[self],automaticWallet:self});
  states.mockResolvedValue([{inboxId:me,accountIdentifiers:[identifier(peer)]}]); await expect(t.getDisplayWalletContext()).rejects.toThrow('could not be verified');
  let finish!: (value: any) => void; states.mockImplementation(()=>new Promise(resolve=>{finish=resolve;})); const pending = t.getDisplayWalletContext();
  await vi.waitFor(()=>expect(finish).toBeTypeOf('function')); t.client = {...client}; finish([{inboxId:me,accountIdentifiers:[identifier(self)]}]); await expect(pending).rejects.toThrow('Wallet changed');
});
