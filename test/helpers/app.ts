/**
 * Test app factory. Contract tests should use `testApp`: it is createApp(makeTestDeps(overrides)) wired with the
 * real HeaderAuthProvider stand-in (X-Account-Id header; admins are account ids 1-3, config.adminAccountIds).
 *
 *   const db = testDb();                        // one shared pool per test file ...
 *   afterAll(() => db.destroy());               // ... destroyed in afterAll
 *   const { request, deps } = testApp({ db });  // request = supertest agent bound to the app
 *   await request.get('/admin/x').set('X-Account-Id', '1');
 *
 * Any Deps field can be overridden (clock, config, auth, ...). `clock` is the FixedClock the helper created, or
 * the override as given (typed as such). If `db` is omitted the helper opens its own pool; call `close()` to
 * destroy it (close() never destroys a db the test passed in).
 *
 * `options.routers(deps)` replaces the routers createApp mounts, e.g. the real adminRouter(deps) with a probe
 * route added; it defaults to the real routers.
 */
import supertest from 'supertest';
import type { Deps } from '../../src/lib/deps.js';
import { createApp, type Routers } from '../../src/app.js';
import { HeaderAuthProvider } from '../../src/middleware/headerAuth.js';
import { makeTestDeps } from './deps.js';
import type { FixedClock } from './clock.js';

type ClockOf<O extends Partial<Deps>> = O extends { clock: infer C } ? C : FixedClock;

export type TestAppOptions = { routers?: (deps: Deps) => Routers };

export function testApp<O extends Partial<Deps> = Record<never, never>>(
  overrides: O = {} as O,
  options: TestAppOptions = {},
) {
  const base = makeTestDeps(overrides);
  const deps: Deps = { ...base, auth: overrides.auth ?? new HeaderAuthProvider(base.config.adminAccountIds) };
  const app = createApp(deps, options.routers?.(deps));
  const ownsDb = overrides.db === undefined;
  const close = async () => {
    if (ownsDb) await deps.db.destroy();
  };
  return { app, deps, clock: deps.clock as ClockOf<O>, request: supertest(app.callback()), close };
}
