/**
 * `DEFAULT_POOL_LIMITS.maxInstancesPerUser`, the number that actually
 * governs `admit()`'s `'user'` scope check
 * (`packages/router/src/admission/admit.ts` reads
 * `poolLimits.maxInstancesPerUser`, never `QuotaLimits.maxInstancesPerUser`).
 * There is no `pools` DDL column backing this field (`defaults.ts`'s own
 * module doc), so every pool row gets this value unconditionally: it is
 * the REAL per-subject ceiling, independent of
 * `BGLS_MAX_INSTANCES_PER_SUBJECT`/`ResolvedConfig.limits.maxInstancesPerSubject`,
 * which only ever reaches the store-agnostic `QuotaLimits.maxInstancesPerUser`
 * field (`server/src/lifecycle/wiring.ts`'s `quotaProviderFromLimits`) and
 * is never actually consulted by admission. This suite locks in the raised
 * value (50, was 10) both at the constant and at a real, freshly created
 * pool row, so a future edit cannot quietly drop the swarm fix back to the
 * old ceiling.
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_POOL_LIMITS } from '../src/defaults.js';
import { freshStore, seedBasics } from './helpers.js';

describe('DEFAULT_POOL_LIMITS.maxInstancesPerUser', () => {
  it('is 50, raised from the old, swarm-hostile 10', () => {
    expect(DEFAULT_POOL_LIMITS.maxInstancesPerUser).toBe(50);
  });

  it('a freshly created pool inherits the raised ceiling, with no way to have been created with the old one', async () => {
    const f = freshStore();
    try {
      const { pool } = await seedBasics(f.store);
      expect(pool.limits.maxInstancesPerUser).toBe(50);
    } finally {
      f.cleanup();
    }
  });
});
