import type { BrowserSpec, Capability, Instance, Principal } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC, newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { SHARE_SIGNIFICANT_FIELDS, canShare, specConflicts } from '../../src/router/reuse.js';
import { createFakeProfileService } from '../support/fakeProfileService.js';

function principalFor(tenantId: string, appId: string): Principal {
  return {
    tenantId,
    appId,
    sub: 'user-1',
    subKind: 'user',
    caps: ['instance.create'] as Capability[],
    scope: { kind: 'tenant' },
    jti: newId('jti'),
    exp: 9_999_999_999,
  };
}

function instanceFor(overrides: Partial<Instance>): Instance {
  const tenantId = newId('ten');
  const appId = newId('app');
  return {
    id: newId('inst'),
    tenantId,
    appId,
    poolId: null,
    subject: 'user-1',
    state: 'ready',
    stateReason: null,
    stateChangedAt: 0,
    nodeId: newId('nod'),
    fence: 1,
    spec: DEFAULT_BROWSER_SPEC,
    profileSpec: {
      mode: 'persistent',
      tenantId,
      key: 'k1',
      templateId: null,
      seed: null,
      destroyOnRelease: false,
      snapshotOnRelease: false,
      ttlMs: null,
      profileId: newId('prf'),
    },
    profileId: newId('prf'),
    sessionId: newId('sess'),
    runtime: null,
    acquiredAt: 0,
    readyAt: 0,
    releasedAt: null,
    expiresAt: 1_000_000,
    lastActivityAt: 0,
    metadata: {},
    incidents: [],
    lifetime: 'viewer-bound',
    firstViewerAt: null,
    releaseReason: null,
    restartCount: 0,
    peakRssMib: null,
    osPid: null,
    ...overrides,
  };
}

describe('specConflicts / SHARE_SIGNIFICANT_FIELDS', () => {
  it('reports no conflicts for identical specs', () => {
    expect(specConflicts(DEFAULT_BROWSER_SPEC, DEFAULT_BROWSER_SPEC)).toEqual([]);
  });

  it('flags a channel mismatch', () => {
    const other: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, channel: 'chromium' };
    expect(specConflicts(DEFAULT_BROWSER_SPEC, other)).toContain('channel');
  });

  it('is not significant on viewport, deliberately', () => {
    expect(SHARE_SIGNIFICANT_FIELDS).not.toContain('viewport');
    const other: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      viewport: { width: 320, height: 240, deviceScaleFactor: 2 },
    };
    expect(specConflicts(DEFAULT_BROWSER_SPEC, other)).toEqual([]);
  });

  it('compares proxy.server/bypass only, excluding username/password', () => {
    const base: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      proxy: { server: 'http://proxy:8080', bypass: [], username: 'alice', password: 'secret1' },
    };
    const differentCreds: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      proxy: { server: 'http://proxy:8080', bypass: [], username: 'bob', password: 'secret2' },
    };
    expect(specConflicts(base, differentCreds)).toEqual([]);

    const differentServer: BrowserSpec = {
      ...DEFAULT_BROWSER_SPEC,
      proxy: { server: 'http://other:8080', bypass: [], username: 'alice', password: 'secret1' },
    };
    expect(specConflicts(base, differentServer)).toContain('proxy.server');
  });
});

describe('canShare', () => {
  const shareCtx = {
    shareMinRemainingMs: 60_000,
    maxViewersPerStream: 8,
    maxStreamsPerSession: 8,
    profiles: createFakeProfileService(),
  };

  it('allows sharing within the same app when everything matches', async () => {
    const instance = instanceFor({});
    const principal = principalFor(instance.tenantId, instance.appId);
    const verdict = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: instance.appId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 0 },
    );
    expect(verdict.allowed).toBe(true);
  });

  it('denies across tenants', async () => {
    const instance = instanceFor({});
    const principal = principalFor(newId('ten'), instance.appId);
    const verdict = await canShare(
      instance,
      { tenantId: principal.tenantId, appId: instance.appId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 0 },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'cross_tenant' });
  });

  it('denies when the instance is not ready or degraded', async () => {
    const instance = instanceFor({ state: 'recovering' });
    const principal = principalFor(instance.tenantId, instance.appId);
    const verdict = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: instance.appId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 0 },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'not_ready' });
  });

  it('denies when the instance expires too soon', async () => {
    const instance = instanceFor({ expiresAt: 1000 });
    const principal = principalFor(instance.tenantId, instance.appId);
    const verdict = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: instance.appId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 990, liveViewerCount: 0 },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'expiring_soon' });
  });

  it('denies cross app without a grant, allows with one', async () => {
    const instance = instanceFor({});
    const otherAppId = newId('app');
    const principal = principalFor(instance.tenantId, otherAppId);

    const denied = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: otherAppId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 0 },
    );
    expect(denied).toMatchObject({ allowed: false, reason: 'cross_app' });

    const grantedProfiles = {
      ...createFakeProfileService(),
      hasShareGrant: () => Promise.resolve(true),
    };
    const allowed = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: otherAppId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, profiles: grantedProfiles, now: 0, liveViewerCount: 0 },
    );
    expect(allowed.allowed).toBe(true);
  });

  it('denies on a share significant spec conflict', async () => {
    const instance = instanceFor({});
    const principal = principalFor(instance.tenantId, instance.appId);
    const conflicting: BrowserSpec = { ...DEFAULT_BROWSER_SPEC, stealth: 'full' };
    const verdict = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: instance.appId, resolvedSpec: conflicting },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 0 },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'spec_conflict' });
  });

  it('denies at the viewer limit', async () => {
    const instance = instanceFor({});
    const principal = principalFor(instance.tenantId, instance.appId);
    const verdict = await canShare(
      instance,
      { tenantId: instance.tenantId, appId: instance.appId, resolvedSpec: DEFAULT_BROWSER_SPEC },
      principal,
      { ...shareCtx, now: 0, liveViewerCount: 64, maxViewersPerStream: 8, maxStreamsPerSession: 8 },
    );
    expect(verdict).toMatchObject({ allowed: false, reason: 'viewer_limit' });
  });
});
