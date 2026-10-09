/**
 * `ProfileServicePortAdapter`: wires a real {@link ProfileService} into
 * `BrowserRouter`'s `ProfileServicePort` seam (`../router/types.ts`).
 * `BrowserRouter` and `LocalNode` depend only on the
 * narrower port; this adapter is the one place that knows both shapes,
 * so a future change to either side touches only this file.
 */

import type { ProfileAction, ResolvedProfileSpec } from '@browserglass/protocol';
import { type RouterLogger, consoleWarnRouterLogger, errorLogFields } from '../router/logger.js';
import type {
  ProfileLeaseGrant,
  ProfileServicePort,
  ResolvedProfileSpecResult,
} from '../router/types.js';
import type { ProfileService } from './ProfileService.js';
import { profileErr } from './errors.js';
import { storedKeyFor } from './keys.js';

/** Wraps a {@link ProfileService} as a `ProfileServicePort` for injection into `BrowserRouterOptions.profiles`. */
export class ProfileServicePortAdapter implements ProfileServicePort {
  private readonly logger: RouterLogger;

  /**
   * `logger` is where `releaseLeaseQuietly` reports what its contract
   * forbids it from throwing. Optional, defaulting to a console line, for
   * the same reason `BrowserRouter`'s own does: the failure this hides is
   * a resource leak, and the previous behaviour reported nothing at all.
   */
  constructor(
    private readonly service: ProfileService,
    logger?: RouterLogger,
  ) {
    this.logger = logger ?? consoleWarnRouterLogger;
  }

  async resolve(req: {
    tenantId: string;
    appId: string;
    spec: import('@browserglass/protocol').ProfileSpec;
    dryRun?: boolean;
  }): Promise<ResolvedProfileSpecResult> {
    // `resolve()`'s own instanceId is only used to synthesise an ephemeral
    // key; the port's callers (`BrowserRouter.acquire`) always pass a real
    // one via a later `lease()` call, so a placeholder here is harmless
    // for the ephemeral-key-shape computation and never persisted.
    const result = await this.service.resolve({
      tenantId: req.tenantId,
      appId: req.appId,
      spec: req.spec,
      instanceId: 'pending',
      ...(req.dryRun !== undefined ? { dryRun: req.dryRun } : {}),
    });
    if (result.kind === 'lease') return { resolved: result.resolved, created: result.created };
    if (result.kind === 'reuse') {
      throw profileErr(
        'E_PROFILE_BUSY',
        `profile already leased by instance ${result.instanceId}; BrowserRouter's own reuse check should have handled this before calling resolve`,
        { details: { instanceId: result.instanceId } },
      );
    }
    throw profileErr(result.code, `profile resolve failed: ${result.code}`, {
      details: result.detail,
    });
  }

  async lease(req: {
    tenantId: string;
    appId: string;
    spec: ResolvedProfileSpec;
    instanceId: string;
    nodeId: string;
    ttlMs: number;
    reclaimFromHolderInstanceId?: string;
  }): Promise<ProfileLeaseGrant> {
    const result = await this.service.leaseResolved({
      tenantId: req.tenantId,
      appId: req.appId,
      resolved: req.spec,
      instanceId: req.instanceId,
      nodeId: req.nodeId,
      ttlMs: req.ttlMs,
      ...(req.reclaimFromHolderInstanceId !== undefined
        ? { reclaimFromHolderInstanceId: req.reclaimFromHolderInstanceId }
        : {}),
    });
    if (result.kind !== 'leased') {
      throw profileErr('E_PROFILE_BUSY', 'lease() unexpectedly resolved to a reuse result', {
        details: {},
      });
    }
    return {
      profileId: result.profileId,
      storedKey: storedKeyFor(req.tenantId, req.appId, result.resolved.key),
      fence: result.fence,
      source: materialisationToSource(result.materialisation),
      expiresAt: result.expiresAt,
    };
  }

  async releaseLeaseQuietly(
    instanceId: string,
    identity?: { tenantId: string; profileId: string; browserConfirmedGone?: boolean },
  ): Promise<void> {
    // `ProfileService` tracks leases by `leaseId`, not `instanceId`; find
    // the matching tracked lease (there is at most one per instance in
    // this build, since one instance holds at most one profile lease) and
    // release it through the normal path, swallowing every error, since
    // this method's whole contract is "never throw".
    const leaseId = this.service.leaseIdForInstance(instanceId);
    if (!leaseId) {
      // The miss that stranded 48 of 50 lease rows on the demo. This
      // lookup goes through an in memory map populated only by leases this
      // process granted, so every lease from before a restart is a miss,
      // and returning here left the store row open forever. With the
      // profile identity the store can be asked directly; without it there
      // is nothing to ask, and the old behaviour is the only honest one.
      if (!identity) return;
      const resolved = await this.service
        .releaseUntrackedLease({
          tenantId: identity.tenantId,
          profileId: identity.profileId,
          instanceId,
          reason: 'normal',
          ...(identity.browserConfirmedGone !== undefined
            ? { browserConfirmedGone: identity.browserConfirmedGone }
            : {}),
        })
        .catch((err: unknown) => {
          this.logger.warn(
            { instanceId, profileId: identity.profileId, ...errorLogFields(err) },
            'releaseLeaseQuietly: could not release the store side of an untracked profile lease; the row is left open and will block the next acquire on this profile',
          );
          return null;
        });
      // `'released'` is the repair and needs no line. The other two
      // non trivial outcomes are refusals, and a refusal that says nothing
      // is how this defect stayed invisible in the first place.
      if (resolved?.outcome === 'held-by-other-instance') {
        this.logger.warn(
          {
            instanceId,
            profileId: identity.profileId,
            leaseId: resolved.leaseId,
            holderInstanceId: resolved.holderInstanceId,
          },
          'releaseLeaseQuietly: left an untracked profile lease alone because another instance now holds it',
        );
      } else if (resolved?.outcome === 'live-holder') {
        this.logger.warn(
          {
            instanceId,
            profileId: identity.profileId,
            leaseId: resolved.leaseId,
            expiresAt: resolved.expiresAt,
          },
          'releaseLeaseQuietly: left an untracked profile lease alone because it has not expired and the caller could not confirm the browser is gone; the row stays open until something expires it',
        );
      }
      return;
    }
    await this.service.release({ leaseId, fence: -1, reason: 'normal' }).catch((err: unknown) => {
      // The contract stays "never throw": `BrowserRouter.release()` calls
      // this between the terminate and the `released` transition, and a
      // throw here would strand the instance row in `draining`.
      //
      // What changes is that it is no longer silent. `ProfileService.
      // release()` trashes an ephemeral profile's directory BEFORE its
      // store write, so anything that fails in that trash also skips
      // `store.releaseProfileLease` and leaves the lease row with
      // `released_at = NULL` forever. That is precisely what was
      // happening (`ENOENT`, because `release()` step 6 had already
      // reclaimed the same directory) and this `.catch` is why nobody
      // could see it: 46 of 48 lease rows in the demo database are still
      // marked held, by instances that were released hours earlier.
      this.logger.warn(
        { instanceId, leaseId, ...errorLogFields(err) },
        'releaseLeaseQuietly: the profile lease release failed; the lease row and the profile directory may both be left behind',
      );
    });
  }

  async homeOf(
    tenantId: string,
    key: string,
  ): Promise<{ nodeId: string; replicas: readonly string[] } | null> {
    const profile = await this.service.list({ tenantId, keyPrefix: key, limit: 1 });
    const match = profile.find((p) => p.key === key);
    if (!match || !match.homeNodeId) return null;
    return { nodeId: match.homeNodeId, replicas: match.replicaNodeIds };
  }

  async materialisedPathFor(
    storedKey: string,
  ): Promise<{ path: string; containerPath: string | null }> {
    const parsed = parseStoredKey(storedKey);
    if (!parsed)
      throw profileErr('E_PROFILE_NOT_FOUND', `malformed storedKey "${storedKey}"`, {
        details: { storedKey },
      });
    const found = await this.service.materialisedPathForStoredKey(
      parsed.tenantId,
      parsed.appId,
      parsed.rawKey,
    );
    if (!found)
      throw profileErr(
        'E_PROFILE_NOT_FOUND',
        `no materialised profile for storedKey "${storedKey}"`,
        { details: { storedKey } },
      );
    return found;
  }

  async applyReleaseAction(req: {
    instanceId: string;
    profileId: string;
    action: ProfileAction;
    tenantId?: string;
  }): Promise<void> {
    // A supplied `tenantId` is used directly. The fallback below recovers
    // it from `ProfileService`'s in memory lease map, which works only
    // because `BrowserRouter` calls this before `releaseLeaseQuietly`
    // clears the tracked lease, and only for a lease this process granted:
    // after a restart the map is empty, `tenantIdForInstance` returns
    // null, and the whole call became a silent no-op, so the profile
    // directory was never trashed. That is the disk side of the same
    // defect `releaseLeaseQuietly`'s `identity` fixes on the database
    // side, and it is why 51 of the demo's 54 profile directories were
    // still full rather than empty shells.
    if (req.tenantId !== undefined) {
      await this.service.applyReleaseAction({
        instanceId: req.instanceId,
        profileId: req.profileId,
        tenantId: req.tenantId,
        action: req.action,
      });
      return;
    }
    await this.service.applyReleaseActionForInstance(req.instanceId, req.profileId, req.action);
  }

  async hasShareGrant(
    profileId: string,
    granteeAppId: string,
    level: 'read' | 'write',
  ): Promise<boolean> {
    return this.service.hasShareGrant(profileId, granteeAppId, level);
  }

  async renewForRestart(req: { instanceId: string; ttlMs: number }): Promise<ProfileLeaseGrant> {
    const result = await this.service.renewForInstance(req.instanceId, req.ttlMs);
    return {
      profileId: result.profileId,
      storedKey: result.storedKey,
      fence: result.fence,
      source: result.source,
      expiresAt: result.expiresAt,
    };
  }
}

function materialisationToSource(
  materialisation: string,
): 'empty' | 'template' | 'restore' | 'import' {
  if (materialisation === 'template-clone' || materialisation === 'existing') return 'template';
  if (materialisation === 'restore') return 'restore';
  if (materialisation === 'import') return 'import';
  return 'empty';
}

/** Parses `t:<tenantId>/a:<appId>/<rawKey>` back into its parts. `tenantId`/`appId` are ULID based branded ids and never contain `/`, so this is unambiguous even though `rawKey` may itself contain `/` (the caller key regex allows it). */
function parseStoredKey(
  storedKey: string,
): { tenantId: string; appId: string; rawKey: string } | null {
  const match = /^t:([^/]+)\/a:([^/]+)\/(.*)$/.exec(storedKey);
  if (!match) return null;
  const [, tenantId, appId, rawKey] = match;
  if (!tenantId || !appId || rawKey === undefined) return null;
  return { tenantId, appId, rawKey };
}
