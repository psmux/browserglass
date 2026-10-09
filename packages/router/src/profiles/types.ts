/**
 * `ProfileService`'s own request, result, and configuration types.
 * `resolve`'s `dryRun` defaults to `true`, and trash retention is per kind.
 *
 * This package builds `resolve`, `acquire`, `renew`, `release`, `list`,
 * `get`, `delete`, and `hold` for real. `snapshot`, `export`, `import`,
 * `restore`, `salvage`, `migrate`, and the whole `TemplateService` bake,
 * verify, freeze, retire workflow are stubbed with `E_NOT_IMPLEMENTED`;
 * materialising *from* an existing frozen template directory is
 * implemented, since it is what `acquire`'s `template` mode needs.
 */

import type {
  ProfileAction,
  ProfileId,
  ProfileSpec,
  ProfileState,
  ResolvedProfileSpec,
} from '@browserglass/protocol';
import type { Materialisation, ProbeResult, TrashKind } from '@browserglass/protocol';

// ── configuration ──────────────────────────────────────────────────────

/**
 * `ProfileService`'s tunables and their defaults.
 */
export interface ProfileServiceConfig {
  /** Default lease TTL, ms. Default 30000. */
  profileLeaseTtlMs: number;
  /** Renewal cadence a holder is expected to use, ms. Default 10000. */
  profileLeaseRenewIntervalMs: number;
  /** Grace added to `expiresAt` before another node may steal a `ready` holder's lease, ms. Default 5000. */
  profileLeaseStealGraceMs: number;
  /** Budget for stale-fence protocol steps 1 through 3, ms. Default 500. */
  fenceLostReactionBudgetMs: number;
  /** `acquire`'s default deadline, ms. Default 60000. */
  acquireDeadlineMsDefault: number;
  /** The create race loser's poll deadline ceiling, ms (the OTHER half of `min(acquireDeadline, createTimeout)`). Default 120000. */
  profileCreateTimeoutMs: number;
  /** Above this, a plain recursive copy is refused with `E_COPY_TOO_SLOW`. Default 256 MiB. */
  maxInlineCopyBytesDefault: number;
  /** Ephemeral profile default TTL when the tenant sets none, ms. Default 3600000 (1 hour). */
  ephemeralTtlMsDefault: number;
  /** Chrome major drift a template may have before `E_TEMPLATE_CHROME_DRIFT`. Default 2. */
  maxTemplateChromeDrift: number;
  /** Per trash kind retention. */
  trashRetentionMsByKind: Readonly<Record<TrashKind, number>>;
  /** Sweeper: directories inspected per pass. Default 8. */
  sweeperBatchLimit: number;
  /** `hold()`'s cap on `until - now`, ms. Default 90 days. */
  maxHoldMs: number;
}

/** {@link ProfileServiceConfig}'s defaults, every value cited in its own TSDoc line. */
export const DEFAULT_PROFILE_SERVICE_CONFIG: ProfileServiceConfig = Object.freeze({
  profileLeaseTtlMs: 30_000,
  profileLeaseRenewIntervalMs: 10_000,
  profileLeaseStealGraceMs: 5_000,
  fenceLostReactionBudgetMs: 500,
  acquireDeadlineMsDefault: 60_000,
  profileCreateTimeoutMs: 120_000,
  maxInlineCopyBytesDefault: 256 * 1024 * 1024,
  ephemeralTtlMsDefault: 3_600_000,
  maxTemplateChromeDrift: 2,
  trashRetentionMsByKind: Object.freeze({
    ephemeral: 900_000,
    deleted: 604_800_000,
    quarantine: 2_592_000_000,
    migration: 86_400_000,
  }),
  sweeperBatchLimit: 8,
  maxHoldMs: 7_776_000_000,
});

// ── resolve ─────────────────────────────────────────────────────────────

/** `ProfileService.resolve`'s request. `dryRun` defaults to `true`. */
export interface ResolveRequest {
  tenantId: string;
  appId: string;
  spec: ProfileSpec;
  instanceId: string;
  /** Default `true`: pure lookup, safe to call speculatively, never creates a directory. */
  dryRun?: boolean;
}

/**
 * `resolve`'s result. An unreachable resolution step is deliberately
 * not represented.
 */
export type ResolveResult =
  | { kind: 'reuse'; instanceId: string; profileId: string; nodeId: string | null }
  | {
      kind: 'lease';
      profileId: string | null;
      eligibleNodeIds: readonly string[] | null;
      resolved: ResolvedProfileSpec;
      estimatedMaterialiseMs: number;
      /** Whether *this* call created the profile row (only possible when `dryRun` is `false`). Not part of the source document's shape; added for the `ProfileServicePort` adapter's `ResolvedProfileSpecResult.created`. */
      created: boolean;
    }
  | { kind: 'error'; code: ProfileErrorCode; detail: Record<string, unknown> };

// ── acquire ─────────────────────────────────────────────────────────────

/** `ProfileService.acquire`'s request. */
export interface ProfileAcquireRequest {
  tenantId: string;
  appId: string;
  spec: ProfileSpec;
  instanceId: string;
  nodeId: string;
  holderPid?: number;
  /** Wait for a plain copy above `maxInlineCopyBytes` rather than failing. Default `false`. */
  allowSlowCopy?: boolean;
  /** Proceed past `maxTemplateChromeDrift`. Default `false`. */
  allowChromeDrift?: boolean;
  /** Clamped to `[10_000, 300_000]`. */
  leaseTtlMs?: number;
  /** Fail rather than wait if another acquire is materialising the same key. */
  noWait?: boolean;
  /** Default 60000. */
  deadlineMs?: number;
  /**
   * An instance whose lease on this profile may be taken over now, without
   * waiting for it to expire, because the caller has established that no
   * process it can reach still owns that instance (a row left behind by a
   * gateway that died). The steal path's corruption probe and its live
   * singleton check still run, so a Chrome still holding the directory
   * refuses the takeover.
   */
  reclaimFromHolderInstanceId?: string;
}

/**
 * `acquire`'s materialisation strategy: `ProfileFs`'s own {@link
 * Materialisation} union, widened with `'existing'` for the case this
 * package's own acquire path needs that `ProfileFs` has no value for: a
 * persistent profile whose directory was materialised by an earlier
 * acquire and is simply being re-leased now, with no `ProfileFs.
 * materialise` call at all.
 */
export type ProfileMaterialisation = Materialisation | 'existing';

/** `acquire`'s result. */
export type ProfileAcquireResult =
  | { kind: 'reuse'; instanceId: string; profileId: string }
  | {
      kind: 'leased';
      profileId: string;
      leaseId: string;
      fence: number;
      /** Absolute, on the acquiring node. */
      path: string;
      expiresAt: number;
      renewIntervalMs: number;
      resolved: ResolvedProfileSpec;
      materialisation: ProfileMaterialisation;
      materialiseMs: number;
      probe: ProbeResult | null;
    };

// ── renew ───────────────────────────────────────────────────────────────

/** `ProfileService.renew`'s request. */
export interface ProfileRenewRequest {
  leaseId: string;
  fence: number;
  ttlMs?: number;
}

/** Why a `renew` failed. The node does not need to distinguish these operationally; all four trigger the stale-fence protocol identically. */
export type RenewFailureReason = 'stale' | 'released' | 'gone';

/** `renew`'s result. */
export type ProfileRenewResult =
  | { ok: true; expiresAt: number }
  | { ok: false; reason: RenewFailureReason };

// ── release ─────────────────────────────────────────────────────────────

/** `ProfileService.release`'s request. */
export interface ProfileReleaseRequest {
  leaseId: string;
  fence: number;
  reason: 'normal' | 'drain' | 'crash' | 'admin';
  /**
   * Which profile this lease is on, for the case where this process's in
   * memory record of the lease is gone (a restart, most commonly).
   *
   * Without it, `release()` holds nothing but a `leaseId`, and a `leaseId`
   * alone cannot be checked against anything: `Store` exposes no lookup by
   * lease id, so there is no way to ask whether the row is still open or
   * whether something is still renewing it. Releasing blind on that basis
   * would be the one genuinely unsafe move here, so `release()` declines
   * instead. Supplying this turns the untracked case from "give up" into a
   * decision the store can answer, via `getProfile`'s single unreleased
   * lease. See {@link UntrackedLeaseRelease}.
   */
  identity?: {
    tenantId: string;
    profileId: string;
    instanceId: string;
    /**
     * Whether the caller has positively confirmed the browser holding this
     * profile is dead, which is stronger information than the lease TTL
     * carries. `BrowserRouter.release()` can say yes: it only reaches its
     * lease release after `terminateGraceThenForce` confirmed the process
     * is gone, and it throws rather than continuing when it cannot. A
     * caller that cannot say so leaves this unset, and an unexpired lease
     * is then left alone on the assumption that something may still be
     * renewing it.
     */
    browserConfirmedGone?: boolean;
  };
  /** Overrides the resolved spec's `snapshotOnRelease` for this call only. */
  snapshot?: boolean;
  /** Overrides `destroyOnRelease`; ignored (and audited) for ephemeral profiles. */
  keep?: boolean;
}

/** `release`'s result. */
export interface ProfileReleaseResult {
  releasedAt: number;
  snapshotId: string | null;
  destroyed: boolean;
  promotedToKey: string | null;
  finalSizeBytes: number | null;
  warnings: readonly string[];
}

// ── list / get / delete / hold ─────────────────────────────────────────

/** `ProfileService.list`'s request. */
export interface ProfileListRequest {
  tenantId: string;
  appId?: string;
  mode?: readonly ('persistent' | 'ephemeral' | 'template')[];
  state?: readonly ProfileState[];
  keyPrefix?: string;
  nodeId?: string;
  sort?: 'lastUsedAt' | 'sizeBytes' | 'createdAt' | 'key';
  order?: 'asc' | 'desc';
  limit?: number;
}

/** `ProfileService.delete`'s request. */
export interface ProfileDeleteRequest {
  tenantId: string;
  profileId: string;
  /** Breaks a live lease. Default `false`. */
  force?: boolean;
}

/** `delete`'s result. */
export interface ProfileDeleteResult {
  deletedAt: number;
  restorableUntil: number;
}

/** `ProfileService.hold`'s request. */
export interface ProfileHoldRequest {
  tenantId: string;
  profileId: string;
  /** `null` clears the hold. */
  until: number | null;
  reason: string;
}

// ── fence-lost reporting (stale-fence protocol steps 5 and 6's router-side half) ─

/**
 * Emitted synchronously by `renew()` the instant it discovers a stale
 * fence (the fence protocol's steps 1 through 3 budget applies to the *caller*
 * driving the browser; `ProfileService` itself owns only steps 4 through
 * 7, meaning it does not touch the directory, it reports, and it never
 * retries the lease), since it has no reference to the CDP session or
 * Chrome process that steps 1 through 3 need. A caller with that
 * reference (the not yet built Instance/Session layer) subscribes to
 * this to run steps 1 through 3 itself.
 */
export interface FenceLostReport {
  profileId: string;
  leaseId: string;
  myFence: number;
  observedFence: number | null;
  instanceId: string | null;
  nodeId: string | null;
  reason: RenewFailureReason;
  /** Milliseconds since the last successful renew, or since grant if never renewed. */
  elapsedSinceRenewMs: number;
}

/** A synchronous fence-lost subscriber. Must not await anything blocking; `ProfileService` never awaits its return value. */
export type FenceLostHandler = (report: FenceLostReport) => void;

// ── garbage collection ─────────────────────────────────────────────────

/** One step of the profile eviction ladder. This build implements steps 1 through 4 only; 5 through 7 are typed for interface completeness and always throw `E_NOT_IMPLEMENTED`. */
export type GcStep =
  | 'trash'
  | 'expired-ephemeral'
  | 'excess-snapshots'
  | 'lru-ephemeral'
  | 'cache-trim'
  | 'stale-persistent'
  | 'unused-templates';

/** `ProfileService.gc`'s request. */
export interface ProfileGcRequest {
  tenantId: string;
  /** Default `true`: the safe one is the default. */
  dryRun?: boolean;
  steps?: readonly GcStep[];
  maxDeletes?: number;
}

/** `gc`'s result. */
export interface ProfileGcResult {
  dryRun: boolean;
  freedBytes: number;
  plan: readonly { step: GcStep; profileIds: readonly string[]; bytes: number; applied: boolean }[];
  stoppedBecause: 'target-met' | 'plan-exhausted' | 'cap-reached' | 'error';
}

// ── errors ──────────────────────────────────────────────────────────────

/** Every code `ProfileService` may throw, including `E_PROFILE_SPEC_INVALID` and `E_NOT_IMPLEMENTED` for the stubbed surface. */
export type ProfileErrorCode =
  | 'E_PROFILE_NOT_FOUND'
  | 'E_PROFILE_BUSY'
  | 'E_PROFILE_QUARANTINED'
  | 'E_PROFILE_UNREACHABLE'
  | 'E_PROFILE_KEY_RESERVED'
  | 'E_PROFILE_KEY_INVALID'
  | 'E_PROFILE_CREATE_TIMEOUT'
  | 'E_PROFILE_SPEC_INVALID'
  | 'E_TEMPLATE_INVALID'
  | 'E_TEMPLATE_CHROME_DRIFT'
  | 'E_TEMPLATE_CHROME_NEWER'
  | 'E_BUNDLE_CORRUPT'
  | 'E_BUNDLE_PLATFORM_MISMATCH'
  | 'E_BUNDLE_CHROME_NEWER'
  | 'E_QUOTA_EXCEEDED'
  | 'E_DISK_FULL'
  | 'E_COPY_TOO_SLOW'
  | 'E_FENCE_STALE'
  | 'E_SEED_INVALID_COOKIE'
  | 'E_SEED_UNSUPPORTED_VALUE'
  | 'E_NOT_IMPLEMENTED';

/** Re-exported so callers of `ProfileService` do not need a separate import for the `ProfileAction` enum it accepts. */
export type { ProfileAction, ProfileId };

// ── untracked lease release ────────────────────────────────────────────

/**
 * What `ProfileService.releaseUntrackedLease` did, and why.
 *
 * `ProfileService` tracks granted leases in an in memory map, which is
 * this process's bookkeeping and not the system of record. The map is
 * empty after a restart, so every lease granted by a previous incarnation
 * is a cache miss, and treating a cache miss as "nothing to do" is what
 * stranded 48 of 50 `profile_leases` rows on the demo deployment with
 * `released_at = NULL`. A stranded row is not cosmetic: `Store.getProfile`
 * resolves a profile's single unreleased lease, so the next acquire naming
 * the same persistent key fails `E_PROFILE_BUSY` against a holder that
 * stopped existing hours ago.
 *
 * Each variant is a genuinely different situation and the caller should be
 * able to tell them apart in a log, which is why this is a discriminated
 * union rather than a boolean.
 */
export type UntrackedLeaseRelease =
  /** The store row was open, this instance held it, and it has been released. The leak case. */
  | { outcome: 'released'; leaseId: string; profileStateSetFree: boolean }
  /** Nothing to do: no profile row, no lease on it, or a lease already released. */
  | { outcome: 'no-open-lease' }
  /** Some other instance has since taken the lease on this profile. Left alone: yanking it away would hand a live browser's directory to a second one. */
  | { outcome: 'held-by-other-instance'; leaseId: string; holderInstanceId: string }
  /** The lease has not expired and the caller could not confirm the browser is gone, so something may still be renewing it. Left alone. */
  | { outcome: 'live-holder'; leaseId: string; expiresAt: number };
