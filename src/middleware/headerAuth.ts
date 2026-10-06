/** Stand-in AuthProvider (AUTH_IMPL=header, §9.1): the caller is the X-Account-Id header; admins are ADMIN_ACCOUNT_IDS. */
import type Koa from 'koa';
import type { AuthProvider } from './auth.js';

const POSITIVE_INT = /^[1-9][0-9]*$/;

export class HeaderAuthProvider implements AuthProvider {
  constructor(private readonly adminAccountIds: readonly number[]) {}

  /** Absent or non-numeric header → no session. Does not check that the account exists. */
  async getSession(ctx: Koa.Context): Promise<{ accountId: number } | null> {
    const raw = ctx.get('x-account-id');
    if (!POSITIVE_INT.test(raw)) {
      return null;
    }
    const accountId = Number(raw);
    return Number.isSafeInteger(accountId) ? { accountId } : null;
  }

  async isAdmin(accountId: number): Promise<boolean> {
    return this.adminAccountIds.includes(accountId);
  }
}
