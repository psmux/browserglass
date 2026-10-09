/**
 * `BrowserRouter.release()` step 6, the profile teardown.
 *
 * The call used to read:
 *
 *   await this.profiles.applyReleaseAction({...}).catch(() => undefined);
 *
 * which discarded the failure with no log line and no metric. Measured
 * against the running demo, that hid a teardown which had never once
 * reclaimed a profile directory: 50 directories and about 3 GB had
 * accumulated on one machine, the release call still answered
 * `{"released":true,"outcome":"terminated"}`, and the server log said
 * nothing at all. A resource leak that reports nothing is the worst of
 * both worlds, because it looks exactly like a working system.
 *
 * These tests pin both halves of the fix: the failure is reported, and it
 * is still not fatal, since failing the whole release because a directory
 * could not be deleted would strand the instance row in `draining` and
 * hold its quota slot with it.
 */

import type { Capability, Principal } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import type { RouterLogFields, RouterLogger } from '../../src/router/logger.js';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';
import { seedBasics } from '../support/mockStore.js';

interface RecordingLogger extends RouterLogger {
  readonly warns: { fields: RouterLogFields; message: string }[];
}

function createRecordingLogger(): RecordingLogger {
  const warns: { fields: RouterLogFields; message: string }[] = [];
  return {
    warns,
    warn(fields, message) {
      warns.push({ fields, message });
    },
  };
}

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

describe('BrowserRouter.release: profile teardown failures', () => {
  it('reports a failed profile release action with the profile id, the action and the underlying error', async () => {
    const clock = createFakeClock();
    const logger = createRecordingLogger();
    const { router, store, profiles } = createTestRouter(clock, { logger });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;
    const acquired = await store.getInstance(tenantId, instanceId);
    const profileId = acquired?.profileId;
    expect(profileId).toBeTruthy();

    const failure = Object.assign(
      new Error(
        "EPERM: operation not permitted, rename 'C:\\p\\udd' -> 'C:\\p\\trash\\udd.1.ephemeral'",
      ),
      {
        code: 'E_PROFILE_TRASH_FAILED',
      },
    );
    profiles.failApplyReleaseActionWith(failure);

    await router.release(instanceId, {}, principal);

    expect(logger.warns).toHaveLength(1);
    const warned = logger.warns[0];
    expect(warned?.message).toMatch(/profile release action failed/);
    expect(warned?.fields['instanceId']).toBe(instanceId);
    expect(warned?.fields['profileId']).toBe(profileId);
    expect(warned?.fields['action']).toBe('destroy');
    expect(warned?.fields['errorCode']).toBe('E_PROFILE_TRASH_FAILED');
    expect(String(warned?.fields['error'])).toContain('EPERM');
  });

  it('still releases the instance, so a directory that could not be deleted never strands the row in draining', async () => {
    const clock = createFakeClock();
    const logger = createRecordingLogger();
    const { router, store, profiles } = createTestRouter(clock, { logger });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;
    profiles.failApplyReleaseActionWith(new Error('disk on fire'));

    const result = await router.release(instanceId, {}, principal);

    expect(result.outcome).toBe('terminated');
    const released = await store.getInstance(tenantId, instanceId);
    expect(released?.state).toBe('released');
  });

  it('hands the lease release the profile identity and a confirmed-dead browser, which is what lets an untracked lease be closed at all', async () => {
    // Without the identity the profile service resolves this instance's
    // lease through an in memory map that is empty for anything granted
    // before a restart, and a miss there means the store row is never
    // closed. `browserConfirmedGone` is earned here: control reaches the
    // lease release only after `terminateGraceThenForce` confirmed the
    // process is gone, and it throws rather than continuing otherwise.
    const clock = createFakeClock();
    const { router, store, profiles } = createTestRouter(clock);
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    const instanceId = handle.result.instanceId;
    const acquired = await store.getInstance(tenantId, instanceId);

    await router.release(instanceId, {}, principal);

    const call = profiles.releaseLeaseQuietlyCalls.find((c) => c.instanceId === instanceId);
    expect(call).toBeDefined();
    expect(call?.identity).toEqual({
      tenantId,
      profileId: acquired?.profileId,
      browserConfirmedGone: true,
    });
  });

  it('says nothing when the teardown succeeds, so the log line means something when it appears', async () => {
    const clock = createFakeClock();
    const logger = createRecordingLogger();
    const { router, store } = createTestRouter(clock, { logger });
    const { tenantId, appId } = seedBasics(store);
    const principal = principalFor(tenantId, appId);

    const handle = await router.acquire({}, principal);
    await router.release(handle.result.instanceId, {}, principal);

    expect(logger.warns).toEqual([]);
  });
});
