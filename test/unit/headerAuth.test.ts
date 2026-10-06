import { describe, it, expect } from 'vitest';
import { HeaderAuthProvider } from '../../src/middleware/headerAuth.js';

const ctx = (v?: string) =>
  ({ get: (h: string) => (h.toLowerCase() === 'x-account-id' ? (v ?? '') : '') }) as any;

describe('HeaderAuthProvider', () => {
  const p = new HeaderAuthProvider([1, 2, 3]);
  it('numeric X-Account-Id is the session, without checking the account exists', async () => {
    expect(await p.getSession(ctx('42'))).toEqual({ accountId: 42 });
    expect(await p.getSession(ctx('999999'))).toEqual({ accountId: 999999 });
  });
  it.each([undefined, '', 'abc', '1.5', '-3', '0', '12abc', ' '])('no session for %j', async (v) => {
    expect(await p.getSession(ctx(v))).toBeNull();
  });
  it('isAdmin is membership in ADMIN_ACCOUNT_IDS', async () => {
    expect(await p.isAdmin(1)).toBe(true);
    expect(await p.isAdmin(3)).toBe(true);
    expect(await p.isAdmin(4)).toBe(false);
  });
});
