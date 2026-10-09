import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import type { AttachCredentialIssuer } from '../../src/router/types.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

function principalFor(tenantId: string, appId: string, sub = 'user-1'): Principal {
  return {
    tenantId,
    appId,
    sub,
    subKind: 'user',
    caps: ['instance.create', 'view', 'control'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

/**
 * The gap this covers: `placeAndLaunch`'s candidate loop (`BrowserRouter.ts`
 * around :959-1113) calls `this.nodes.launch()` and, once that resolves, a
 * real Chrome process exists on the winning node. Everything after it in
 * the same try (`store.createSession`, `store.transitionInstance`, and
 * `buildResult`'s credential mint via `mintAttachCredential`) can still
 * throw, and the real world version of that throw is exactly this: a
 * production `AttachCredentialIssuer` (`@browserglass/server`'s `TokenApi`)
 * rejecting with `E_NO_SIGNING_KEY` (`auth/tokens.ts:61`) when the app has
 * no active signing key configured. Before the fix, the catch block for
 * that failure released the profile lease and forgot the instance from
 * `liveRuntimeByInstance`, but never told the node to tear the browser
 * down, so the process launched by `this.nodes.launch()` was simply
 * abandoned.
 */
describe('BrowserRouter.acquire, post-launch failure terminates the launched browser', () => {
  it('a credential mint failure after a successful launch tears the browser down rather than abandoning it', async () => {
    const clock = createFakeClock();
    const throwingIssuer: AttachCredentialIssuer = {
      issue() {
        return Promise.reject(
          Object.assign(
            new Error('No active signing key for app "test-app". Add one to auth.keys.'),
            { code: 'E_NO_SIGNING_KEY' },
          ),
        );
      },
    };
    const { router, nodes, store } = createTestRouter(clock, { attachCredentials: throwingIssuer });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    // The browser gets launched (this.nodes.launch() resolves) before
    // buildResult's credential mint runs and throws: the launch itself
    // must succeed for this to be the post-launch failure this test
    // targets, not an ordinary launch failure (already covered elsewhere).
    // A single candidate exhausts `placeAndLaunch`'s retry loop and
    // surfaces as `E_LAUNCH_FAILED` (`BrowserRouter.ts`'s "every
    // placement candidate failed" throw), with the real cause preserved,
    // unmasked, in `context.attempts[0].error` (`RouterError.context`,
    // populated from `routerErr`'s `details`, `toLaunchAttemptError`):
    // proof the teardown this test checks for below did not swallow or
    // replace the original failure.
    await expect(router.acquire({}, principal)).rejects.toMatchObject({
      code: 'E_LAUNCH_FAILED',
      context: { attempts: [{ error: { code: 'E_NO_SIGNING_KEY' } }] },
    });

    expect(nodes.launchCount).toBe(1);
    // The launched browser must have been torn down, not abandoned: a
    // `terminate()` call reached the fake transport for the same instance
    // this launch just created.
    expect(nodes.terminateCount).toBe(1);
    expect(nodes.terminateCalls).toHaveLength(1);
    expect(nodes.terminateCalls[0]?.mode).toBe('force');
  });
});
