/**
 * The six entity state machines, expressed as data, plus the shared runtime
 * helper that drives all of them. `Node`'s machine is owned elsewhere and
 * is not one of the six.
 *
 * Construction transitions (an entity coming into existence) are not represented here: they happen through a `Store`
 * `create*` call, not through `transition()`, so no table below has a row
 * keyed by a non entity `from` state.
 *
 * Each table entry maps a state to an event to an ordered list of candidate
 * rules. `transition()` evaluates them in order and takes the first whose
 * guard passes (or has no guard). This generalises a single row
 * per (state, event) pseudocode to the handful of transitions that
 * genuinely branch on a guard (for example a slow viewer either downgrades
 * or is closed, depending on policy), while preserving its documented
 * contract exactly for the plain cases: no row and not terminal throws, no
 * row and terminal is ignored, a row whose guard fails is ignored.
 */

import type {
  ControlLeaseState,
  InstanceLifecycleState,
  ProfileState,
  SessionState,
  StreamState,
  ViewerState,
} from './entities.js';

/** Thrown when `transition()` is asked to apply an event that is illegal from a non terminal state. */
export class InvalidStateTransition extends Error {
  constructor(
    readonly entity: string,
    readonly id: string,
    readonly from: string,
    readonly event: string,
    readonly to: string | null,
  ) {
    super(`${entity} ${id}: illegal ${from} --${event}--> ${to ?? '?'}`);
    this.name = 'InvalidStateTransition';
  }
}

/** The three shapes a `transition()` call can resolve to. */
export type TransitionOutcome<S> =
  | { kind: 'ok'; to: S }
  | { kind: 'ignored'; reason: string }
  | { kind: 'illegal' };

/** A loosely typed bag of facts a guard reads to decide whether a transition may proceed. */
export type TransitionContext = Readonly<Record<string, unknown>>;

/** One candidate outcome for a (state, event) pair. Evaluated in table order. */
export interface TransitionRule<S extends string> {
  to: S;
  /** When omitted the rule always matches. */
  guard?: (ctx: unknown) => boolean;
  guardName?: string;
}

/** A full transition table for one entity's state machine. */
export type TransitionTable<S extends string, E extends string> = Partial<
  Record<S, Partial<Record<E, readonly TransitionRule<S>[]>>>
>;

function flag(ctx: unknown, key: string): boolean {
  return typeof ctx === 'object' && ctx !== null && Boolean((ctx as Record<string, unknown>)[key]);
}

/**
 * Runs one event through a transition table.
 *
 * Behaviour contract, shared by all six machines:
 * 1. Illegal from a terminal state returns `{kind:'ignored'}`, never throws.
 *    Normal and noisy, for example a late callback after something already
 *    ended.
 * 2. Illegal from a live, non terminal state throws `InvalidStateTransition`.
 *    Callers catch this at the message boundary, log the full transition,
 *    and increment a counter that should stay at zero.
 * 3. A rule whose guard fails returns `{kind:'ignored', reason}`, logged at
 *    debug. Normal, for example a quota not met or a target already gone.
 */
export function transition<S extends string, E extends string>(
  table: TransitionTable<S, E>,
  entity: string,
  id: string,
  from: S,
  event: E,
  ctx: unknown,
): TransitionOutcome<S> {
  const rules = table[from]?.[event];
  if (!rules || rules.length === 0) {
    if (TERMINAL[entity]?.has(from)) return { kind: 'ignored', reason: 'terminal_state' };
    throw new InvalidStateTransition(entity, id, from, event, null);
  }
  for (const rule of rules) {
    if (!rule.guard || rule.guard(ctx)) return { kind: 'ok', to: rule.to };
  }
  const last = rules[rules.length - 1] as TransitionRule<S>;
  return { kind: 'ignored', reason: last.guardName ?? 'guard' };
}

/** The terminal state set per entity, consulted by `transition()` to decide ignore versus throw. */
export const TERMINAL: Readonly<Record<string, ReadonlySet<string>>> = Object.freeze({
  Instance: new Set(['released', 'failed']),
  Session: new Set(['ended']),
  Stream: new Set(['stopped']),
  Viewer: new Set(['expired']),
  ControlLease: new Set(['revoked', 'forceClaimed']),
  Profile: new Set(['deleted']),
});

// ── Instance ────────────────────────────────────────────────────────────

/** Events the `Instance` machine accepts. */
export type InstanceEvent =
  | 'placementStarted'
  | 'admissionRejected'
  | 'placed'
  | 'noCapacity'
  | 'nodeRejected'
  | 'cdpReady'
  | 'launchTimeout'
  | 'launchError'
  | 'healthDegraded'
  | 'recoverySignal'
  | 'drainRequested'
  | 'releaseRequested'
  | 'healthOk'
  | 'recovered'
  | 'ladderExhausted'
  | 'ladderExhaustedButAlive'
  | 'handoffComplete'
  | 'drainDeadline'
  | 'noViewers'
  | 'processGone'
  | 'killTimeout'
  | 'retry';

/**
 * The `Instance` transition table. Fence staleness (`any transition with a
 * stale fence rejects E_FENCED`) is cross cutting rather than local to one
 * row, so callers check `ctx.fence` against the instance's current fence
 * before calling `transition()`, the same way they check admission and
 * placement results before calling it here.
 */
export const INSTANCE_TRANSITIONS: TransitionTable<InstanceLifecycleState, InstanceEvent> = {
  requested: {
    placementStarted: [
      { to: 'placing', guard: (ctx) => flag(ctx, 'hasCandidate'), guardName: 'has_candidate' },
    ],
    admissionRejected: [
      {
        to: 'failed',
        guard: (ctx) => flag(ctx, 'quotaExceededRejectPolicy'),
        guardName: 'quota_reject',
      },
    ],
  },
  placing: {
    placed: [
      { to: 'launching', guard: (ctx) => flag(ctx, 'nodeAccepted'), guardName: 'node_accepted' },
    ],
    noCapacity: [
      {
        to: 'failed',
        guard: (ctx) => !flag(ctx, 'onFullQueue'),
        guardName: 'no_candidate_above_floor',
      },
    ],
    nodeRejected: [
      { to: 'placing', guard: (ctx) => flag(ctx, 'attemptsRemain'), guardName: 'attempts_remain' },
    ],
  },
  launching: {
    cdpReady: [
      { to: 'ready', guard: (ctx) => flag(ctx, 'hasTarget'), guardName: 'cdp_handshake_done' },
    ],
    launchTimeout: [{ to: 'failed' }],
    launchError: [{ to: 'failed' }],
  },
  ready: {
    healthDegraded: [{ to: 'degraded' }],
    recoverySignal: [{ to: 'recovering' }],
    drainRequested: [{ to: 'draining' }],
    releaseRequested: [{ to: 'releasing' }],
  },
  degraded: {
    healthOk: [
      {
        to: 'ready',
        guard: (ctx) => flag(ctx, 'twoConsecutiveGoodHeartbeats'),
        guardName: 'two_good_heartbeats',
      },
    ],
    recoverySignal: [{ to: 'recovering' }],
    releaseRequested: [{ to: 'releasing' }],
  },
  recovering: {
    recovered: [
      {
        to: 'ready',
        guard: (ctx) => flag(ctx, 'framesFlowing'),
        guardName: 'rung_succeeded_frames_flowing',
      },
    ],
    ladderExhausted: [
      {
        to: 'failed',
        guard: (ctx) => !flag(ctx, 'rendererAnswers'),
        guardName: 'renderer_provably_dead',
      },
    ],
    ladderExhaustedButAlive: [
      {
        to: 'degraded',
        guard: (ctx) => flag(ctx, 'rendererAnswers'),
        guardName: 'renderer_answers',
      },
    ],
  },
  draining: {
    handoffComplete: [
      {
        to: 'releasing',
        guard: (ctx) => flag(ctx, 'allViewersMoved') && flag(ctx, 'newInstanceReady'),
        guardName: 'handoff_complete',
      },
    ],
    drainDeadline: [{ to: 'releasing' }],
    noViewers: [
      {
        to: 'releasing',
        guard: (ctx) => flag(ctx, 'lastViewerLeftDuringDrain'),
        guardName: 'last_viewer_left',
      },
    ],
    // Drain is not cancellable in v1: a health-ok signal during drain is a no-op, not a state change.
    healthOk: [{ to: 'draining', guard: () => false, guardName: 'drain_not_cancellable' }],
  },
  releasing: {
    processGone: [
      {
        to: 'released',
        guard: (ctx) => flag(ctx, 'profileLeaseReleased'),
        guardName: 'process_gone',
      },
    ],
    killTimeout: [{ to: 'released' }],
  },
  failed: {
    retry: [
      { to: 'requested', guard: (ctx) => flag(ctx, 'sameRequestId'), guardName: 'same_request_id' },
    ],
  },
};

// ── Session ─────────────────────────────────────────────────────────────

/** Events the `Session` machine accepts. */
export type SessionEvent =
  | 'provisioned'
  | 'provisionFailed'
  | 'viewerAttached'
  | 'lastViewerLeft'
  | 'idleTimerFired'
  | 'instanceRecovering'
  | 'maxDurationFired'
  | 'graceTimerFired'
  | 'recovered'
  | 'unrecoverable'
  | 'instanceReleased'
  | 'shutdown';

/** The `Session` transition table. */
export const SESSION_TRANSITIONS: TransitionTable<SessionState, SessionEvent> = {
  provisioning: {
    provisioned: [
      {
        to: 'live',
        guard: (ctx) => flag(ctx, 'targetRegistryPopulated'),
        guardName: 'targets_populated',
      },
    ],
    provisionFailed: [{ to: 'ended' }],
  },
  live: {
    viewerAttached: [{ to: 'live' }],
    lastViewerLeft: [
      { to: 'live', guard: (ctx) => flag(ctx, 'zeroViewers'), guardName: 'zero_viewers' },
    ],
    idleTimerFired: [
      { to: 'idle', guard: (ctx) => flag(ctx, 'zeroViewers'), guardName: 'zero_viewers' },
    ],
    instanceRecovering: [{ to: 'recovering' }],
    maxDurationFired: [{ to: 'ended' }],
    instanceReleased: [{ to: 'ended' }],
    shutdown: [{ to: 'ended' }],
  },
  idle: {
    viewerAttached: [{ to: 'live' }],
    graceTimerFired: [
      { to: 'ended', guard: (ctx) => flag(ctx, 'zeroViewers'), guardName: 'zero_viewers' },
    ],
    instanceRecovering: [{ to: 'recovering' }],
    instanceReleased: [{ to: 'ended' }],
    shutdown: [{ to: 'ended' }],
  },
  recovering: {
    recovered: [
      {
        to: 'live',
        guard: (ctx) => flag(ctx, 'instanceReady'),
        guardName: 'instance_back_to_ready',
      },
    ],
    unrecoverable: [{ to: 'ended' }],
    instanceReleased: [{ to: 'ended' }],
    shutdown: [{ to: 'ended' }],
  },
  ended: {},
};

// ── Stream ──────────────────────────────────────────────────────────────

/** Events the `Stream` machine accepts. */
export type StreamEvent =
  | 'firstFrame'
  | 'firstFrameDeadline'
  | 'attachFailed'
  | 'lastAttachmentRemoved'
  | 'frameSilence'
  | 'qualityChanged'
  | 'attachmentAdded'
  | 'pauseTimeout'
  | 'frameArrived'
  | 'stallEscalation'
  | 'targetCrashed'
  | 'unsubscribeAll';

/** The `Stream` transition table. */
export const STREAM_TRANSITIONS: TransitionTable<StreamState, StreamEvent> = {
  starting: {
    firstFrame: [{ to: 'live' }],
    firstFrameDeadline: [
      {
        to: 'live',
        guard: (ctx) => flag(ctx, 'noFrameWithinDeadline'),
        guardName: 'first_frame_deadline',
      },
    ],
    attachFailed: [{ to: 'stopped' }],
    unsubscribeAll: [{ to: 'stopped' }],
  },
  live: {
    lastAttachmentRemoved: [
      { to: 'paused', guard: (ctx) => flag(ctx, 'zeroAttachments'), guardName: 'zero_attachments' },
    ],
    frameSilence: [
      {
        to: 'stalled',
        guard: (ctx) => flag(ctx, 'pageLoading'),
        guardName: 'silence_while_loading',
      },
    ],
    qualityChanged: [{ to: 'live' }],
    unsubscribeAll: [{ to: 'stopped' }],
  },
  paused: {
    attachmentAdded: [{ to: 'starting' }],
    pauseTimeout: [
      { to: 'stopped', guard: (ctx) => flag(ctx, 'pausedTtlElapsed'), guardName: 'paused_ttl' },
    ],
    unsubscribeAll: [{ to: 'stopped' }],
  },
  stalled: {
    frameArrived: [{ to: 'live' }],
    stallEscalation: [
      {
        to: 'stalled',
        guard: (ctx) => flag(ctx, 'stallEscalateMsElapsed'),
        guardName: 'stall_escalate',
      },
    ],
    targetCrashed: [{ to: 'stopped' }],
    unsubscribeAll: [{ to: 'stopped' }],
  },
  stopped: {},
};

// ── Viewer ──────────────────────────────────────────────────────────────

/** Events the `Viewer` machine accepts. */
export type ViewerEvent =
  | 'ticketValid'
  | 'ticketInvalid'
  | 'helloReceived'
  | 'versionUnsupported'
  | 'handshakeTimeout'
  | 'subscribe'
  | 'unsubscribe'
  | 'socketClosed'
  | 'kicked'
  | 'slowConsumer'
  | 'tokenExpired'
  | 'resumeAttempt'
  | 'resumeWindowExpired'
  | 'resumeAccepted'
  | 'resumeRejected'
  | 'replacedBySameSubject';

/** The `Viewer` transition table. */
export const VIEWER_TRANSITIONS: TransitionTable<ViewerState, ViewerEvent> = {
  connecting: {
    ticketValid: [
      {
        to: 'handshaking',
        guard: (ctx) => flag(ctx, 'ticketChecksPass'),
        guardName: 'ticket_checks_pass',
      },
    ],
    ticketInvalid: [{ to: 'expired' }],
  },
  handshaking: {
    helloReceived: [
      {
        to: 'attached',
        guard: (ctx) => flag(ctx, 'versionNegotiable'),
        guardName: 'version_negotiable',
      },
    ],
    versionUnsupported: [{ to: 'expired' }],
    handshakeTimeout: [{ to: 'expired' }],
  },
  attached: {
    subscribe: [
      { to: 'attached', guard: (ctx) => flag(ctx, 'limitsPass'), guardName: 'limits_pass' },
    ],
    unsubscribe: [{ to: 'attached' }],
    socketClosed: [
      {
        to: 'disconnected',
        guard: (ctx) => flag(ctx, 'resumeWindowConfigured'),
        guardName: 'resume_window_configured',
      },
    ],
    kicked: [{ to: 'expired' }],
    slowConsumer: [
      {
        to: 'attached',
        guard: (ctx) => (ctx as Record<string, unknown>)['slowConsumerPolicy'] === 'downgrade',
        guardName: 'downgrade_policy',
      },
      {
        to: 'expired',
        guard: (ctx) => (ctx as Record<string, unknown>)['slowConsumerPolicy'] === 'close',
        guardName: 'close_policy',
      },
    ],
    tokenExpired: [{ to: 'expired' }],
    replacedBySameSubject: [
      {
        to: 'expired',
        guard: (ctx) => flag(ctx, 'singleSocketPerUser'),
        guardName: 'single_socket_per_user',
      },
    ],
  },
  disconnected: {
    resumeAttempt: [
      {
        to: 'resuming',
        guard: (ctx) => flag(ctx, 'resumeTokenValid'),
        guardName: 'resume_token_valid',
      },
    ],
    resumeWindowExpired: [{ to: 'expired' }],
  },
  resuming: {
    resumeAccepted: [
      {
        to: 'attached',
        guard: (ctx) => flag(ctx, 'sessionStillLive') && flag(ctx, 'subsStillValid'),
        guardName: 'resume_accepted',
      },
    ],
    resumeRejected: [{ to: 'expired' }],
  },
  expired: {},
};

// ── ControlLease ────────────────────────────────────────────────────────

/** Events the `ControlLease` machine accepts. */
export type ControlLeaseEvent =
  | 'requested'
  | 'targetGone'
  | 'requestedByOther'
  | 'input'
  | 'renewRequested'
  | 'renewOk'
  | 'renewDenied'
  | 'expiryApproaching'
  | 'deadline'
  | 'released'
  | 'holderDisconnectedPastResume'
  | 'preempt'
  | 'requeue'
  | 'sessionEnding';

/**
 * The `ControlLease` transition table. `unheld` and the `requested`
 * post-terminal reissue are handled by callers, since which target's lease
 * to construct next is a queue decision, not a pure state edge; this table
 * covers the states of one lease instance, on the understanding that
 * `revoked`/`forceClaimed` are terminal for that lease instance while the
 * target's control continues under a new lease object.
 */
export const CONTROL_LEASE_TRANSITIONS: TransitionTable<ControlLeaseState, ControlLeaseEvent> = {
  unheld: {
    requested: [
      {
        to: 'requested',
        guard: (ctx) => flag(ctx, 'hasControlCap') && flag(ctx, 'queueEmpty'),
        guardName: 'queue_empty',
      },
      {
        to: 'unheld',
        guard: (ctx) => flag(ctx, 'hasControlCap') && !flag(ctx, 'queueEmpty'),
        guardName: 'queued_behind_others',
      },
    ],
  },
  requested: {
    requestedByOther: [{ to: 'requested' }],
    targetGone: [{ to: 'unheld' }],
    // `grant` reuses the `requested` event's success path in the wire
    // layer; represented here as the same event resolving to `granted`
    // once the target exists and has not crashed.
    input: [
      { to: 'granted', guard: (ctx) => flag(ctx, 'targetExistsNotCrashed'), guardName: 'grant' },
    ],
  },
  granted: {
    requestedByOther: [{ to: 'granted' }],
    input: [
      {
        to: 'granted',
        guard: (ctx) => flag(ctx, 'rateLimitPasses'),
        guardName: 'rate_limit_passes',
      },
    ],
    renewRequested: [
      { to: 'renewing', guard: (ctx) => flag(ctx, 'nearExpiry'), guardName: 'near_expiry' },
    ],
    expiryApproaching: [
      {
        to: 'expiring',
        guard: (ctx) => flag(ctx, 'nearExpiryNoRenew'),
        guardName: 'near_expiry_no_renew',
      },
    ],
    released: [
      { to: 'revoked', guard: (ctx) => flag(ctx, 'leaseIdMatches'), guardName: 'lease_id_matches' },
    ],
    holderDisconnectedPastResume: [{ to: 'revoked' }],
    preempt: [
      {
        to: 'forceClaimed',
        guard: (ctx) => flag(ctx, 'forceClaimAllowed'),
        guardName: 'force_claim_allowed',
      },
    ],
  },
  renewing: {
    renewOk: [
      {
        to: 'granted',
        guard: (ctx) => flag(ctx, 'holderStillConnectedAndCapable'),
        guardName: 'renew_ok',
      },
    ],
    renewDenied: [
      {
        to: 'revoked',
        guard: (ctx) => flag(ctx, 'capabilityRevoked'),
        guardName: 'capability_lost',
      },
    ],
  },
  expiring: {
    renewRequested: [{ to: 'renewing' }],
    input: [{ to: 'granted' }],
    deadline: [{ to: 'revoked', guard: (ctx) => flag(ctx, 'nowPastExpiry'), guardName: 'expired' }],
    released: [
      { to: 'revoked', guard: (ctx) => flag(ctx, 'leaseIdMatches'), guardName: 'lease_id_matches' },
    ],
    holderDisconnectedPastResume: [{ to: 'revoked' }],
    preempt: [
      {
        to: 'forceClaimed',
        guard: (ctx) => flag(ctx, 'forceClaimAllowed'),
        guardName: 'force_claim_allowed',
      },
    ],
  },
  revoked: {},
  forceClaimed: {},
};

// ── Profile ─────────────────────────────────────────────────────────────

/** Events the `Profile` machine accepts. */
export type ProfileEvent =
  | 'materialised'
  | 'createFailed'
  | 'lease'
  | 'renew'
  | 'renewMissed'
  | 'release'
  | 'snapshotRequest'
  | 'snapshotDone'
  | 'snapshotFailed'
  | 'migrate'
  | 'migrateDone'
  | 'migrateFailed'
  | 'checkPassed'
  | 'checkFailed'
  | 'delete'
  | 'deleteDone'
  | 'deleteFailed';

/** The `Profile` transition table. */
export const PROFILE_TRANSITIONS: TransitionTable<ProfileState, ProfileEvent> = {
  creating: {
    materialised: [
      { to: 'free', guard: (ctx) => flag(ctx, 'metaWritten'), guardName: 'materialised' },
    ],
    createFailed: [
      {
        to: 'deleted',
        guard: (ctx) => flag(ctx, 'materialiseError') || flag(ctx, 'createTimeoutElapsed'),
        guardName: 'create_failed',
      },
    ],
  },
  free: {
    lease: [
      {
        to: 'leased',
        guard: (ctx) =>
          !flag(ctx, 'currentlyLeased') && flag(ctx, 'nodeReady') && !flag(ctx, 'profileExpired'),
        guardName: 'leasable',
      },
      { to: 'free', guard: (ctx) => flag(ctx, 'profileExpired'), guardName: 'profile_expired' },
    ],
    migrate: [
      {
        to: 'migrating',
        guard: (ctx) => flag(ctx, 'targetNodeHasSpace'),
        guardName: 'target_node_has_space',
      },
    ],
    delete: [{ to: 'deleting' }],
  },
  leased: {
    renew: [
      {
        to: 'leased',
        guard: (ctx) => flag(ctx, 'holderAndFenceMatch'),
        guardName: 'holder_and_fence_match',
      },
    ],
    renewMissed: [
      { to: 'quarantined', guard: (ctx) => flag(ctx, 'expiryPassed'), guardName: 'renew_missed' },
    ],
    release: [
      {
        to: 'free',
        guard: (ctx) => flag(ctx, 'fenceMatches') && flag(ctx, 'releasingCleanly'),
        guardName: 'clean_release',
      },
    ],
    snapshotRequest: [{ to: 'snapshotting' }],
  },
  snapshotting: {
    snapshotDone: [{ to: 'leased' }],
    snapshotFailed: [{ to: 'leased' }],
  },
  migrating: {
    migrateDone: [
      { to: 'free', guard: (ctx) => flag(ctx, 'checksumMatches'), guardName: 'checksum_matches' },
    ],
    migrateFailed: [{ to: 'quarantined' }],
  },
  quarantined: {
    checkPassed: [
      {
        to: 'free',
        guard: (ctx) => flag(ctx, 'consistencyCheckClean') && !flag(ctx, 'liveHolderFound'),
        guardName: 'check_passed',
      },
    ],
    checkFailed: [{ to: 'quarantined', guard: () => true, guardName: 'check_failed' }],
    delete: [{ to: 'deleting' }],
  },
  deleting: {
    deleteDone: [
      { to: 'deleted', guard: (ctx) => flag(ctx, 'directoryGone'), guardName: 'directory_gone' },
    ],
    deleteFailed: [{ to: 'deleting', guard: () => true, guardName: 'delete_failed_retry' }],
  },
  deleted: {},
};
