import { BglsError } from '@browserglass/protocol';
/**
 * A WS viewer attaching to a gateway that does not own the instance's live
 * CDP session used to fall all the way through to a generic "no live CDP
 * endpoint" `Error` (`ManagedSessionFactory`'s old bespoke message,
 * `packages/server/src/session/factory.ts`), indistinguishable from the
 * instance genuinely not existing. `BrowserRouter.driveInstance()` already
 * tells the factory exactly which node owns the instance (`DriveResolution.nodeId`,
 * `local: false`); this test proves the factory now uses that instead of
 * discarding it: `local: false` throws a `BglsError('E_INSTANCE_WRONG_NODE')`
 * carrying `context.nodeId`, before ever reaching the old fallback error.
 *
 * A fake, duck-typed `BrowserRouter` stands in here rather than router's
 * own real test harness (`packages/router/test/support/mockStore.ts`):
 * this file only needs `driveInstance()`'s return shape, and `factory.ts`
 * is the one file that imports `@browserglass/router` at all, so a real
 * router would pull in a store, a node transport, and a profile service
 * this test has no use for.
 */
import { describe, expect, it } from 'vitest';
import type { RouterWiring } from '../../src/lifecycle/wiring.js';
import { createManagedSessionFactory } from '../../src/session/factory.js';

/** Just enough of `BrowserRouter`'s surface for `createManagedSessionFactory`'s call sequence: `driveInstance()` first, `describe()` only if `local` is true. */
function fakeRouter(resolution: { nodeId: string; local: boolean }): RouterWiring['router'] {
  return {
    driveInstance: async () => ({
      instanceId: 'inst_x',
      sessionId: 'sess_x',
      nodeId: resolution.nodeId,
      local: resolution.local,
    }),
    describe: async () => {
      throw new Error('describe() should not be called when driveInstance() resolves local: false');
    },
  } as unknown as RouterWiring['router'];
}

describe('createManagedSessionFactory: local: false', () => {
  it('throws BglsError(E_INSTANCE_WRONG_NODE) carrying the owning nodeId, without calling describe()', async () => {
    const wiring: RouterWiring = {
      router: fakeRouter({ nodeId: 'nod_other', local: false }),
      nodeId: 'nod_this' as never,
      profileService: {} as never,
      nodeTransport: {} as never,
      nodeRegistry: {} as never,
    };
    const factory = createManagedSessionFactory(() => wiring);

    await expect(
      factory('inst_x', { tenantId: 'ten_x', appId: 'app_x', onIdle: () => undefined }),
    ).rejects.toMatchObject({
      code: 'E_INSTANCE_WRONG_NODE',
      context: { nodeId: 'nod_other' },
    });
  });

  it('is an actual BglsError instance, not a plain Error, so `err instanceof BglsError` in connection.ts works', async () => {
    const wiring: RouterWiring = {
      router: fakeRouter({ nodeId: 'nod_other', local: false }),
      nodeId: 'nod_this' as never,
      profileService: {} as never,
      nodeTransport: {} as never,
      nodeRegistry: {} as never,
    };
    const factory = createManagedSessionFactory(() => wiring);

    await expect(
      factory('inst_x', { tenantId: 'ten_x', appId: 'app_x', onIdle: () => undefined }),
    ).rejects.toBeInstanceOf(BglsError);
  });
});
