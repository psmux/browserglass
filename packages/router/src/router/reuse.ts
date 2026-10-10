/**
 * Reuse precedence.
 * Four kinds, checked in order: idempotent replay (handled separately, at
 * the very top of `acquire`, by `IdempotencyTable`), profile sharing,
 * sticky, and warm adoption. Reuse is checked *before* admission, since a
 * shared browser consumes no new quota slot; that ordering lives in
 * `BrowserRouter.acquire`, this module only implements the checks.
 */

import type {
  AppId,
  BrowserSpec,
  Instance,
  InstanceId,
  Principal,
  Store,
  TenantId,
} from '@browserglass/protocol';
import type { Clock } from './clock.js';
import type { ProfileServicePort } from './types.js';

/**
 * The `BrowserSpec` fields a shared instance's spec and a new request's
 * resolved spec must agree on.
 * `proxy` is compared field by field (`server`, `bypass` only);
 * `proxy.username`/`proxy.password` are per-acquire credentials and
 * deliberately excluded, or sharing collapses on an authenticated proxy
 * pool. Viewport is deliberately absent: not share-significant, handled
 * by quality negotiation rather than refusing to share.
 */
export const SHARE_SIGNIFICANT_FIELDS = [
  'channel',
  'headless',
  'proxy.server',
  'proxy.bypass',
  'userAgent',
  'locale',
  'timezoneId',
  'stealth',
  'ignoreHttpsErrors',
  'extensions',
  'extraArgs',
] as const;

function getSignificantField(
  spec: BrowserSpec,
  field: (typeof SHARE_SIGNIFICANT_FIELDS)[number],
): unknown {
  if (field === 'proxy.server') return spec.proxy?.server ?? null;
  if (field === 'proxy.bypass') return spec.proxy?.bypass ?? null;
  return (spec as unknown as Record<string, unknown>)[field];
}

function valuesEqual(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => v === b[i]);
  }
  return a === b;
}

/** Every `SHARE_SIGNIFICANT_FIELDS` entry on which `existing` and `requested` disagree. Empty means they may share. */
export function specConflicts(existing: BrowserSpec, requested: BrowserSpec): string[] {
  const conflicts: string[] = [];
  for (const field of SHARE_SIGNIFICANT_FIELDS) {
    if (!valuesEqual(getSignificantField(existing, field), getSignificantField(requested, field)))
      conflicts.push(field);
  }
  return conflicts;
}

/** Why `canShare` refused: the `deny(...)` reasons. */
export type ShareDenyReason =
  | 'cross_tenant'
  | 'not_ready'
  | 'expiring_soon'
  | 'cross_app'
  | 'spec_conflict'
  | 'viewer_limit';

/** `canShare`'s result. */
export type ShareVerdict =
  | { allowed: true }
  | { allowed: false; reason: ShareDenyReason; conflicts?: readonly string[] };

/** Context `canShare` needs beyond the two instances being compared. */
export interface ShareContext {
  now: number;
  /** Default 60000. An instance expiring sooner than this is not worth sharing into. */
  shareMinRemainingMs: number;
  /** The existing instance's current live viewer count, from the node's heartbeat, not the store. */
  liveViewerCount: number;
  maxViewersPerStream: number;
  /** `maxStreamsPerSession`, not `maxStreams`. */
  maxStreamsPerSession: number;
  profiles: ProfileServicePort;
}

/**
 * The profile sharing gate.
 * Same app always shares; cross app requires an explicit grant row, never
 * a pool level boolean (an isolation hole otherwise). `stealth` is share
 * significant in both directions even though the merge rules only ever
 * lower it: an already launched browser cannot retroactively lower
 * stealth for one new viewer without affecting every existing viewer.
 */
export async function canShare(
  existing: Instance,
  requested: { tenantId: TenantId; appId: AppId; resolvedSpec: BrowserSpec },
  principal: Principal,
  ctx: ShareContext,
): Promise<ShareVerdict> {
  if (existing.tenantId !== principal.tenantId) return { allowed: false, reason: 'cross_tenant' };
  if (existing.state !== 'ready' && existing.state !== 'degraded')
    return { allowed: false, reason: 'not_ready' };
  if (existing.expiresAt - ctx.now < ctx.shareMinRemainingMs)
    return { allowed: false, reason: 'expiring_soon' };

  if (existing.appId !== requested.appId) {
    if (existing.profileId == null) return { allowed: false, reason: 'cross_app' };
    const granted = await ctx.profiles.hasShareGrant(existing.profileId, requested.appId, 'write');
    if (!granted) return { allowed: false, reason: 'cross_app' };
  }

  const conflicts = specConflicts(existing.spec, requested.resolvedSpec);
  if (conflicts.length > 0) return { allowed: false, reason: 'spec_conflict', conflicts };

  if (ctx.liveViewerCount >= ctx.maxViewersPerStream * ctx.maxStreamsPerSession) {
    return { allowed: false, reason: 'viewer_limit' };
  }

  return { allowed: true };
}

/**
 * Instance states in which a holder can no longer be holding anything.
 *
 * `released` and `failed` are the two the profile lease outlives in
 * practice: the lease row is INSERTed during placement and is released by
 * the instance's own teardown, so an instance that failed BEFORE it ever
 * became ready leaves the row behind with `released_at` still null.
 * `releasing` and `draining` are on their way there and are equally not
 * worth sharing into.
 */
const TERMINAL_HOLDER_STATES: ReadonlySet<string> = new Set([
  'releasing',
  'released',
  'failed',
  'draining',
]);

/** `findReusable`'s outcome. */
export type ReuseOutcome =
  | { kind: 'found'; instance: Instance; why: 'profile-shared' | 'sticky' | 'warm' }
  | {
      kind: 'busy';
      /** The live instance holding the requested profile's lease, which this request may not share. */
      holder: Instance;
      holderAppId: string;
      /** Why `canShare` refused it, so the caller's `E_PROFILE_BUSY` can say so. */
      reason: ShareDenyReason;
      /** The disagreeing fields, set when `reason` is `spec_conflict`. */
      conflicts?: readonly string[];
    }
  | {
      kind: 'none';
      /**
       * The live looking holder of the requested profile's lease, when it
       * was passed over because no process this router can reach owns it
       * (see `FindReusableRequest.ownerServable`). The caller may reclaim
       * its lease rather than wait for it to expire.
       */
      abandonedHolder?: Instance;
    };

/** Everything `findReusable` needs, gathered by `BrowserRouter.acquire` before calling it. */
export interface FindReusableRequest {
  tenantId: TenantId;
  appId: AppId;
  principal: Principal;
  resolvedSpec: BrowserSpec;
  /** Content addressed spec id, already upserted, for warm instance matching. */
  specId: string;
  poolId: string;
  /** Set when the request names a persistent profile by key. */
  profileKey: string | null;
  sticky: { subject: string; withinMs?: number } | null;
  /** The existing instance a live viewer count lookup needs, keyed by instance id (from the node heartbeat, not the store). */
  liveViewerCountOf: (instanceId: InstanceId) => number;
  shareCtx: Omit<ShareContext, 'now' | 'liveViewerCount'>;
  clock: Clock;
  store: Store;
  /**
   * Whether an instance row is owned by a process this router can actually
   * hand it out from: this router's own node, or a peer node that is
   * reachable and alive. Defaults to "yes" for every row.
   *
   * Without this check a gateway that restarted after a crash handed out
   * the dead gateway's rows. They still read `ready`, their profile lease
   * had not expired yet, and the caller then failed to attach with
   * "driven by node X, not this gateway", because node X no longer
   * existed.
   */
  ownerServable?: (instance: Instance) => Promise<boolean>;
}

/**
 * The three reuse kinds `findReusable` checks, in order (idempotent replay
 * is handled separately by `IdempotencyTable` before `findReusable` is
 * ever called): profile sharing, sticky, then warm adoption.
 */
export async function findReusable(req: FindReusableRequest): Promise<ReuseOutcome> {
  const now = req.clock.now();
  const servable = req.ownerServable ?? (async () => true);
  let abandonedHolder: Instance | undefined;

  // 1. Profile sharing: a request naming a persistent profile whose key is
  // already leased by a live instance.
  if (req.profileKey) {
    const profile = await req.store.getProfileByKey(req.tenantId, req.appId, req.profileKey);
    const holderInstanceId = profile?.lease?.holderInstanceId ?? null;
    if (profile && holderInstanceId) {
      const holder = await req.store.getInstance(req.tenantId, holderInstanceId);
      // A holder in a TERMINAL state is not somebody to share with and is
      // not somebody to be refused for either, so it falls through to the
      // rest of the reuse chain exactly as a holder row that has vanished
      // already did.
      //
      // Before this check, such a holder reached `canShare`, which refused
      // it `not_ready`, which became `{ kind: 'busy' }`, which
      // `BrowserRouter.doAcquire` turned into
      // `E_PROFILE_BUSY: profile already leased`. That verdict is
      // PERMANENT: nothing in this function or above it releases a lease,
      // `Store.loadLiveLease` selects on `released_at IS NULL` with no
      // expiry predicate so the row stays visible for ever, and
      // `acquireProfileLease`'s refusal is a UNIQUE constraint over
      // unreleased leases that likewise never consults `expires_at`. So a
      // profile whose holder had died was refused to everybody, for ever,
      // with a message that read like a live conflict.
      //
      // Falling through instead hands the decision to
      // `ProfileService.acquirePersistent`, which is the one place that
      // already knows how to make it: it compares `now` against
      // `expiresAt + profileLeaseStealGraceMs`, runs the corruption probe
      // and the singleton check, and either steals the lease or throws
      // `E_PROFILE_BUSY` with a real `retryAfterMs`. That turns a
      // permanent refusal into one that either succeeds or tells the
      // caller when to come back.
      //
      // Expiry deliberately does NOT appear in this condition. A lease
      // past `expiresAt` whose holder is still `ready` is a heartbeat that
      // is late, not a holder that is gone, and treating it as reclaimable
      // here would pull a profile directory out from under a running
      // Chrome. That judgement belongs to the steal path, behind its grace
      // window and its probe, and this function's only job is to avoid
      // answering `busy` on behalf of a holder that cannot hold anything.
      // A holder no process here can serve is neither shareable nor a
      // reason to answer busy. It falls through like a terminal holder,
      // and is reported so the caller can reclaim its lease.
      if (holder && !TERMINAL_HOLDER_STATES.has(holder.state) && !(await servable(holder))) {
        abandonedHolder = holder;
      } else if (holder && !TERMINAL_HOLDER_STATES.has(holder.state)) {
        const verdict = await canShare(
          holder,
          { tenantId: req.tenantId, appId: req.appId, resolvedSpec: req.resolvedSpec },
          req.principal,
          { ...req.shareCtx, now, liveViewerCount: req.liveViewerCountOf(holder.id) },
        );
        if (verdict.allowed) return { kind: 'found', instance: holder, why: 'profile-shared' };
        return {
          kind: 'busy',
          holder,
          holderAppId: holder.appId,
          reason: verdict.reason,
          ...(verdict.conflicts !== undefined ? { conflicts: verdict.conflicts } : {}),
        };
      }
    }
  }

  // 2. Sticky: a recent instance for the same subject, still ready or
  // degraded, within the requested window.
  const stickyReq = req.sticky;
  if (stickyReq) {
    // `createdBySub` goes into the store query, not into a `.filter()`
    // after it. `Store.listInstances` caps its result (`store-sqlite`
    // defaults to `LIMIT 200`, `InstanceFilter.limit` unset), so listing
    // the whole tenant and matching subjects in JS meant that on any busy
    // tenant the caller's own sticky instance simply fell outside the
    // window and sticky silently stopped working, with no error and no
    // way for the caller to tell reuse from a fresh launch. The DDL's
    // `instances.created_by_sub` is the column `Instance.subject` maps
    // from, and `store-sqlite`'s `listInstances` already filters on it,
    // so the whole match now happens in the query and the row cap applies
    // to this subject's own instances rather than the tenant's.
    const candidates = await req.store.listInstances(req.tenantId, {
      status: ['live', 'warm', 'recovering'],
      createdBySub: stickyReq.subject,
    });
    const ordered = candidates
      .filter((i) => stickyReq.withinMs == null || now - i.lastActivityAt <= stickyReq.withinMs)
      .sort((a, b) => b.lastActivityAt - a.lastActivityAt);
    // The most recent one this router can actually serve; see `ownerServable`.
    let sticky: Instance | undefined;
    for (const candidate of ordered) {
      if (await servable(candidate)) {
        sticky = candidate;
        break;
      }
    }
    if (sticky) {
      const verdict = await canShare(
        sticky,
        { tenantId: req.tenantId, appId: req.appId, resolvedSpec: req.resolvedSpec },
        req.principal,
        { ...req.shareCtx, now, liveViewerCount: req.liveViewerCountOf(sticky.id) },
      );
      if (verdict.allowed) return { kind: 'found', instance: sticky, why: 'sticky' };
    }
  }

  // 3. Warm adoption: an atomic claim, so two concurrent acquires cannot
  // both adopt the same warm instance.
  const adopted = await req.store.claimWarmInstance({
    tenantId: req.tenantId,
    poolId: req.poolId,
    specId: req.specId,
  });
  if (adopted) return { kind: 'found', instance: adopted, why: 'warm' };

  return abandonedHolder ? { kind: 'none', abandonedHolder } : { kind: 'none' };
}
