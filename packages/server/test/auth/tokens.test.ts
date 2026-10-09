import { describe, expect, it } from 'vitest';
import { InProcessJtiCache } from '../../src/auth/jti-cache.js';
import { generateEd25519KeyMaterial } from '../../src/auth/jwt.js';
import { TokenApiImpl } from '../../src/auth/tokens.js';
import type { AppSigningKey } from '../../src/config/types.js';

function buildTokenApi(maxCaps: readonly string[]) {
  const material = generateEd25519KeyMaterial();
  const key: AppSigningKey = {
    kid: 'key_test',
    alg: 'EdDSA',
    publicKey: material.publicKey,
    privateKey: material.privateKey,
    status: 'active',
  };
  return new TokenApiImpl({
    keys: [key],
    defaultTtlSeconds: 120,
    maxTtlSeconds: 900,
    maxCaps: maxCaps as never,
    tenantAllowedCaps: maxCaps as never,
    clock: { now: () => Date.now() },
    tenantId: 'ten_00000000000000000000000000' as never,
    appId: 'app_00000000000000000000000000' as never,
    issuer: 'app_00000000000000000000000000' as never,
    clockSkewSeconds: 30,
    jtiCache: new InProcessJtiCache(1000),
  });
}

describe('TokenApi.issueWithMeta', () => {
  it('narrows a requested cap above max_caps and lists it in narrowed, never in issued.caps', async () => {
    const tokens = buildTokenApi(['view', 'control']);
    const issued = await tokens.issueWithMeta({
      sub: 'user:1',
      caps: ['view', 'devtools'] as never,
      scope: { kind: 'tenant' },
    });
    expect(issued.caps).toEqual(['view']);
    expect(issued.narrowed).toEqual(['devtools']);
    expect(issued.caps).not.toContain('devtools');
  });

  it('verify() round trips a token issued by the same instance', async () => {
    const tokens = buildTokenApi(['view', 'control']);
    const issued = await tokens.issueWithMeta({
      sub: 'user:1',
      caps: ['view'] as never,
      scope: { kind: 'tenant' },
    });
    const principal = await tokens.verify(issued.token);
    expect(principal.sub).toBe('user:1');
    expect(principal.caps).toEqual(['view']);
  });

  it('refuses to issue admin without iUnderstandAdmin', async () => {
    const tokens = buildTokenApi(['view', 'admin']);
    await expect(
      tokens.issueWithMeta({ sub: 'user:1', caps: ['admin'] as never, scope: { kind: 'tenant' } }),
    ).rejects.toThrow(/iUnderstandAdmin/);
  });

  it('rejects an unknown capability string', async () => {
    const tokens = buildTokenApi(['view']);
    await expect(
      tokens.issueWithMeta({
        sub: 'user:1',
        caps: ['not-a-real-cap'] as never,
        scope: { kind: 'tenant' },
      }),
    ).rejects.toThrow(/canonical/);
  });
});
