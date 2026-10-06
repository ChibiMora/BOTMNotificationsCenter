// TYPE-ONLY (§6.3). The header stand-in and real provider belong to a later unit.
import type Koa from 'koa';
export interface AuthProvider {
  getSession(ctx: Koa.Context): Promise<{ accountId: number } | null>; // null → 401
  isAdmin(accountId: number): Promise<boolean>; // false → 403; throws → 503
}
