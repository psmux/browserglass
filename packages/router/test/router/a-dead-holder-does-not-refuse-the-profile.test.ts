import type { Capability, InstanceStatus, Principal, ProfileLease } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, newId } from '@browserglass/protocol';
/**
 * `findReusable` step 1, profile sharing, and the permanent refusal it
 * used to hand out on behalf of a holder that was already dead.
 *
 * The chain, as it was: a persistent profile's lease row names a holder
 * instance; step 1 looks that instance up; `canShare` refuses it
 * `not_ready` because its state is `failed`; that becomes
 * `{ kind: 'busy' }`; and `BrowserRouter.doAcquire` turns it into
 * `E_PROFILE_BUSY: profile already leased`.
 *
 * Nothing above ever made that verdict go away. `Store.loadLiveLease`
 * selects on `released_at IS NULL` with no expiry predicate, and
 * `acquireProfileLease`'s refusal is a UNIQUE constraint over unreleased
 * leases which likewise never consults `expires_at`, so the lease row
 * stayed visible for ever and the profile was refused to everybody with a
 * message that read like a live conflict.
 *
 * It fell out of the first-acquire defect directly: that failure stranded
 * a lease (INSERTed before the fence write, tracked only after it) held by
 * an instance whose own row said `failed`.
 */
import { describe, expect, it } from 'vitest';
import { findReusable } from '../../src/router/reuse.js';
import { toStoredSpecInput } from '../../src/router/specMapping.js';
import { createFakeClock } from '../support/fakeClock.js';
import { createFakeProfileService } from '../support/fakeProfileService.js';
import { createMockStore, seedBasics } from '../support/mockStore.js';

const KEY = 'user:alice';

async function setUp(holderStatus: InstanceStatus, shareMinRemainingMs = 60_000) {
  const clock = createFakeClock();
  const store = createMockStore(clock);
  const { tenantId, appId, poolId } = seedBasics(store);
  const nodeId = newId('nod');
  const specId = (await store.upsertBrowserSpec(tenantId, toStoredSpecInput(DEFAULT_BROWSER_SPEC)))
    .id;

  const profile = await store.createProfile({
    tenantId,
    appId,
    key: KEY,
    mode: 'persistent',
    templateId: null,
    storagePath: `/fake/${KEY}/udd`,
    ttlMs: null,
  });

  const holder = await store.createInstance({
    tenantId,
    appId,
    poolId,
    nodeId,
    specId,
    profileId: profile.id,
    createdBySub: 'user-1',
    metadata: {},
    lifetime: 'viewer-bound',
  });
  await store.transitionInstance(tenantId, holder.id, ['launching'], holderStatus);

  // The stranded lease: unreleased, naming the holder.
  const lease: ProfileLease = {
    id: newId('plse'),
    profileId: profile.id,
    tenantId,
    holderInstanceId: holder.id,
    holderNodeId: nodeId,
    holderPid: null,
    fence: 1,
    acquiredAt: clock.now(),
    heartbeatAt: clock.now(),
    expiresAt: clock.now() + 30_000,
    releasedAt: null,
    releaseReason: null,
  };
  (await store.getProfile(tenantId, profile.id))!.lease = lease;

  const principal: Principal = {
    tenantId,
    appId,
    sub: 'user-1',
    subKind: 'user',
    caps: ['instance.create'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: 9_999_999_999,
  };

  const outcome = await findReusable({
    tenantId,
    appId,
    principal,
    resolvedSpec: DEFAULT_BROWSER_SPEC,
    specId,
    poolId,
    profileKey: KEY,
    sticky: null,
    liveViewerCountOf: () => 0,
    shareCtx: {
      shareMinRemainingMs,
      maxViewersPerStream: 4,
      maxStreamsPerSession: 4,
      profiles: createFakeProfileService(),
    },
    clock,
    store,
  });
  return { outcome, holderId: holder.id };
}

describe('a persistent profile whose holder is dead', () => {
  // The store level statuses that map onto a terminal lifecycle state.
  // `releasing` is in the production set too but has no store status of
  // its own to drive it from here.
  for (const status of ['failed', 'released', 'draining'] as const) {
    it(`is not refused as busy when the holder is '${status}'`, async () => {
      const { outcome } = await setUp(status);
      // The whole point: 'none' lets the acquire path go on and decide,
      // where 'busy' was a permanent refusal nothing could clear.
      expect(outcome.kind).toBe('none');
    });
  }

  it('shares with a live holder rather than refusing it', async () => {
    // The other half of the counterweight: narrowing which holders are
    // BELIEVED must not stop a healthy one being shared with.
    const { outcome } = await setUp('live');
    expect(outcome.kind).toBe('found');
  });

  it('still reports busy for a holder that really is live and cannot be shared with', async () => {
    // The counterweight. A holder in a live state that `canShare` refuses
    // (here for `expiring_soon`, since the fake instance expires well
    // inside `shareMinRemainingMs`) must still come back as busy: this
    // change narrows WHICH holders are believed, not whether a live
    // conflict is reported.
    // `shareMinRemainingMs` far beyond the holder's remaining lifetime,
    // so `canShare` refuses it `expiring_soon`. A live holder that cannot
    // be shared with is a real conflict and must still be reported as one.
    const { outcome, holderId } = await setUp('live', 10_000_000_000);
    expect(outcome.kind).toBe('busy');
    // And it says which holder and why, so the caller's error can too.
    if (outcome.kind === 'busy') {
      expect(outcome.holder.id).toBe(holderId);
      expect(outcome.reason).toBe('expiring_soon');
    }
  });
});
