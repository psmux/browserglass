/**
 * `ProfileService`: the router decides, the runtime does. This class owns every decision about
 * a profile's lifecycle (leasing, fencing, quarantine, GC); it never
 * touches a byte itself, delegating every filesystem operation to an
 * injected `ProfileFs` (implemented by `runtime-host`, received by
 * injection so this package never imports it, matching the router's own
 * `router -/-> core` layering rule extended to `router -/-> runtime-host`).
 *
 * Builds `resolve`, `acquire`, `renew`, `release`, `list`, `get`, `delete`,
 * and `hold` for real. `snapshot`, `export`, `import`, `restore`,
 * `salvage`, `migrate`, and the whole `TemplateService` bake/verify/
 * freeze/retire workflow throw `E_NOT_IMPLEMENTED`; materialising *from*
 * an existing frozen template directory (the `template` mode's normal
 * `acquire` path) is implemented, since `acquire` needs it.
 */

import { join } from 'node:path';
import type {
  AppId,
  NodeId,
  Profile,
  ProfileLease,
  ProfileSpec,
  ResolvedProfileSpec,
  Store,
  TenantId,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import type { ProfileFs } from '@browserglass/protocol';
import type { Clock, ClockTimer } from '../router/clock.js';
import { ProfileServiceError, notImplemented, profileErr } from './errors.js';
import { ephemeralCallerKey, storedKeyFor, validateCallerKey } from './keys.js';
import {
  DEFAULT_PROFILE_SERVICE_CONFIG,
  type FenceLostHandler,
  type FenceLostReport,
  type GcStep,
  type ProfileAcquireRequest,
  type ProfileAcquireResult,
  type ProfileDeleteRequest,
  type ProfileDeleteResult,
  type ProfileErrorCode,
  type ProfileGcRequest,
  type ProfileGcResult,
  type ProfileHoldRequest,
  type ProfileListRequest,
  type ProfileMaterialisation,
  type ProfileReleaseRequest,
  type ProfileReleaseResult,
  type ProfileRenewRequest,
  type ProfileRenewResult,
  type ProfileServiceConfig,
  type RenewFailureReason,
  type ResolveRequest,
  type ResolveResult,
  type UntrackedLeaseRelease,
} from './types.js';

/** The one in-process record `ProfileService` keeps per live lease, since neither `renew`'s nor `release`'s request shapes carry `profileId`/`tenantId`, and `Store.heartbeatProfileLease` has no `expires_at > now` guard of its own (see this file's `renew` doc). Single embedded process only, matching the `store-sqlite` in-process counter precedent. */
interface LeaseRecord {
  leaseId: string;
  profileId: string;
  tenantId: string;
  nodeId: string;
  instanceId: string;
  fence: number;
  expiresAt: number;
  ttlMs: number;
  grantedAt: number;
  lastRenewAt: number;
}

/** Constructor options for {@link ProfileService}. */
export interface ProfileServiceOptions {
  store: Store;
  fs: ProfileFs;
  clock: Clock;
  config?: Partial<ProfileServiceConfig>;
  /** Fired synchronously the instant `renew()` discovers a stale fence. See `FenceLostHandler`'s TSDoc for the step-ownership split. */
  onFenceLost?: FenceLostHandler;
  /** Fired synchronously on `profile.quarantined`, `profile.zombie_chrome_reaped`, and similar profile webhook events. Best-effort; never awaited. */
  onEvent?: (event: {
    type: string;
    profileId: string;
    tenantId: string;
    detail?: Record<string, unknown>;
  }) => void;
}

function isUniqueConstraintError(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    typeof (err as { code: unknown }).code === 'string' &&
    (err as { code: string }).code.startsWith('SQLITE_CONSTRAINT')
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * The canonical, deterministic profile directory path, relative to the
 * `ProfileFs` root:
 * `tenants/<tenantId>/profiles/<profileId>/udd`. `Store.updateProfile` has
 * no way to change `profiles.storage_path` after `createProfile`
 * (`../../store-sqlite` only lets `state`/`sizeBytes`/`lastUsedAt`/
 * `expiresAt`/`homeNodeId` change), so this value is written once, at
 * creation, and every later `ProfileFs` call must derive the identical
 * path from `(tenantId, profileId)` alone; a real `ProfileFs` (runtime-host)
 * has no destination parameter on `materialise()` either, so this suffix is
 * the only path a correct implementation can produce for a given profile.
 * `createProfileRow` joins it against `this.fs`'s own root before
 * persisting it, since every reader of the persisted `storagePath`
 * (`LocalNode.launch()`, ultimately Chrome's own `--user-data-dir`) needs
 * an absolute path, never this relative suffix alone.
 */
function storagePathFor(tenantId: string, profileId: string): string {
  return `tenants/${tenantId}/profiles/${profileId}/udd`;
}

export class ProfileService {
  private readonly store: Store;
  private readonly fs: ProfileFs;
  private readonly clock: Clock;
  private readonly config: ProfileServiceConfig;
  private readonly onFenceLost: FenceLostHandler | undefined;
  private readonly onEvent: ProfileServiceOptions['onEvent'];

  /** `leaseId` -> tracked lease state. See {@link LeaseRecord}. */
  private readonly leases = new Map<string, LeaseRecord>();
  /** `profileId` -> operator hold. In-process only: `protocol`'s `Profile` type has no `holdUntil` field yet. */
  private readonly holds = new Map<string, { until: number; reason: string }>();
  /** `profileId` -> richer quarantine detail than the store's derived `{reason:'quarantined'}`. */
  private readonly quarantineDetail = new Map<
    string,
    { reason: string; byNodeId: string | null }
  >();
  /** `profileId:granteeAppId` -> level. In-process only: `Store` has no `profile_share_grants` query yet. */
  private readonly shareGrants = new Map<string, 'read' | 'write'>();
  /** Memoised `this.fs.capabilities().root`, resolved lazily on first use. `ProfileFs` root never changes for the lifetime of one `ProfileService`. */
  private fsRootPromise: Promise<string> | null = null;
  /** The periodic lease renewal loop. Runs only while at least one lease is tracked; see {@link startLeaseRenewal}. */
  private leaseRenewTimer: ClockTimer | null = null;

  constructor(opts: ProfileServiceOptions) {
    this.store = opts.store;
    this.fs = opts.fs;
    this.clock = opts.clock;
    this.config = {
      ...DEFAULT_PROFILE_SERVICE_CONFIG,
      ...opts.config,
      trashRetentionMsByKind: {
        ...DEFAULT_PROFILE_SERVICE_CONFIG.trashRetentionMsByKind,
        ...opts.config?.trashRetentionMsByKind,
      },
    };
    this.onFenceLost = opts.onFenceLost;
    this.onEvent = opts.onEvent;
  }

  // ── resolve ─────────────────────────────────────────────────────────

  /**
   * Turns a `ProfileSpec` into a decision without taking a lease.
   * `dryRun` defaults to `true`, so calling this speculatively (the
   * router does, during placement) never mutates anything. The algorithm,
   * condensed: ephemeral and template specs never look
   * anything up (every acquire creates a fresh directory), persistent
   * specs resolve by `(tenantId, appId, key)`.
   */
  async resolve(req: ResolveRequest): Promise<ResolveResult> {
    const dryRun = req.dryRun ?? true;
    let built: { resolved: ResolvedProfileSpec; rawKey: string };
    try {
      built = this.buildResolvedSpec(req.tenantId, req.appId, req.spec, req.instanceId);
    } catch (err) {
      if (err instanceof ProfileServiceError) {
        return { kind: 'error', code: err.code as ProfileErrorCode, detail: err.context ?? {} };
      }
      throw err;
    }
    const { resolved, rawKey } = built;

    if (resolved.mode !== 'persistent') {
      return {
        kind: 'lease',
        profileId: null,
        eligibleNodeIds: null,
        resolved,
        estimatedMaterialiseMs: resolved.templateId ? 800 : 300,
        created: false,
      };
    }

    const existing = await this.store.getProfileByKey(req.tenantId, req.appId, rawKey);
    if (!existing) {
      if (dryRun) {
        return {
          kind: 'lease',
          profileId: null,
          eligibleNodeIds: null,
          resolved,
          estimatedMaterialiseMs: resolved.templateId ? 800 : 300,
          created: false,
        };
      }
      const created = await this.createProfileRow(req.tenantId, req.appId, rawKey, resolved);
      return {
        kind: 'lease',
        profileId: created.id,
        eligibleNodeIds: created.homeNodeId ? [created.homeNodeId] : null,
        resolved: { ...resolved, profileId: created.id },
        estimatedMaterialiseMs: resolved.templateId ? 800 : 300,
        created: true,
      };
    }

    switch (existing.state) {
      case 'free':
        return {
          kind: 'lease',
          profileId: existing.id,
          eligibleNodeIds: existing.homeNodeId ? [existing.homeNodeId] : null,
          resolved: { ...resolved, profileId: existing.id },
          estimatedMaterialiseMs: 0,
          created: false,
        };
      case 'leased': {
        const lease = existing.lease;
        if (!lease)
          return {
            kind: 'lease',
            profileId: existing.id,
            eligibleNodeIds: existing.homeNodeId ? [existing.homeNodeId] : null,
            resolved: { ...resolved, profileId: existing.id },
            estimatedMaterialiseMs: 0,
            created: false,
          };
        const now = this.clock.now();
        if (now >= lease.expiresAt + this.config.profileLeaseStealGraceMs) {
          return {
            kind: 'lease',
            profileId: existing.id,
            eligibleNodeIds: existing.homeNodeId ? [existing.homeNodeId] : null,
            resolved: { ...resolved, profileId: existing.id },
            estimatedMaterialiseMs: 0,
            created: false,
          };
        }
        if (lease.holderInstanceId) {
          const holder = await this.store.getInstance(req.tenantId, lease.holderInstanceId);
          if (
            holder &&
            (holder.appId === req.appId ||
              (await this.hasShareGrant(existing.id, req.appId, 'read')))
          ) {
            return {
              kind: 'reuse',
              instanceId: lease.holderInstanceId,
              profileId: existing.id,
              nodeId: lease.holderNodeId,
            };
          }
          return {
            kind: 'error',
            code: 'E_PROFILE_BUSY',
            detail: { holderAppId: holder?.appId ?? null, expiresAt: lease.expiresAt },
          };
        }
        return { kind: 'error', code: 'E_PROFILE_BUSY', detail: { expiresAt: lease.expiresAt } };
      }
      case 'quarantined':
        return {
          kind: 'error',
          code: 'E_PROFILE_QUARANTINED',
          detail: {
            reason:
              this.quarantineDetail.get(existing.id)?.reason ??
              existing.quarantine?.reason ??
              'quarantined',
          },
        };
      case 'snapshotting':
      case 'migrating':
        return { kind: 'error', code: 'E_PROFILE_BUSY', detail: { retryAfterMs: 5000 } };
      case 'creating':
        return { kind: 'error', code: 'E_PROFILE_BUSY', detail: { retryAfterMs: 1000 } };
      case 'deleting':
      case 'deleted':
        if (dryRun)
          return {
            kind: 'lease',
            profileId: null,
            eligibleNodeIds: null,
            resolved,
            estimatedMaterialiseMs: resolved.templateId ? 800 : 300,
            created: false,
          };
        return { kind: 'error', code: 'E_PROFILE_NOT_FOUND', detail: { key: rawKey } };
      default:
        return { kind: 'error', code: 'E_PROFILE_NOT_FOUND', detail: { key: rawKey } };
    }
  }

  /**
   * `acquire`'s core reachable from an already resolved spec, for the
   * `ProfileServicePort` adapter's `lease()`, which `BrowserRouter` calls
   * after its own `resolve()` call already produced a `ResolvedProfileSpec`.
   *
   * `ProfileServicePortAdapter.resolve()` is called by `BrowserRouter.doAcquire()`
   * before the real `instanceId` for this acquire exists yet (it is minted
   * only afterward, in the admission step), so it passes a placeholder
   * instead; for an ephemeral (or non-promoted template) profile,
   * `buildResolvedSpec` derives `resolved.key` from that placeholder via
   * `ephemeralCallerKey()`, not from a real instance. Every such acquire
   * would then try to persist the exact same `(tenantId, appId, key)`,
   * colliding with `profiles`' own UNIQUE constraint on a second acquire
   * whose first, same-keyed row has not been hard deleted (found directly:
   * a real `store-sqlite`, two sequential ephemeral acquires, the second
   * fails `SQLITE_CONSTRAINT_UNIQUE`). This recomputes that key from the
   * real `req.instanceId`, now known, for exactly the two modes whose key
   * is instance derived; a persistent profile's key (and a promoted
   * template's) is the caller's own choice, independent of `instanceId`,
   * and is left untouched.
   */
  async leaseResolved(req: {
    tenantId: string;
    appId: string;
    resolved: ResolvedProfileSpec;
    instanceId: string;
    nodeId: string;
    holderPid?: number;
    ttlMs: number;
  }): Promise<ProfileAcquireResult> {
    const leaseTtlMs = clamp(req.ttlMs, 10_000, 300_000);
    const resolved: ResolvedProfileSpec =
      req.resolved.mode !== 'persistent' && req.resolved.destroyOnRelease
        ? { ...req.resolved, key: ephemeralCallerKey(req.instanceId) }
        : req.resolved;
    const acquireReq: ProfileAcquireRequest = {
      tenantId: req.tenantId,
      appId: req.appId,
      spec: this.specFromResolved(resolved),
      instanceId: req.instanceId,
      nodeId: req.nodeId,
      leaseTtlMs,
      ...(req.holderPid !== undefined ? { holderPid: req.holderPid } : {}),
    };
    return this.acquireResolved(acquireReq, resolved, resolved.key, leaseTtlMs, true);
  }

  /** Reconstructs a `ProfileSpec` from a `ResolvedProfileSpec`, only ever used internally by `leaseResolved` to satisfy `ProfileAcquireRequest.spec`'s type; every field `acquireResolved` actually reads comes from the `resolved`/`rawKey` parameters, not from this reconstruction. */
  private specFromResolved(resolved: ResolvedProfileSpec): ProfileSpec {
    if (resolved.mode === 'ephemeral')
      return { mode: 'ephemeral', ...(resolved.seed ? { seed: resolved.seed } : {}) };
    if (resolved.mode === 'template')
      return { mode: 'template', templateId: resolved.templateId ?? '' };
    return {
      mode: 'persistent',
      key: resolved.key,
      createIfMissing: true,
      ttlMs: resolved.ttlMs,
      snapshotOnRelease: resolved.snapshotOnRelease,
      ...(resolved.templateId ? { templateId: resolved.templateId } : {}),
    };
  }

  // ── acquire ─────────────────────────────────────────────────────────

  /**
   * Resolve, materialise if needed, take the lease. Eight steps: (1)
   * validate the spec and compute the resolved key; (2) find-or-create the
   * profile row (persistent only; ephemeral/template always create
   * fresh); (3) attempt the atomic fenced lease via `Store.
   * acquireProfileLease`, whose partial-unique-index INSERT *is* the
   * leasability guard folded into one statement, never a
   * SELECT then INSERT; (4) on contention, decide busy versus steal
   * eligible; (5) on steal, probe for corruption and clear the
   * singleton before retrying; (6) materialise the directory (empty,
   * template clone, or none when reusing an already-materialised
   * persistent profile); (7) write `.bgls-fence` with fsync and read back
   * to confirm, before the caller may launch Chrome; (8) flip the profile
   * to `leased` and return.
   */
  async acquire(req: ProfileAcquireRequest): Promise<ProfileAcquireResult> {
    const leaseTtlMs = clamp(req.leaseTtlMs ?? this.config.profileLeaseTtlMs, 10_000, 300_000);
    const { resolved, rawKey } = this.buildResolvedSpec(
      req.tenantId,
      req.appId,
      req.spec,
      req.instanceId,
    );
    const createIfMissing =
      resolved.mode === 'persistent'
        ? ((req.spec as Extract<ProfileSpec, { mode: 'persistent' }>).createIfMissing ?? true)
        : true;
    return this.acquireResolved(req, resolved, rawKey, leaseTtlMs, createIfMissing);
  }

  /**
   * `acquire`'s core, taking an already computed `resolved`/`rawKey`
   * pair so the `ProfileServicePort` adapter's `lease()` (called by
   * `BrowserRouter` after its own `resolve()` call already produced a
   * `ResolvedProfileSpec`) can drive the same fencing and steal logic
   * without recomputing it.
   */
  private async acquireResolved(
    req: ProfileAcquireRequest,
    resolved: ResolvedProfileSpec,
    rawKey: string,
    leaseTtlMs: number,
    createIfMissing: boolean,
  ): Promise<ProfileAcquireResult> {
    if (resolved.mode === 'persistent') {
      return this.acquirePersistent(req, resolved, rawKey, leaseTtlMs, createIfMissing);
    }
    return this.acquireFresh(req, resolved, rawKey, leaseTtlMs);
  }

  /** Ephemeral and template modes: always a brand new profile row and directory, never a lookup. */
  private async acquireFresh(
    req: ProfileAcquireRequest,
    resolved: ResolvedProfileSpec,
    rawKey: string,
    leaseTtlMs: number,
  ): Promise<ProfileAcquireResult> {
    const created = await this.createProfileRow(req.tenantId, req.appId, rawKey, resolved);
    const opId = crypto.randomUUID();
    const materialised = await this.fs.materialise({
      profileId: created.id,
      tenantId: req.tenantId,
      opId,
      from: resolved.templateId
        ? {
            kind: 'template',
            templateDir: await this.templateDirFor(req.tenantId, resolved.templateId),
          }
        : { kind: 'empty' },
      allowSlowCopy: req.allowSlowCopy ?? false,
    });

    const lease = await this.acquireLease(
      req.tenantId,
      created.id,
      req.nodeId,
      req.instanceId,
      req.holderPid,
      leaseTtlMs,
    );
    if (!lease) {
      // A brand new profile row can never already have a live lease; a
      // null here means another process raced the same fresh id, which
      // cannot happen with a freshly minted `newId('prf')`. Defensive only.
      throw profileErr(
        'E_PROFILE_BUSY',
        `unexpected contention acquiring a freshly created profile ${created.id}`,
        { details: { profileId: created.id } },
      );
    }

    await this.writeFenceOrAbort(materialised.path, lease);
    await this.store.setProfileState(req.tenantId, created.id, 'leased');
    this.trackLease(lease, req, leaseTtlMs);

    return {
      kind: 'leased',
      profileId: created.id,
      leaseId: lease.id,
      fence: lease.fence,
      path: materialised.path,
      expiresAt: lease.expiresAt,
      renewIntervalMs: this.config.profileLeaseRenewIntervalMs,
      resolved: { ...resolved, profileId: created.id },
      materialisation: materialised.materialisation,
      materialiseMs: materialised.materialiseMs,
      probe: null,
    };
  }

  /** Persistent mode: find-or-create (racing any concurrent create), then lease, with one steal attempt on contention past grace. */
  private async acquirePersistent(
    req: ProfileAcquireRequest,
    resolved: ResolvedProfileSpec,
    rawKey: string,
    leaseTtlMs: number,
    createIfMissing: boolean,
  ): Promise<ProfileAcquireResult> {
    const startedAt = this.clock.now();
    const deadlineMs = req.deadlineMs ?? this.config.acquireDeadlineMsDefault;

    let profile = await this.store.getProfileByKey(req.tenantId, req.appId, rawKey);
    let justCreatedFresh = false;

    if (!profile) {
      if (!createIfMissing)
        throw profileErr(
          'E_PROFILE_NOT_FOUND',
          `profile "${rawKey}" not found and createIfMissing is false`,
          { details: { key: rawKey } },
        );
      try {
        const row = await this.createProfileRow(req.tenantId, req.appId, rawKey, resolved);
        justCreatedFresh = true;
        profile = row;
      } catch (err) {
        if (!isUniqueConstraintError(err)) throw err;
        const pollDeadline = startedAt + Math.min(deadlineMs, this.config.profileCreateTimeoutMs);
        profile = await this.pollForProfile(req.tenantId, req.appId, rawKey, pollDeadline);
        if (!profile)
          throw profileErr(
            'E_PROFILE_CREATE_TIMEOUT',
            `timed out waiting for a concurrent create of "${rawKey}"`,
            { details: { key: rawKey } },
          );
      }
    }

    let materialised: {
      path: string;
      materialisation: ProfileMaterialisation;
      materialiseMs: number;
    } | null = null;
    // Materialise when the directory this row NAMES does not exist yet,
    // which is two cases and used to be one.
    //
    // `justCreatedFresh` is the case where this function created the row
    // itself. The case it missed is a row somebody ELSE created and left
    // in `creating`, and there is exactly one thing that does that:
    // `resolve({ dryRun: false })`, which `BrowserRouter.doAcquire` calls
    // with `false` written as a literal on every acquire. `resolve`
    // INSERTs the row (`Store.createProfile` hard codes
    // `state = 'creating'`) and materialises nothing. So by the time
    // placement reaches this function the row exists, `justCreatedFresh`
    // is false PRECISELY BECAUSE resolve already created it, no directory
    // is made, `path` falls back to `absolutePathOf(profile)`, and
    // `writeFenceOrAbort` opens `<udd>/.bgls-fence` inside a directory
    // that was never created and throws ENOENT.
    //
    // That fired on the FIRST acquire of every persistent key, on every
    // platform, and it surfaced to the caller as `E_LAUNCH_FAILED: every
    // placement candidate failed`, which names nothing. The demo never met
    // it because the demo's instances are ephemeral and `acquireFresh`
    // materialises unconditionally, which is how it shipped. Every
    // persistent profile in this build was unusable, and one browser per
    // persistent worker key is the main path for long running automation,
    // not an edge case.
    //
    // Keying on the STATE rather than on who created the row is also what
    // makes this the repair for an ALREADY poisoned key. The old failure
    // left the row in `creating` for ever, so every later acquire took
    // `resolve`'s `case 'creating'` and answered `E_PROFILE_BUSY` with no
    // way out; such a row now heals on its next acquire rather than
    // needing a hand written UPDATE.
    const needsMaterialise = justCreatedFresh || profile.state === 'creating';
    if (needsMaterialise) {
      // Nothing is reclaimed before this call, deliberately, and the
      // reason is `materialise`'s own atomicity. It assembles the whole
      // profile under `tmp/<opId>/` and lands it with ONE `renameSync`
      // onto a destination that does not yet exist, precisely so that a
      // failure never leaves a half built directory behind. So a row in
      // `creating` cannot have a PARTIAL destination: either the rename
      // never happened and there is no directory at all, which is every
      // occurrence of the defect described above, or the rename landed and
      // the directory is complete.
      //
      // The second case is reachable only through one narrow window, a
      // crash between that rename and the `setProfileState('free')` two
      // lines below. It surfaces here as a rename failure naming the
      // destination, which is an honest and rare error a sweeper or an
      // operator can act on. An unconditional reclaim would turn that rare
      // honest failure into a routine blind delete of a directory this
      // code cannot prove is disposable, on the acquire path, which is a
      // much worse trade than the one it would be buying.
      const opId = crypto.randomUUID();
      const fsResult = await this.fs.materialise({
        profileId: profile.id,
        tenantId: req.tenantId,
        opId,
        from: resolved.templateId
          ? {
              kind: 'template',
              templateDir: await this.templateDirFor(req.tenantId, resolved.templateId),
            }
          : { kind: 'empty' },
        allowSlowCopy: req.allowSlowCopy ?? false,
      });
      await this.store.setProfileState(req.tenantId, profile.id, 'free');
      materialised = fsResult;
    }

    let attempt = 0;
    const maxStealAttempts = 1;
    for (;;) {
      if (profile.state === 'quarantined')
        throw profileErr('E_PROFILE_QUARANTINED', `profile ${profile.id} is quarantined`, {
          details: { reason: this.quarantineDetail.get(profile.id)?.reason ?? 'quarantined' },
        });

      const lease = await this.acquireLease(
        req.tenantId,
        profile.id,
        req.nodeId,
        req.instanceId,
        req.holderPid,
        leaseTtlMs,
      );
      if (lease) {
        const path = materialised?.path ?? this.absolutePathOf(profile);
        // Tracked BEFORE the fence write, not after it, and this ordering
        // is the whole of the fix for a lease nobody could release.
        //
        // `acquireLease` has already INSERTed the row by the time we get
        // here. `trackLease` is the only thing that populates the
        // in-memory `instanceId -> leaseId` map, and that map is the only
        // way `ProfileServicePortAdapter.releaseLeaseQuietly` can find a
        // lease to release, because the placement loop's `catch` calls it
        // with an instance id and nothing else. So every throw between the
        // INSERT and the old `trackLease` call left a row with
        // `released_at` null that NOTHING could ever release: the release
        // path looked in the map, missed, and returned quietly.
        //
        // That was not hypothetical. The ENOENT above is thrown by exactly
        // that window, so the first acquire of every persistent key both
        // failed AND stranded a lease, and the stranded lease then refused
        // every retry with `E_PROFILE_BUSY` held by an instance whose own
        // row said `failed`.
        //
        // Tracking first is safe in the other direction: a tracked lease
        // that never became a grant is released by the same `catch`, and
        // `release()` on a lease already released is a no-op.
        this.trackLease(lease, req, leaseTtlMs);
        try {
          await this.writeFenceOrAbort(path, lease);
        } catch (err) {
          // The fence write is the one step that can fail with the
          // directory half ready. `writeFenceOrAbort` already releases the
          // lease on a read-back MISMATCH, but a throw out of
          // `fs.writeFence` itself (ENOENT, EACCES, a full disk) reached
          // nobody, so the release is done here for every failure and the
          // tracked record is dropped with it. `releaseProfileLease` is
          // idempotent (`WHERE released_at IS NULL`), so the mismatch path
          // releasing twice costs nothing.
          this.leases.delete(lease.id);
          await this.store.releaseProfileLease(lease.id, 'crash');
          throw err;
        }
        await this.store.setProfileState(req.tenantId, profile.id, 'leased');
        return {
          kind: 'leased',
          profileId: profile.id,
          leaseId: lease.id,
          fence: lease.fence,
          path,
          expiresAt: lease.expiresAt,
          renewIntervalMs: this.config.profileLeaseRenewIntervalMs,
          resolved: { ...resolved, profileId: profile.id },
          materialisation: materialised?.materialisation ?? 'existing',
          materialiseMs: materialised?.materialiseMs ?? 0,
          probe: null,
        };
      }

      // Busy. Refresh to see the live holder and decide busy versus steal.
      const current = await this.store.getProfile(req.tenantId, profile.id);
      if (!current)
        throw profileErr('E_PROFILE_NOT_FOUND', `profile ${profile.id} disappeared`, {
          details: { profileId: profile.id },
        });
      const liveLease = current.lease;
      if (!liveLease) {
        // Race: the other holder released between our INSERT attempt and
        // this read. Retry the atomic acquire immediately.
        profile = current;
        continue;
      }
      const now = this.clock.now();
      const stealAt = liveLease.expiresAt + this.config.profileLeaseStealGraceMs;
      if (now < stealAt || attempt >= maxStealAttempts) {
        throw profileErr(
          'E_PROFILE_BUSY',
          `profile ${profile.id} is leased by instance ${liveLease.holderInstanceId ?? 'unknown'}`,
          {
            details: {
              holderInstanceId: liveLease.holderInstanceId,
              expiresAt: liveLease.expiresAt,
            },
            retryAfterMs: Math.max(0, stealAt - now),
          },
        );
      }

      // Steal after expiry.
      attempt += 1;
      const path = this.absolutePathOf(current);
      const probe = await this.fs.probe(path);
      if (!probe.ok) {
        await this.quarantine(req.tenantId, profile.id, 'corruption_probe_failed', null);
        throw profileErr(
          'E_PROFILE_QUARANTINED',
          `profile ${profile.id} failed the corruption probe during steal`,
          { details: { probe } },
        );
      }
      const cleared = await this.fs.clearSingleton(path);
      if (cleared.refusedLivePid !== null) {
        throw profileErr(
          'E_PROFILE_UNREACHABLE',
          `profile ${profile.id}'s singleton lock names a live foreign pid ${cleared.refusedLivePid}`,
          { details: { pid: cleared.refusedLivePid } },
        );
      }
      await this.store.releaseProfileLease(liveLease.id, 'stolen');
      this.leases.delete(liveLease.id);
      profile = current;
      // loop retries the atomic acquire
    }
  }

  // ── renew ───────────────────────────────────────────────────────────

  /**
   * Extend a held lease. Fails if the fence no longer matches. The stale
   * fence protocol has seven steps; steps 1 through 3 (stop
   * driving synchronously, stop streaming, SIGKILL the tracked Chrome
   * processes) need the CDP session and process handles this package does
   * not have, so `ProfileService` owns only steps 4 through 7: it never
   * touches the profile directory on this path (no `ProfileFs` call
   * anywhere below), it reports via `onFenceLost` (step 5, invoked
   * synchronously, never awaited), and it never retries the lease itself
   * (step 7). A caller that does own the CDP session (the not yet built
   * Instance/Session layer) subscribes to `onFenceLost` to run steps 1
   * through 3 itself, within the same `fenceLostReactionBudgetMs` budget.
   *
   * Compensates for `Store.heartbeatProfileLease` having no
   * `expires_at > now` guard of its own (the reference SQL has one;
   * `store-sqlite`'s implementation omits it):
   * this method checks the tracked `expiresAt` itself before ever calling
   * the store, so an already-expired lease is treated as stale without a
   * false renewal.
   */
  async renew(req: ProfileRenewRequest): Promise<ProfileRenewResult> {
    const record = this.leases.get(req.leaseId);
    if (!record) return { ok: false, reason: 'gone' };

    if (record.fence !== req.fence) {
      this.reportFenceLost(record, 'stale', null);
      return { ok: false, reason: 'stale' };
    }

    const now = this.clock.now();
    if (now >= record.expiresAt) {
      this.leases.delete(req.leaseId);
      this.reportFenceLost(record, 'stale', null);
      return { ok: false, reason: 'stale' };
    }

    const ttlMs = req.ttlMs ?? record.ttlMs;
    const ok = await this.store.heartbeatProfileLease(req.leaseId, ttlMs);
    if (!ok) {
      this.leases.delete(req.leaseId);
      const reason: RenewFailureReason = 'released';
      this.reportFenceLost(record, reason, null);
      return { ok: false, reason };
    }

    record.expiresAt = now + ttlMs;
    record.ttlMs = ttlMs;
    record.lastRenewAt = now;
    return { ok: true, expiresAt: record.expiresAt };
  }

  private reportFenceLost(
    record: LeaseRecord,
    reason: RenewFailureReason,
    observedFence: number | null,
  ): void {
    const report: FenceLostReport = {
      profileId: record.profileId,
      leaseId: record.leaseId,
      myFence: record.fence,
      observedFence,
      instanceId: record.instanceId,
      nodeId: record.nodeId,
      reason,
      elapsedSinceRenewMs: this.clock.now() - record.lastRenewAt,
    };
    this.onEvent?.({
      type: 'profile.fence_lost',
      profileId: record.profileId,
      tenantId: record.tenantId,
      detail: { leaseId: record.leaseId, reason },
    });
    this.onFenceLost?.(report);
  }

  // ── release ─────────────────────────────────────────────────────────

  /**
   * Release a lease, in a fixed order for the two steps this package
   * owns: the trash rename (step 5) strictly before the store update
   * (step 6). If the process dies between them, the sweeper finds an
   * orphaned trash directory next pass (harmless); the reverse order
   * would leave a live directory the store believes is already gone (a
   * leak). Steps 1 through 3 (stop streams, close the browser, wait for
   * exit and the singleton lock to clear) are the caller's responsibility,
   * same split as `renew`'s stale-fence protocol. Idempotent: releasing
   * an already released or untracked lease succeeds.
   */
  async release(req: ProfileReleaseRequest): Promise<ProfileReleaseResult> {
    const record = this.leases.get(req.leaseId);
    if (!record) {
      // Not in `this.leases`. That map is this process's bookkeeping, not
      // the system of record, so a miss says nothing about whether the
      // store row is still open. This branch used to return "treated as
      // already released" and touch nothing, which was simply false for
      // the commonest miss of all: a lease granted before a restart. The
      // row stays open forever, and because `Store.getProfile` resolves a
      // profile's single unreleased lease, the next acquire on the same
      // persistent key fails `E_PROFILE_BUSY` against a holder that no
      // longer exists. Measured on the demo deployment: 48 of 50 rows
      // stranded that way, 47 profiles still reading `leased`.
      //
      // With `req.identity` the store can answer the question properly.
      // Without it there is nothing to ask: `Store` has no lookup by lease
      // id, so a bare `leaseId` cannot be checked against anything, and
      // releasing it blind is the one move here that could hand a live
      // browser's directory to a second one. That case still declines, and
      // now says so.
      const untracked = req.identity
        ? await this.releaseUntrackedLease({ ...req.identity, reason: req.reason })
        : null;
      return {
        releasedAt: this.clock.now(),
        snapshotId: null,
        destroyed: false,
        promotedToKey: null,
        finalSizeBytes: null,
        warnings: [
          untracked === null
            ? 'lease not tracked locally and no profile identity supplied; the store row was left untouched because a lease id alone cannot be checked against anything'
            : `lease not tracked locally; store side resolved as ${untracked.outcome}`,
        ],
      };
    }

    const warnings: string[] = [];
    const profile = await this.store.getProfile(record.tenantId, record.profileId);
    let destroyed = false;
    let finalSizeBytes: number | null = null;

    if (profile) {
      const isEphemeral = profile.mode === 'ephemeral';
      if (isEphemeral && req.keep)
        warnings.push('keep is ignored for ephemeral profiles; destroyed as usual');
      const shouldDestroy = isEphemeral;
      if (shouldDestroy && profile.path) {
        await this.fs.trash(profile.path, 'ephemeral');
        destroyed = true;
        try {
          const measured = await this.fs.measure(profile.path).catch(() => null);
          finalSizeBytes = measured?.sizeBytes ?? null;
        } catch {
          // measurement is best-effort after trash; ignore
        }
      }
    }

    // Step 6: the store update. Deliberately after the trash rename above.
    await this.store.releaseProfileLease(req.leaseId, req.reason);
    if (profile) {
      await this.store.setProfileState(
        record.tenantId,
        record.profileId,
        destroyed ? 'deleting' : 'free',
      );
    }
    this.leases.delete(req.leaseId);

    return {
      releasedAt: this.clock.now(),
      snapshotId: null,
      destroyed,
      promotedToKey: null,
      finalSizeBytes,
      warnings,
    };
  }

  /**
   * Releases the store side of a lease this process cannot vouch for from
   * memory, given the profile it is on.
   *
   * The in memory `leases` map is populated only by leases this process
   * itself granted, so it empties on every restart. Every code path that
   * resolved a lease through it (`release()`'s own lookup,
   * `leaseIdForInstance`, and therefore `releaseLeaseQuietly`) silently did
   * nothing for a lease from a previous incarnation, which is why the demo
   * database ended up with 48 open `profile_leases` rows against 2 closed
   * ones. `packages/server`'s startup reconcile already had to work around
   * exactly this by going to the store directly (see
   * `releaseOrphanedProfileLease` in `lifecycle/wiring.ts`, whose comment
   * describes the same defect); that workaround covers only instances that
   * are still in a live status at process start, so an instance released
   * normally after a restart fell through every net.
   *
   * The four situations a miss can mean are genuinely different and each
   * gets its own answer rather than being collapsed:
   *
   * - Nothing open. No profile row, no lease, or a lease already released.
   *   Nothing to do, and in particular the original `released_at` and
   *   reason are not overwritten.
   * - Held by a different instance. Another instance has since taken the
   *   lease on this profile. Left alone: releasing it would let a third
   *   party materialise onto a directory a live browser is writing to,
   *   which is the corruption the lease exists to prevent. This is the
   *   same `holderInstanceId` gate `packages/server`'s workaround uses.
   * - Not expired, and the caller cannot confirm the browser is gone.
   *   Something may still be renewing it, so it is left alone. This is the
   *   genuinely unsafe case, and it is the one this method refuses.
   * - Open, held by this instance, and either expired or confirmed dead.
   *   Released. This is the leak.
   *
   * `browserConfirmedGone` matters because the TTL is a weaker signal than
   * a caller who has just killed the process. `BrowserRouter.release()`
   * only reaches its lease release after `terminateGraceThenForce`
   * confirmed the browser is gone (it throws rather than continuing when
   * it cannot), so an unexpired lease there is stale by construction:
   * nothing is renewing it, because the thing it was renewed for is dead.
   * Without that confirmation the TTL is all there is, and the safe
   * direction is to decline. Declining is permanent, not a retry, since
   * nothing revisits a released instance, so the caller is told which case
   * it hit rather than being left to assume success.
   *
   * The profile state is only moved to `'free'` from a state that has not
   * already moved past it. `BrowserRouter.release()` step 6 runs
   * `applyReleaseAction` first, which for a destroy already trashed the
   * directory and set `'deleting'`; overwriting that with `'free'` would
   * advertise a profile whose bytes are gone as available for reuse. Same
   * care in the other direction as `packages/server`'s workaround, which
   * uses `'free'` rather than `'deleting'` precisely because it never
   * confirmed a delete.
   */
  async releaseUntrackedLease(req: {
    tenantId: string;
    profileId: string;
    instanceId: string;
    reason: 'normal' | 'drain' | 'crash' | 'admin';
    browserConfirmedGone?: boolean;
  }): Promise<UntrackedLeaseRelease> {
    const profile = await this.store.getProfile(req.tenantId, req.profileId);
    const lease = profile?.lease ?? null;
    if (!profile || lease === null || lease.releasedAt !== null)
      return { outcome: 'no-open-lease' };

    if (lease.holderInstanceId !== null && lease.holderInstanceId !== req.instanceId) {
      return {
        outcome: 'held-by-other-instance',
        leaseId: lease.id,
        holderInstanceId: lease.holderInstanceId,
      };
    }

    if (req.browserConfirmedGone !== true && lease.expiresAt > this.clock.now()) {
      return { outcome: 'live-holder', leaseId: lease.id, expiresAt: lease.expiresAt };
    }

    await this.store.releaseProfileLease(lease.id, req.reason);
    // `'deleting'`, `'deleted'` and `'quarantined'` are all past the point
    // where `'free'` would be true. Every other state means the directory
    // is still there and unheld, which is exactly what `'free'` says.
    const alreadyPastFree =
      profile.state === 'deleting' ||
      profile.state === 'deleted' ||
      profile.state === 'quarantined';
    if (!alreadyPastFree) await this.store.setProfileState(req.tenantId, req.profileId, 'free');
    // Defensive: the lease was not in the map on the way in, but a
    // concurrent grant could have put it there, and a released lease must
    // never stay tracked.
    this.leases.delete(lease.id);
    return { outcome: 'released', leaseId: lease.id, profileStateSetFree: !alreadyPastFree };
  }

  /**
   * Executes `action` (the four value `ProfileAction`) against a
   * released, persistent or template profile: `'keep'` does nothing,
   * `'destroy'` trashes the directory, `'snapshotThenKeep'`/
   * `'snapshotThenDestroy'` throw `E_NOT_IMPLEMENTED` for their snapshot
   * half (`snapshot()` is stubbed). This is the seam
   * `ProfileServicePort.applyReleaseAction` fills.
   */
  async applyReleaseAction(req: {
    instanceId: string;
    profileId: string;
    tenantId: string;
    action: import('@browserglass/protocol').ProfileAction;
  }): Promise<void> {
    if (req.action === 'snapshotThenKeep' || req.action === 'snapshotThenDestroy')
      notImplemented('applyReleaseAction(snapshot*)');
    if (req.action !== 'destroy') return;
    const profile = await this.store.getProfile(req.tenantId, req.profileId);
    if (!profile || !profile.path) return;
    // The trash kind picks the retention window the sweeper will honour
    // (15 minutes for `'ephemeral'`, 7 days for `'deleted'`), so
    // it has to match what the profile actually is rather than what the
    // action is called. This unconditionally said `'deleted'`, which put
    // every disposable ephemeral profile into the 7 day bucket: a browser
    // acquired and released in a minute left its directory sitting in
    // `trash/` for a week. `release()` below already gets this right for
    // the same directory when it reaches its own trash call, so the two
    // paths disagreed about the same profile depending on which one won.
    // A persistent or template profile the caller asked to destroy keeps
    // the longer window, which is the point of that window: it is the
    // only chance to undo an explicit destroy of something durable.
    await this.fs.trash(profile.path, profile.mode === 'ephemeral' ? 'ephemeral' : 'deleted');
    await this.store.setProfileState(req.tenantId, req.profileId, 'deleting');
  }

  /**
   * `applyReleaseAction`, resolving `tenantId` from the tracked lease for
   * `instanceId` instead of taking it as a parameter, for the
   * `ProfileServicePort` adapter, whose `applyReleaseAction` request shape
   * carries no `tenantId`. Must
   * be called before `release()`/`releaseLeaseQuietly` clears the tracked
   * lease; a no-op if it already has been.
   */
  async applyReleaseActionForInstance(
    instanceId: string,
    profileId: string,
    action: import('@browserglass/protocol').ProfileAction,
  ): Promise<void> {
    const tenantId = this.tenantIdForInstance(instanceId);
    if (!tenantId) return;
    await this.applyReleaseAction({ instanceId, profileId, tenantId, action });
  }

  /** The tracked lease id for `instanceId`, if this service granted one and it has not yet been released. At most one per instance in this build. */
  leaseIdForInstance(instanceId: string): string | null {
    for (const record of this.leases.values()) {
      if (record.instanceId === instanceId) return record.leaseId;
    }
    return null;
  }

  /**
   * Renews `instanceId`'s already-held profile lease (a plain TTL heartbeat
   * via `renew()`, same fence, same directory) rather than releasing it and
   * taking a fresh one, for `BrowserRouter.restart()`'s `preserveProfile:
   * true` path: a browser relaunch onto the same profile
   * should never need to contend for a new lease on a directory it already,
   * uninterruptedly, holds. Returns the same shape `leaseResolved()` does,
   * for `LocalNode.launch()`'s `NodeLaunchRequest.profile`; `source` is
   * always `'restore'` since the directory is already materialised, never
   * freshly created. Throws `E_PROFILE_NOT_FOUND` if this instance holds no
   * tracked lease (already expired or released elsewhere), `E_PROFILE_BUSY`
   * if the renew itself fails (stale fence, or the store lease row is
   * gone).
   */
  async renewForInstance(
    instanceId: string,
    ttlMs: number,
  ): Promise<{
    profileId: string;
    storedKey: string;
    fence: number;
    source: 'restore';
    expiresAt: number;
  }> {
    const leaseId = this.leaseIdForInstance(instanceId);
    if (!leaseId) {
      throw profileErr(
        'E_PROFILE_NOT_FOUND',
        `no tracked profile lease for instance ${instanceId}`,
        { details: { instanceId } },
      );
    }
    const record = this.leases.get(leaseId);
    if (!record) {
      throw profileErr(
        'E_PROFILE_NOT_FOUND',
        `lease ${leaseId} vanished between lookup and renew`,
        { details: { leaseId } },
      );
    }
    const renewed = await this.renew({ leaseId, fence: record.fence, ttlMs });
    if (!renewed.ok) {
      throw profileErr(
        'E_PROFILE_BUSY',
        `profile lease renew failed for instance ${instanceId}: ${renewed.reason}`,
        { details: { reason: renewed.reason } },
      );
    }
    const profile = await this.store.getProfile(record.tenantId, record.profileId);
    if (!profile) {
      throw profileErr('E_PROFILE_NOT_FOUND', `profile ${record.profileId} not found`, {
        details: { profileId: record.profileId },
      });
    }
    return {
      profileId: profile.id,
      storedKey: storedKeyFor(profile.tenantId, profile.appId, profile.key),
      fence: record.fence,
      source: 'restore',
      expiresAt: renewed.expiresAt,
    };
  }

  private tenantIdForInstance(instanceId: string): string | null {
    for (const record of this.leases.values()) {
      if (record.instanceId === instanceId) return record.tenantId;
    }
    return null;
  }

  // ── list / get / delete / hold ─────────────────────────────────────

  /** Enumerates profiles. Client side re-sort per `sort`/`order`, since `Store.listProfiles` only orders by `createdAt`. */
  async list(req: ProfileListRequest): Promise<readonly Profile[]> {
    const rows = await this.store.listProfiles(req.tenantId, {
      ...(req.appId !== undefined ? { appId: req.appId as AppId } : {}),
      ...(req.state !== undefined ? { state: req.state } : {}),
      ...(req.nodeId !== undefined ? { homeNodeId: req.nodeId as NodeId } : {}),
      ...(req.keyPrefix !== undefined ? { keyPrefix: req.keyPrefix } : {}),
      ...(req.limit !== undefined ? { limit: req.limit } : {}),
    });
    let list = req.mode ? rows.filter((p) => req.mode?.includes(p.mode)) : rows.slice();
    if (req.sort) {
      const dir = req.order === 'desc' ? -1 : 1;
      list = list.sort((a, b) => {
        const av =
          req.sort === 'key'
            ? a.key
            : req.sort === 'sizeBytes'
              ? a.sizeBytes
              : req.sort === 'createdAt'
                ? a.createdAt
                : a.lastUsedAt;
        const bv =
          req.sort === 'key'
            ? b.key
            : req.sort === 'sizeBytes'
              ? b.sizeBytes
              : req.sort === 'createdAt'
                ? b.createdAt
                : b.lastUsedAt;
        if (av === bv) return 0;
        return av < bv ? -dir : dir;
      });
    }
    return list;
  }

  /** Fetches one profile. Throws `E_PROFILE_NOT_FOUND`. */
  async get(tenantId: string, profileId: string): Promise<Profile> {
    const profile = await this.store.getProfile(tenantId, profileId);
    if (!profile)
      throw profileErr('E_PROFILE_NOT_FOUND', `profile ${profileId} not found`, {
        details: { profileId },
      });
    return profile;
  }

  /** Deletes. Refuses while leased unless `force`. Renames to trash and returns immediately; bytes go later (the sweeper unlinks). */
  async delete(req: ProfileDeleteRequest): Promise<ProfileDeleteResult> {
    const profile = await this.get(req.tenantId, req.profileId);
    if (profile.lease) {
      if (!req.force)
        throw profileErr(
          'E_PROFILE_BUSY',
          `profile ${req.profileId} is leased; pass force to break the lease`,
          { details: { leaseId: profile.lease.id } },
        );
      await this.store.releaseProfileLease(profile.lease.id, 'admin');
      this.leases.delete(profile.lease.id);
    }
    if (profile.path) {
      await this.fs.trash(profile.path, 'deleted');
    }
    await this.store.setProfileState(req.tenantId, req.profileId, 'deleting');
    const now = this.clock.now();
    return { deletedAt: now, restorableUntil: now + this.config.trashRetentionMsByKind.deleted };
  }

  /** Exempts a profile from automatic GC until `until`, capped at `maxHoldMs`. In-process only (`Profile` has no `holdUntil` field yet). */
  async hold(req: ProfileHoldRequest): Promise<Profile> {
    await this.get(req.tenantId, req.profileId); // 404s if missing
    if (req.until === null) {
      this.holds.delete(req.profileId);
    } else {
      const now = this.clock.now();
      const until = Math.min(req.until, now + this.config.maxHoldMs);
      this.holds.set(req.profileId, { until, reason: req.reason });
    }
    return this.get(req.tenantId, req.profileId);
  }

  /** Whether `profileId` is currently held (exempt from eviction). */
  isHeld(profileId: string): boolean {
    const hold = this.holds.get(profileId);
    return hold !== undefined && hold.until > this.clock.now();
  }

  // ── share grants ────────────────────────────────────────────────────

  /** In-process share grant store (`Store` has no `profile_share_grants` query yet). */
  grantShare(profileId: string, granteeAppId: string, level: 'read' | 'write'): void {
    this.shareGrants.set(`${profileId}:${granteeAppId}`, level);
  }

  /** Whether `granteeAppId` holds a grant on `profileId` at `level` or above. */
  hasShareGrant(
    profileId: string,
    granteeAppId: string,
    level: 'read' | 'write',
  ): Promise<boolean> {
    const have = this.shareGrants.get(`${profileId}:${granteeAppId}`);
    if (!have) return Promise.resolve(false);
    return Promise.resolve(level === 'read' || have === 'write');
  }

  // ── garbage collection (steps 1 through 4 only; 5 through 7 throw) ──

  /**
   * Runs the profile eviction ladder. This build implements steps 1
   * through 4 (trash, expired ephemeral, excess snapshots, LRU ephemeral);
   * requesting steps 5 through 7 (cache trim, stale persistent, unused
   * templates) throws `E_NOT_IMPLEMENTED`. `dryRun` defaults to `true`
   * (the safe one is the default, matching `resolve`'s pattern).
   */
  async gc(req: ProfileGcRequest): Promise<ProfileGcResult> {
    const dryRun = req.dryRun ?? true;
    const steps: readonly GcStep[] = req.steps ?? [
      'trash',
      'expired-ephemeral',
      'excess-snapshots',
      'lru-ephemeral',
    ];
    for (const step of steps) {
      if (step === 'cache-trim' || step === 'stale-persistent' || step === 'unused-templates')
        notImplemented(`gc(step:${step})`);
    }

    const maxDeletes = req.maxDeletes ?? Number.POSITIVE_INFINITY;
    let freedBytes = 0;
    let deletes = 0;
    const plan: { step: GcStep; profileIds: readonly string[]; bytes: number; applied: boolean }[] =
      [];

    if (steps.includes('trash')) {
      if (dryRun) {
        plan.push({ step: 'trash', profileIds: [], bytes: 0, applied: false });
      } else {
        const result = await this.fs.sweep({
          trashRetentionMsByKind: this.config.trashRetentionMsByKind,
          batchLimit: this.config.sweeperBatchLimit,
        });
        freedBytes += result.bytes;
        plan.push({ step: 'trash', profileIds: [], bytes: result.bytes, applied: true });
      }
    }

    if (steps.includes('expired-ephemeral') && deletes < maxDeletes) {
      const now = this.clock.now();
      const candidates = await this.store.listProfiles(req.tenantId, { state: 'free' });
      const expired = candidates.filter(
        (p) =>
          p.mode === 'ephemeral' &&
          p.expiresAt !== null &&
          p.expiresAt <= now &&
          !p.lease &&
          !this.isHeld(p.id),
      );
      const applied: string[] = [];
      let bytes = 0;
      for (const p of expired) {
        if (deletes >= maxDeletes) break;
        bytes += p.sizeBytes;
        if (!dryRun && p.path) {
          await this.fs.trash(p.path, 'ephemeral');
          await this.store.setProfileState(req.tenantId, p.id, 'deleting');
        }
        applied.push(p.id);
        deletes += 1;
      }
      plan.push({ step: 'expired-ephemeral', profileIds: applied, bytes, applied: !dryRun });
      freedBytes += dryRun ? 0 : bytes;
    }

    if (steps.includes('excess-snapshots')) {
      // No snapshot() implementation exists yet (E_NOT_IMPLEMENTED),
      // so there are never any snapshots to evict. Reported for interface
      // completeness.
      plan.push({ step: 'excess-snapshots', profileIds: [], bytes: 0, applied: false });
    }

    if (steps.includes('lru-ephemeral') && deletes < maxDeletes) {
      const minAgeMs = 300_000;
      const now = this.clock.now();
      const candidates = await this.store.listProfiles(req.tenantId, { state: 'free' });
      const lru = candidates
        .filter(
          (p) =>
            p.mode === 'ephemeral' &&
            !p.lease &&
            !this.isHeld(p.id) &&
            now - p.lastUsedAt >= minAgeMs,
        )
        .sort((a, b) => a.lastUsedAt - b.lastUsedAt);
      const applied: string[] = [];
      let bytes = 0;
      for (const p of lru) {
        if (deletes >= maxDeletes) break;
        bytes += p.sizeBytes;
        if (!dryRun && p.path) {
          await this.fs.trash(p.path, 'ephemeral');
          await this.store.setProfileState(req.tenantId, p.id, 'deleting');
        }
        applied.push(p.id);
        deletes += 1;
      }
      plan.push({ step: 'lru-ephemeral', profileIds: applied, bytes, applied: !dryRun });
      freedBytes += dryRun ? 0 : bytes;
    }

    return {
      dryRun,
      freedBytes,
      plan,
      stoppedBecause: deletes >= maxDeletes ? 'cap-reached' : 'plan-exhausted',
    };
  }

  // ── sweeper and startup reconciliation ──────────────────────────────

  /**
   * The router-side sweeper pass: expires leases past
   * `expires_at + profileLeaseStealGraceMs`. A holder that never renewed
   * in time goes to `quarantined`, never back to `free` (a passive sweep
   * has no way to validate the directory the way an active `acquire`'s
   * steal path does with its corruption probe; freeing blind risks
   * handing the directory to a second Chrome while the original holder
   * is merely partitioned, corrupting LevelDB).
   */
  async sweepExpiredLeases(tenantId: string, limit = 50): Promise<readonly ProfileLease[]> {
    const now = this.clock.now();
    const cutoff = new Date(now - this.config.profileLeaseStealGraceMs).toISOString();
    const reclaimed = await this.store.expireProfileLeases(cutoff, limit);
    for (const lease of reclaimed) {
      if (lease.tenantId !== tenantId) continue;
      this.leases.delete(lease.id);
      await this.quarantine(tenantId, lease.profileId, 'renew_missed', lease.holderNodeId);
    }
    return reclaimed;
  }

  /** Unlinks trash past its per-kind retention and reconciles disk versus DB (the node sweeper's first and fourth passes). */
  async sweepFilesystem(): Promise<{
    unlinked: number;
    bytes: number;
    missingDirs: readonly string[];
    orphanDirs: readonly string[];
  }> {
    const swept = await this.fs.sweep({
      trashRetentionMsByKind: this.config.trashRetentionMsByKind,
      batchLimit: this.config.sweeperBatchLimit,
    });
    const reconciled = await this.fs.reconcile();
    return {
      unlinked: swept.unlinked,
      bytes: swept.bytes,
      missingDirs: reconciled.missingDirs,
      orphanDirs: reconciled.orphanDirs,
    };
  }

  /** For every row `reconcile()` reports missing on disk: quarantine it, reason `missing_on_disk`, never silently delete (could be an unmounted volume). */
  async reconcileMissingDirs(tenantId: string, profileIds: readonly string[]): Promise<void> {
    for (const profileId of profileIds) {
      const profile = await this.store.getProfile(tenantId, profileId);
      if (!profile || profile.lease) continue; // never touch a profile with a live lease from any node
      await this.quarantine(tenantId, profileId, 'missing_on_disk', null);
    }
  }

  private async quarantine(
    tenantId: string,
    profileId: string,
    reason: string,
    byNodeId: string | null,
  ): Promise<void> {
    this.quarantineDetail.set(profileId, { reason, byNodeId });
    await this.store.setProfileState(tenantId, profileId, 'quarantined');
    this.onEvent?.({
      type: 'profile.quarantined',
      profileId,
      tenantId,
      detail: { reason, byNodeId },
    });
  }

  // ── stubs (E_NOT_IMPLEMENTED) ───────────────────────────────────────

  // Every stub below is declared `async` deliberately, not a plain
  // function returning `Promise.resolve(notImplemented(...))`: `async`
  // turns the synchronous throw inside `notImplemented` into a promise
  // rejection, which is what every caller (and every `.rejects` test
  // assertion) expects from a `Promise<never>`-returning method.

  /** Stub. Snapshotting is not implemented in this build. */
  async snapshot(): Promise<never> {
    notImplemented('snapshot');
  }
  /** Stub. Exporting is not implemented in this build. */
  async export(): Promise<never> {
    notImplemented('export');
  }
  /** Stub. Importing is not implemented in this build. */
  async import(): Promise<never> {
    notImplemented('import');
  }
  /** Stub. Restoring is not implemented in this build. */
  async restore(): Promise<never> {
    notImplemented('restore');
  }
  /** Stub. Salvage is not implemented in this build. */
  async salvage(): Promise<never> {
    notImplemented('salvage');
  }
  /** Stub. Node-to-node migration is not implemented in this build. */
  async migrate(): Promise<never> {
    notImplemented('migrate');
  }
  /** Stub. `storageState` export is not implemented in this build. */
  async storageState(): Promise<never> {
    notImplemented('storageState');
  }
  /** Stub. Seeding is not implemented in this build. */
  async seed(): Promise<never> {
    notImplemented('seed');
  }

  // ── internals ───────────────────────────────────────────────────────

  private buildResolvedSpec(
    tenantId: string,
    appId: string,
    spec: ProfileSpec,
    instanceId: string,
  ): { resolved: ResolvedProfileSpec; rawKey: string } {
    if (spec.mode === 'ephemeral') {
      const rawKey = ephemeralCallerKey(instanceId);
      return {
        rawKey,
        resolved: {
          mode: 'ephemeral',
          tenantId: tenantId as ResolvedProfileSpec['tenantId'],
          key: rawKey,
          templateId: null,
          seed: spec.seed ?? null,
          destroyOnRelease: true,
          snapshotOnRelease: false,
          ttlMs: null,
          profileId: null,
        },
      };
    }
    if (spec.mode === 'template') {
      if (!spec.templateId)
        throw profileErr('E_PROFILE_SPEC_INVALID', 'template mode requires templateId', {
          details: { field: 'templateId' },
        });
      const rawKey = spec.promoteToKey ?? ephemeralCallerKey(instanceId);
      if (spec.promoteToKey) validateCallerKey(spec.promoteToKey);
      return {
        rawKey,
        resolved: {
          mode: 'template',
          tenantId: tenantId as ResolvedProfileSpec['tenantId'],
          key: rawKey,
          templateId: spec.templateId,
          seed: null,
          destroyOnRelease: !spec.promoteToKey,
          snapshotOnRelease: false,
          ttlMs: null,
          profileId: null,
        },
      };
    }
    // persistent
    validateCallerKey(spec.key);
    if (spec.ttlMs != null && (spec.ttlMs < 60_000 || spec.ttlMs > 31_536_000_000)) {
      throw profileErr('E_PROFILE_SPEC_INVALID', 'ttlMs must be between 60000 and 31536000000', {
        details: { field: 'ttlMs', value: spec.ttlMs },
      });
    }
    return {
      rawKey: spec.key,
      resolved: {
        mode: 'persistent',
        tenantId: tenantId as ResolvedProfileSpec['tenantId'],
        key: spec.key,
        templateId: spec.templateId ?? null,
        seed: null,
        destroyOnRelease: false,
        snapshotOnRelease: spec.snapshotOnRelease ?? false,
        ttlMs: spec.ttlMs ?? null,
        profileId: null,
      },
    };
  }

  private async createProfileRow(
    tenantId: string,
    appId: string,
    rawKey: string,
    resolved: ResolvedProfileSpec,
  ): Promise<Profile> {
    const id = newId('prf');
    const root = await this.fsRoot();
    return this.store.createProfile({
      id,
      tenantId: tenantId as TenantId,
      appId: appId as AppId,
      key: rawKey,
      mode: resolved.mode,
      templateId: resolved.templateId,
      // `storagePathFor()` returns the relative canonical suffix; nothing
      // downstream of `Store.createProfile` ever resolves it against the
      // `ProfileFs` root (`LocalNode.launch()` reads this exact value back,
      // unmodified, as `LaunchRequest.profile.path`, i.e. Chrome's own
      // `--user-data-dir`), so it must be made absolute before it is
      // persisted, here, the one place it is minted.
      storagePath: join(root, storagePathFor(tenantId, id)),
      ttlMs: resolved.ttlMs,
    });
  }

  /** `this.fs`'s root directory, memoised after the first `capabilities()` call. */
  private fsRoot(): Promise<string> {
    if (!this.fsRootPromise) {
      this.fsRootPromise = this.fs.capabilities().then((caps) => caps.root);
    }
    return this.fsRootPromise;
  }

  private async pollForProfile(
    tenantId: string,
    appId: string,
    rawKey: string,
    deadline: number,
  ): Promise<Profile | null> {
    let backoffMs = 50;
    for (;;) {
      const row = await this.store.getProfileByKey(tenantId, appId, rawKey);
      if (row) return row;
      if (this.clock.now() >= deadline) return null;
      await new Promise<void>((resolve) => {
        const timer = this.clock.setTimeout(resolve, backoffMs);
        timer.unref?.();
      });
      backoffMs = Math.min(500, backoffMs * 2);
    }
  }

  private async templateDirFor(tenantId: string, templateId: string): Promise<string> {
    const template = await this.store.getProfile(tenantId, templateId);
    if (!template || template.mode !== 'template' || !template.path) {
      throw profileErr(
        'E_TEMPLATE_INVALID',
        `template ${templateId} not found, not frozen, or has no path`,
        { details: { templateId } },
      );
    }
    return template.path;
  }

  private absolutePathOf(profile: Profile): string {
    if (profile.path) return profile.path;
    return storagePathFor(profile.tenantId, profile.id);
  }

  private acquireLease(
    tenantId: string,
    profileId: string,
    nodeId: string,
    instanceId: string,
    holderPid: number | undefined,
    ttlMs: number,
  ): Promise<ProfileLease | null> {
    return this.store.acquireProfileLease({
      tenantId,
      profileId,
      nodeId,
      instanceId,
      ttlMs,
      ...(holderPid !== undefined ? { holderPid } : {}),
    });
  }

  private async writeFenceOrAbort(path: string, lease: ProfileLease): Promise<void> {
    await this.fs.writeFence(path, lease.fence);
    const readBack = await this.fs.readFence(path);
    if (readBack !== lease.fence) {
      await this.store.releaseProfileLease(lease.id, 'crash');
      throw profileErr(
        'E_FENCE_STALE',
        `fence write/read-back mismatch for lease ${lease.id}: wrote ${lease.fence}, read ${String(readBack)}`,
        { details: { leaseId: lease.id, wrote: lease.fence, read: readBack } },
      );
    }
  }

  // ── periodic lease renewal ──────────────────────────────────────────

  /**
   * Starts the renewal loop. Idempotent; called by whoever owns this
   * service's lifecycle (`buildRouterWiring`), never implicitly by taking
   * a lease: renewal is a policy the owner turns on, while `renew()`
   * itself is the mechanism, and a service constructed directly by a test
   * that is exercising expiry semantics must be able to leave the policy
   * off.
   *
   * The node holding the lease renews on `profileLeaseRenewIntervalMs`,
   * one third of the TTL so two consecutive renew failures still leave headroom. Every
   * grant this service hands out already advertises that interval as
   * `renewIntervalMs`, but nothing ever acted on it, so every lease went
   * stale `profileLeaseTtlMs` (30s) after it was taken. The visible
   * consequence was that any instance alive for longer than the TTL could
   * never be restarted again: `renewForInstance()` refused with
   * `E_PROFILE_BUSY: ... stale`, and `instance.restart` came back to the
   * viewer as "the browser could not be relaunched". A stale lease is also
   * exactly what another node is entitled to steal, so this was a
   * correctness gap and not only an annoyance.
   *
   * A tick over zero tracked leases does nothing, and `Clock.setInterval`
   * unrefs its timer, so an idle service costs nothing and the loop never
   * by itself keeps the process alive.
   */
  startLeaseRenewal(): void {
    if (this.leaseRenewTimer !== null) return;
    this.leaseRenewTimer = this.clock.setInterval(() => {
      void this.tickLeaseRenewal();
    }, this.config.profileLeaseRenewIntervalMs);
  }

  /** Stops the renewal loop unconditionally. For a clean shutdown; leases already taken are unaffected until they expire. */
  stopLeaseRenewal(): void {
    if (this.leaseRenewTimer === null) return;
    this.clock.clearInterval(this.leaseRenewTimer);
    this.leaseRenewTimer = null;
  }

  /**
   * Renews every tracked lease, one at a time.
   *
   * Serial and per lease on purpose, never batching every renewal into
   * one statement: a single slow or failing statement would then fail every profile at once, where this way a
   * partial failure stays partial. `renew()` already owns what a failure
   * means (it drops the tracked record and reports through `onFenceLost`),
   * so nothing is rethrown here; a renewal loop that could throw would
   * take its own next tick down with it.
   */
  private async tickLeaseRenewal(): Promise<void> {
    for (const record of [...this.leases.values()]) {
      await this.renew({ leaseId: record.leaseId, fence: record.fence, ttlMs: record.ttlMs }).catch(
        () => undefined,
      );
    }
  }

  private trackLease(
    lease: ProfileLease,
    req: { nodeId: string; instanceId: string },
    ttlMs: number,
  ): void {
    const now = this.clock.now();
    this.leases.set(lease.id, {
      leaseId: lease.id,
      profileId: lease.profileId,
      tenantId: lease.tenantId,
      nodeId: req.nodeId,
      instanceId: req.instanceId,
      fence: lease.fence,
      expiresAt: lease.expiresAt,
      ttlMs,
      grantedAt: now,
      lastRenewAt: now,
    });
  }

  /** The materialised, node local directory for an already leased profile, for the `ProfileServicePort` adapter's `materialisedPathFor`. */
  async materialisedPathForStoredKey(
    tenantId: string,
    appId: string,
    rawKey: string,
  ): Promise<{ path: string; containerPath: string | null } | null> {
    const profile = await this.store.getProfileByKey(tenantId, appId, rawKey);
    if (!profile || !profile.path) return null;
    return { path: profile.path, containerPath: null };
  }
}
