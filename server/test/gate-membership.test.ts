import { describe, expect, it, vi } from 'vitest';
import { createMembershipRevalidator, membershipEligibility } from '../gate-membership.js';
const address = `0x${'1'.repeat(40)}`;
const other = `0x${'2'.repeat(40)}`;
const gate = { combine: 'all', rules: [{ kind: 'token', standard: 'erc721', token: address, min: '1' }] };
function setup(mode = 'enforce') {
  let clock = 1000;
  const rooms = [{ id: 'room', namespace: 'acme', title: 'Members', chainId: 1, gate }];
  const members = [{ inboxId: 'alice', accountIdentifiers: [{ identifier: address, identifierKind: 0 }] }];
  const balance = vi.fn(async () => 0n);
  const group = { sync: vi.fn(), members: vi.fn(async () => members), isAdmin: vi.fn(() => false),
    isSuperAdmin: vi.fn((id) => id === 'bot'), removeMembers: vi.fn() };
  const bot = { inboxId: 'bot', conversations: { getConversationById: vi.fn(async () => group) }, fetchInboxIdByIdentifier: vi.fn(async () => 'alice') };
  const revalidator = createMembershipRevalidator({ mode, getClient: async () => bot, getRooms: async () => rooms,
    reader: () => ({ erc721Balance: balance }), now: () => clock });
  return { check: () => revalidator.checkMember('room', 'alice'), group, balance, rooms, members, bot, advance: () => { clock += 300001; } };
}
describe('membership revalidation', () => {
  it('requires two confirmed observations at least five minutes apart', async () => {
    const s = setup(); expect((await s.check()).status).toBe('observing');
    expect((await s.check()).status).toBe('observing'); expect(s.group.removeMembers).not.toHaveBeenCalled();
    s.advance(); expect((await s.check()).status).toBe('removed');
    expect(s.group.removeMembers).toHaveBeenCalledWith(['alice']);
  });
  it('never removes members in audit mode', async () => {
    const s = setup('audit'); await s.check(); s.advance();
    expect((await s.check()).status).toBe('would-remove'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('preserves members during RPC failures and resets removal evidence', async () => {
    const s = setup(); await s.check(); s.advance(); s.balance.mockRejectedValueOnce(new Error('RPC down'));
    expect((await s.check()).status).toBe('unknown');
    expect((await s.check()).status).toBe('observing'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('preserves a member when any bound wallet qualifies', async () => {
    const s = setup(); s.members[0].accountIdentifiers.push({ identifier: other, identifierKind: 0 });
    s.balance.mockResolvedValueOnce(0n).mockResolvedValueOnce(1n);
    expect((await s.check()).status).toBe('eligible'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('treats unknown or unbound identities conservatively', async () => {
    const s = setup(); s.bot.fetchInboxIdByIdentifier.mockResolvedValue('different-inbox');
    expect((await s.check()).status).toBe('unknown');
    s.members[0].accountIdentifiers[0].identifierKind = 1;
    expect((await s.check()).status).toBe('unknown'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('protects administrators, including promotions during evaluation', async () => {
    const s = setup(); await s.check(); s.advance();
    s.balance.mockImplementation(async () => { s.group.isAdmin.mockReturnValue(true); return 0n; });
    expect((await s.check()).status).toBe('protected'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('rejects changed policies or member identity bindings before removal', async () => {
    const s = setup(); await s.check(); s.advance();
    s.balance.mockImplementation(async () => { s.rooms.length = 0; return 0n; });
    expect((await s.check()).status).toBe('unknown'); expect(s.group.removeMembers).not.toHaveBeenCalled();
    const t = setup(); await t.check(); t.advance();
    t.balance.mockImplementation(async () => { t.members[0].accountIdentifiers.push({ identifier: other, identifierKind: 0 }); return 0n; });
    expect((await t.check()).status).toBe('unknown'); expect(t.group.removeMembers).not.toHaveBeenCalled();
  });
  it('requires bot authority and resets evidence when eligibility returns', async () => {
    const s = setup(); await s.check(); s.advance(); s.balance.mockResolvedValueOnce(1n);
    expect((await s.check()).status).toBe('eligible'); expect((await s.check()).status).toBe('observing');
    s.group.isSuperAdmin.mockReturnValue(false);
    expect((await s.check()).status).toBe('unknown'); expect(s.group.removeMembers).not.toHaveBeenCalled();
  });
  it('distinguishes Safe RPC errors from a confirmed non-owner', async () => {
    const safeGate = { combine: 'all', rules: [{ kind: 'safe', safe: address }] };
    expect(await membershipEligibility(safeGate, address, { safeOwners: async () => { throw new Error('RPC'); }, safeDelegates: async () => [] })).toBe('unknown');
    expect(await membershipEligibility(safeGate, address, { safeOwners: async () => [], safeDelegates: async () => [] })).toBe('ineligible');
  });
});
