/**
 * `mapRouterError`'s `E_QUOTA_INSTANCES` enrichment: a caller who was just
 * refused for hitting a quota must be able to tell, from the error alone,
 * which config field bound and how to raise it, without reading
 * `packages/router/src/admission/admit.ts`'s source. Before this, the
 * message was only `quota exceeded at scope ${scope}` (`BrowserRouter.ts`'s
 * `doAcquire`/`placeAndLaunch`), naming the SCOPE but not the KNOB.
 */
import { describe, expect, it } from 'vitest';
import { type RestError, mapRouterError } from '../../src/rest/errors.js';

function routerError(code: string, message: string, context?: Record<string, unknown>): unknown {
  return { httpStatus: 429, code, message, context };
}

function expectMapped(err: unknown): RestError {
  try {
    mapRouterError(err);
  } catch (mapped) {
    return mapped as RestError;
  }
  throw new Error('mapRouterError did not throw');
}

describe('mapRouterError: E_QUOTA_INSTANCES names the binding limit', () => {
  it('tenant scope names limits.maxInstances and BGLS_MAX_INSTANCES', () => {
    const mapped = expectMapped(
      routerError('E_QUOTA_INSTANCES', 'quota exceeded at scope tenant', {
        scope: 'tenant',
        limit: 200,
        current: 200,
      }),
    );
    expect(mapped.message).toContain('BGLS_MAX_INSTANCES');
    expect(mapped.message).toContain('limits.maxInstances');
  });

  it("app scope names limits.maxInstances and BGLS_MAX_INSTANCES too, since this build gives one app its tenant's ceiling", () => {
    const mapped = expectMapped(
      routerError('E_QUOTA_INSTANCES', 'quota exceeded at scope app', {
        scope: 'app',
        limit: 200,
        current: 200,
      }),
    );
    expect(mapped.message).toContain('BGLS_MAX_INSTANCES');
  });

  it("pool scope names the pool's own maxInstances, with no invented env var", () => {
    const mapped = expectMapped(
      routerError('E_QUOTA_INSTANCES', 'quota exceeded at scope pool', {
        scope: 'pool',
        limit: 50,
        current: 50,
      }),
    );
    expect(mapped.message).toContain('maxInstances');
    expect(mapped.message).toContain('pool');
    expect(mapped.message).not.toContain('BGLS_');
  });

  it("user scope names the pool's own maxInstancesPerUser, the actual knob admit() enforces, with no invented env var", () => {
    const mapped = expectMapped(
      routerError('E_QUOTA_INSTANCES', 'quota exceeded at scope user', {
        scope: 'user',
        limit: 50,
        current: 50,
      }),
    );
    expect(mapped.message).toContain('maxInstancesPerUser');
    expect(mapped.message).not.toContain('BGLS_');
  });

  it('preserves the original message and details when the scope is missing or unrecognised', () => {
    const mapped = expectMapped(
      routerError('E_QUOTA_INSTANCES', 'quota exceeded at scope tenant', {}),
    );
    expect(mapped.message).toBe('quota exceeded at scope tenant');
  });

  it('leaves every other router error code unchanged', () => {
    const mapped = expectMapped(routerError('E_INSTANCE_NOT_FOUND', 'no such instance'));
    expect(mapped.message).toBe('no such instance');
    expect(mapped.code).toBe('E_INSTANCE_NOT_FOUND');
  });
});
