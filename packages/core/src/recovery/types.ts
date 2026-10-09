/**
 * Shared types for `@browserglass/core`'s recovery ladder: the eight
 * detection signals, the signal to ladder dispatch table, and the per-rung
 * timeout table. The wire `RecoveryRung` stays
 * `R0` to `R6` (forward compatible), but this build only ever executes `R0`
 * to `R3` automatically. `R4` is exposed as a manual only entry point
 * (`instance.restart`); `R5` and `R6` are never reached by this package.
 */

import type { RecoveryRung } from '@browserglass/protocol';

/**
 * The eight signals the detection layer (frame staleness watchdog, CDP
 * lifecycle events, the renderer hang probe, and the router/node health
 * signals passed through unchanged) can raise.
 */
export type RecoverySignal =
  | 'screencast_silent'
  | 'cdp_detached'
  | 'renderer_hung'
  | 'target_crashed'
  | 'browser_dead'
  | 'profile_lease_lost'
  | 'node_lost'
  | 'disk_fatal';

/** Every {@link RecoverySignal}, for exhaustiveness checks and tests. */
export const RECOVERY_SIGNALS: readonly RecoverySignal[] = Object.freeze([
  'screencast_silent',
  'cdp_detached',
  'renderer_hung',
  'target_crashed',
  'browser_dead',
  'profile_lease_lost',
  'node_lost',
  'disk_fatal',
]);

/** The rungs this package can actually execute without crossing into router or runtime-host territory. */
export type AutomaticRung = 'R0' | 'R1' | 'R2' | 'R3';

/**
 * The full ladder per signal (the complete system's eventual R0 to R5
 * sequence). This build only ever
 * executes the automatic (`R0` to `R3`) prefix of whatever this function
 * returns; see {@link automaticLadderFor}.
 */
export function fullLadderFor(signal: RecoverySignal): RecoveryRung[] {
  switch (signal) {
    case 'screencast_silent':
      return ['R0', 'R1', 'R2', 'R3', 'R4', 'R5'];
    case 'cdp_detached':
      return ['R1', 'R2', 'R3', 'R4', 'R5'];
    case 'renderer_hung':
      return ['R2', 'R3', 'R4', 'R5'];
    case 'target_crashed':
      return ['R2', 'R3', 'R4', 'R5'];
    case 'browser_dead':
      return ['R4', 'R5'];
    case 'profile_lease_lost':
      return ['R5'];
    case 'node_lost':
      return ['R5'];
    case 'disk_fatal':
      return ['R5'];
  }
}

function isAutomaticRung(rung: RecoveryRung): rung is AutomaticRung {
  return rung === 'R0' || rung === 'R1' || rung === 'R2' || rung === 'R3';
}

/**
 * The prefix of {@link fullLadderFor}`(signal)` this package actually
 * executes automatically: every leading rung through `R3`, stopping at the
 * first rung this build does not run on its own (`R4` and beyond, manual
 * only). A signal whose full ladder starts beyond `R3`
 * (`browser_dead`, `profile_lease_lost`, `node_lost`, `disk_fatal`) has an
 * empty automatic ladder: the runner goes straight to the defensive probe.
 */
export function automaticLadderFor(signal: RecoverySignal): AutomaticRung[] {
  const rungs: AutomaticRung[] = [];
  for (const rung of fullLadderFor(signal)) {
    if (!isAutomaticRung(rung)) {
      break;
    }
    rungs.push(rung);
  }
  return rungs;
}

/** Per-rung timeout (R0: 3000ms, R1: 5000ms, R2: 10000ms, R3: 20000ms). */
export const RUNG_TIMEOUT_MS: Readonly<Record<AutomaticRung, number>> = Object.freeze({
  R0: 3000,
  R1: 5000,
  R2: 10000,
  R3: 20000,
});

/**
 * The signals a crash-loop (repeated recovery for the same underlying
 * defect, not a one-off) can plausibly present as: a page that crashes
 * every time it loads, or a renderer that hangs every time it is probed.
 * Only these consult the {@link import('./crash-budget.js').CrashBudget}
 * before running the ladder.
 */
export const CRASH_LOOP_SIGNALS: ReadonlySet<RecoverySignal> = Object.freeze(
  new Set<RecoverySignal>(['target_crashed', 'renderer_hung']),
);

/**
 * The minimal per-target capability the recovery runner needs, implemented
 * by whoever owns the real CDP session and target (`@browserglass/core`'s
 * `Session`, `packages/core/src/session/**`). Kept structural and narrow so
 * this module is fully unit testable with a plain object, no `CdpBridge` or
 * `TargetRegistry` required.
 */
export interface RecoveryTarget {
  readonly targetId: string;
  /** R0: `Page.stopScreencast` then `Page.startScreencast` on the same CDP session, then `forceFrame()`. */
  restartScreencast(): Promise<boolean>;
  /** R1: discard the current CDP session, `Target.attachToTarget` fresh, re-enable, re-subscribe screencast. */
  reattachSession(): Promise<boolean>;
  /** R2: `Page.reload({waitUntil:'domcontentloaded', timeout:8000})`, auto-accepting `beforeunload` within 2s. */
  reloadPage(): Promise<boolean>;
  /**
   * R3: best effort `Target.closeTarget`, `Target.createTarget` at `url`
   * (`null` means `about:blank`), re-attach, restart screencast.
   */
  recreateTarget(url: string | null): Promise<boolean>;
  /** One-shot forced frame; used to prove liveness after a successful rung and by the defensive probe's caller. */
  forceFrame(): Promise<boolean>;
  /**
   * The renderer hang confirmation probe (two independent `evaluate('1')`
   * attempts, 2500ms each, 500ms apart). Resolves `true` when still hung.
   * Used both as the entry probe for `renderer_hung` and as the defensive
   * probe run before declaring a target unrecoverable.
   */
  probeHung(): Promise<boolean>;
  /** The best known current URL, for R3's (and the crash budget's) restore-last-URL behaviour. `null` when unknown. */
  currentUrl(): string | null;
}

/** One rung's progress report, matching the wire shape of `instance.recovering` (`@browserglass/protocol`). */
export interface RecoveryProgressEvent {
  readonly targetId: string;
  readonly rung: RecoveryRung;
  readonly attempt: number;
  readonly of: number;
  readonly etaMs: number | null;
  readonly signal: RecoverySignal;
}

/** What a `RecoveryRunner.trigger()`/`restartInstance()` call resolved to. */
export type RecoveryOutcomeKind =
  | 'recovered'
  | 'exhausted_but_alive'
  | 'unrecoverable'
  | 'crash_budget_exceeded'
  | 'cancelled_by_input'
  | 'rederived_healthy'
  | 'rederived_unhealthy';

/** The result of one `trigger()`/`restartInstance()` call. */
export interface RecoveryOutcome {
  readonly kind: RecoveryOutcomeKind;
  readonly signal: RecoverySignal;
  readonly rung?: RecoveryRung;
}

/** Reported once a target is declared unrecoverable: every rung tried, plus the crash-budget conditions if consulted. */
export interface UnrecoverableEvent {
  readonly targetId: string;
  readonly signal: RecoverySignal;
  readonly triedRungs: readonly RecoveryRung[];
  readonly crashConditionsTried?: readonly import('./crash-budget.js').CrashCondition[];
}

/** Reported once a rung (or the defensive probe) confirms the target is live again. */
export interface RecoveredEvent {
  readonly targetId: string;
  readonly signal: RecoverySignal;
  readonly rung: RecoveryRung;
}

/**
 * Builds the human readable, close-reason-safe explanation for a `4004
 * Unrecoverable` close: what was tried, so the client's error panel (the
 * `R6` rung) can show it without the caller re-deriving the
 * sentence.
 */
export function buildUnrecoverableReason(evt: UnrecoverableEvent): string {
  const rungsPart =
    evt.triedRungs.length > 0
      ? `rungs ${evt.triedRungs.join(', ')}`
      : 'no automatic rungs available for this signal';
  const crashPart =
    evt.crashConditionsTried && evt.crashConditionsTried.length > 0
      ? `; crash budget exhausted after ${evt.crashConditionsTried.join(', ')}`
      : '';
  return `recovery for signal '${evt.signal}' exhausted (${rungsPart})${crashPart}`;
}
