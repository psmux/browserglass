/**
 * An in memory `ProfileServicePort` for router level tests. Real fencing
 * (`fence = max(fence)+1` per key, atomic within one JS tick since nothing
 * here awaits before mutating), so a test can assert the same profile lease
 * mutual exclusion property the router requires, without pulling in the
 * real Profile Service.
 */

import type { ProfileAction, ResolvedProfileSpec } from '@browserglass/protocol';
import type {
  ProfileLeaseGrant,
  ProfileServicePort,
  ResolvedProfileSpecResult,
} from '../../src/router/types.js';

interface LeaseRecord {
  profileId: string;
  storedKey: string;
  fence: number;
  holderInstanceId: string | null;
}

export interface FakeProfileService extends ProfileServicePort {
  /** Test hook: forces the next `lease()` call to throw `E_PROFILE_BUSY`, once. */
  failNextLeaseWithBusy(): void;
  /** Test hook: makes every `applyReleaseAction()` call reject with `err`, standing in for a profile directory the filesystem could not reclaim. */
  failApplyReleaseActionWith(err: Error): void;
  /** Every `releaseLeaseQuietly()` call, with the profile identity the caller supplied. The identity is what lets a real implementation close the store row for a lease granted before a restart, so a caller dropping it is a leak. */
  readonly releaseLeaseQuietlyCalls: readonly {
    instanceId: string;
    identity: { tenantId: string; profileId: string; browserConfirmedGone?: boolean } | null;
  }[];
}

/** Creates a fresh in memory `ProfileServicePort`. */
export function createFakeProfileService(): FakeProfileService {
  const leasesByKey = new Map<string, LeaseRecord>();
  let failNextBusy = false;
  let applyReleaseActionError: Error | null = null;
  const releaseLeaseQuietlyCalls: {
    instanceId: string;
    identity: { tenantId: string; profileId: string; browserConfirmedGone?: boolean } | null;
  }[] = [];

  const service: FakeProfileService = {
    releaseLeaseQuietlyCalls,
    resolve: (req: {
      tenantId: string;
      appId: string;
      spec: import('@browserglass/protocol').ProfileSpec;
      dryRun?: boolean;
    }): Promise<ResolvedProfileSpecResult> => {
      const spec = req.spec;
      let resolved: ResolvedProfileSpec;
      if (spec.mode === 'ephemeral') {
        resolved = {
          mode: 'ephemeral',
          tenantId: req.tenantId as ResolvedProfileSpec['tenantId'],
          key: `eph:${Math.random().toString(36).slice(2)}`,
          templateId: null,
          seed: spec.seed ?? null,
          destroyOnRelease: true,
          snapshotOnRelease: false,
          ttlMs: null,
          profileId: null,
        };
      } else if (spec.mode === 'persistent') {
        resolved = {
          mode: 'persistent',
          tenantId: req.tenantId as ResolvedProfileSpec['tenantId'],
          key: spec.key,
          templateId: spec.templateId ?? null,
          seed: null,
          destroyOnRelease: false,
          snapshotOnRelease: spec.snapshotOnRelease ?? false,
          ttlMs: spec.ttlMs ?? null,
          profileId: null,
        };
      } else {
        resolved = {
          mode: 'template',
          tenantId: req.tenantId as ResolvedProfileSpec['tenantId'],
          key: spec.promoteToKey ?? `eph:${Math.random().toString(36).slice(2)}`,
          templateId: spec.templateId,
          seed: null,
          destroyOnRelease: !spec.promoteToKey,
          snapshotOnRelease: false,
          ttlMs: null,
          profileId: null,
        };
      }
      return Promise.resolve({ resolved, created: false });
    },

    lease: (req: {
      tenantId: string;
      appId: string;
      spec: ResolvedProfileSpec;
      instanceId: string;
      nodeId: string;
      ttlMs: number;
    }): Promise<ProfileLeaseGrant> => {
      if (failNextBusy) {
        failNextBusy = false;
        const err = new Error('profile busy') as Error & { code: string };
        err.code = 'E_PROFILE_BUSY';
        return Promise.reject(err);
      }
      const key = `${req.tenantId}:${req.appId}:${req.spec.key}`;
      const existing = leasesByKey.get(key);
      if (
        existing &&
        existing.holderInstanceId !== null &&
        existing.holderInstanceId !== req.instanceId
      ) {
        const err = new Error(`profile ${key} already leased`) as Error & { code: string };
        err.code = 'E_PROFILE_BUSY';
        return Promise.reject(err);
      }
      const fence = (existing?.fence ?? 0) + 1;
      const record: LeaseRecord = {
        profileId: existing?.profileId ?? `prf_${key}`,
        storedKey: key,
        fence,
        holderInstanceId: req.instanceId,
      };
      leasesByKey.set(key, record);
      return Promise.resolve({
        profileId: record.profileId,
        storedKey: record.storedKey,
        fence: record.fence,
        source: 'empty',
        expiresAt: Date.now() + req.ttlMs,
      });
    },

    releaseLeaseQuietly: (
      instanceId: string,
      identity?: { tenantId: string; profileId: string; browserConfirmedGone?: boolean },
    ): Promise<void> => {
      releaseLeaseQuietlyCalls.push({ instanceId, identity: identity ?? null });
      for (const record of leasesByKey.values()) {
        if (record.holderInstanceId === instanceId) record.holderInstanceId = null;
      }
      return Promise.resolve();
    },

    homeOf: (): Promise<{ nodeId: string; replicas: readonly string[] } | null> =>
      Promise.resolve(null),

    materialisedPathFor: (
      storedKey: string,
    ): Promise<{ path: string; containerPath: string | null }> =>
      Promise.resolve({ path: `/tmp/profiles/${storedKey}`, containerPath: null }),

    applyReleaseAction: (_req: {
      instanceId: string;
      profileId: string;
      action: ProfileAction;
    }): Promise<void> =>
      applyReleaseActionError === null
        ? Promise.resolve()
        : Promise.reject(applyReleaseActionError),

    hasShareGrant: (): Promise<boolean> => Promise.resolve(false),

    failNextLeaseWithBusy(): void {
      failNextBusy = true;
    },

    failApplyReleaseActionWith(err: Error): void {
      applyReleaseActionError = err;
    },
  };
  return service;
}
