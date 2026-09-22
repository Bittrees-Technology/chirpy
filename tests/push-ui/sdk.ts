// External SDK boundary only. Chat's real controller, adapter, session guards,
// wallet-provider integration and views run unchanged in this test build.
const state = () => (window as any).__pushFixture;
const clone = (value: unknown) => JSON.parse(JSON.stringify(value));
async function wait(kind: string) {
  if (!state().hold[kind]) return;
  await new Promise<void>(resolve => { (state().pending[kind] ??= []).push(resolve); });
}
export const CONSTANTS = { ENV: { PROD: 'prod' } };
export const PushAPI = {
  async initialize(signer: any) {
    const owner = signer.account.address;
    state().calls.push({ kind: 'initialize', owner });
    await signer.signMessage({ message: 'Synthetic test-only Push session' });
    await wait('initialize');
    const call = (kind: string, room: string, extra?: unknown) => state().calls.push({ kind, room, owner, extra });
    return { account: owner, decryptedPgpPvtKey: 'synthetic-test-key', chat: {
      history: async (room: string, options: any) => { call('history', room, options); const rows = clone(state().pages[options?.reference ?? 'latest'] ?? []); await wait('history'); return rows; },
      send: async (room: string, content: any) => { call('send', room, content); await wait('send'); return {}; },
      group: {
        info: async (room: string) => { call('info', room); return { chatId: room, groupName: 'Existing room', groupDescription: 'Preserved source room', isPublic: state().publicRoom }; },
        permissions: async (room: string) => { call('permissions', room); return clone(state().permissions); },
        participants: {
          status: async (room: string) => { call('status', room); return clone(state().membership); },
          list: async (room: string, options: any) => { call('members', room, options); const result = clone({ members: state().memberPages?.[`${options.filter.pending}:${options.page}`] ?? state().members ?? [] }); await wait('members'); return result; },
        },
        join: async (room: string) => { call('join', room); state().membership = { participant: true, pending: true, role: 'member' }; return {}; },
        leave: async (room: string) => { call('leave', room); state().membership = { participant: false, pending: false, role: 'member' }; return {}; },
        add: async (room: string, options: any) => { call('add', room, options); return {}; },
        remove: async (room: string, options: any) => { call('remove', room, options); return {}; },
      },
    } };
  },
};
