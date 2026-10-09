/**
 * Shared types for `@browserglass/core`'s session module: the effect union
 * `Session`/`Viewer` produce (control lease wire messages, recovery
 * progress, session lifecycle notices, and viewer close requests), and the
 * timing constants for idle, lifetime, and busy suppression.
 *
 * Two session-lifecycle wire messages (`session.expiring`, carrying the
 * warnings-before-enforcement this module's idle/lifetime timers require,
 * and `session.draining`) have no `@browserglass/protocol` type yet.
 * `SessionNotice` below is this module's own, locally-typed stand-in,
 * carried through `Session`'s `onEffect` callback; the WebSocket transport
 * layer is expected to either add real wire types for these two and map
 * this shape onto them, or fold their fields into `@browserglass/protocol`'s
 * existing `Welcome.notices`/`error{fatal:false}` channel.
 */

import type { Capability } from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { LeaseEffect } from '../control/types.js';
import type { DiagnosticsSink } from '../diagnostics/index.js';
import type { DownloadSink } from '../downloads/index.js';
import type { InputSignal } from '../input/dispatcher.js';
import type {
  RecoveredEvent,
  RecoveryProgressEvent,
  UnrecoverableEvent,
} from '../recovery/types.js';

/**
 * The four `SessionEffect` diagnostics payload shapes below are read off
 * `DiagnosticsSink`'s own method signatures (`../diagnostics/index.js`)
 * rather than given separate names of
 * their own here: `Session` never constructs one of these values, it only
 * forwards whatever `TargetDiagnostics` hands its sink, so deriving keeps
 * this file from drifting out of sync with whichever exact fields that
 * module ends up typing (`url`/`line`/`column` optionality in particular).
 */
type ConsoleEntryPayload = Parameters<DiagnosticsSink['onConsole']>[0];
type PageErrorPayload = Parameters<DiagnosticsSink['onPageError']>[0];
type NetworkRequestPayload = Parameters<DiagnosticsSink['onNetworkRequest']>[0];
type NetworkSummaryPayload = Parameters<DiagnosticsSink['onNetworkSummary']>[0];

/**
 * The four `SessionEffect` download payload shapes below are read off
 * `DownloadSink`'s own method signatures (`../downloads/index.js`) for the
 * same reason the diagnostics ones above are: `Session` never constructs
 * one, it only forwards whatever `DownloadBridge` hands its sink.
 */
type DownloadStartedPayload = Parameters<DownloadSink['onDownloadStarted']>[0];
type DownloadProgressPayload = Parameters<DownloadSink['onDownloadProgress']>[0];
type DownloadCompletedPayload = Parameters<DownloadSink['onDownloadCompleted']>[0];
type DownloadFailedPayload = Parameters<DownloadSink['onDownloadFailed']>[0];

/** Idle, lifetime, and busy-suppression timing. */
export interface SessionLifetimeTiming {
  /** Time since last activity before the idle timer fires. Default 1200000 (20 min). */
  readonly idleTimeoutMs: number;
  /** After the idle timer fires, before the session actually ends; cancelled by any activity. Default 300000 (5 min). */
  readonly idleGraceMs: number;
  /** Wall clock since session start, regardless of activity. Default 28800000 (8 hours). */
  readonly maxDurationMs: number;
  /** Since the last Viewer detached, with no automation active. Default 120000 (2 min). */
  readonly noViewerTimeoutMs: number;
  /** Caps a single `session.busy` declaration. Default 300000 (5 min). */
  readonly maxBusyMs: number;
  /** Idle warning lead times before grace ends. */
  readonly idleWarningLeadMs: readonly number[];
  /** Max-duration warning lead times. */
  readonly maxDurationWarningLeadMs: readonly number[];
}

/** The default {@link SessionLifetimeTiming}. */
export const DEFAULT_SESSION_LIFETIME_TIMING: SessionLifetimeTiming = Object.freeze({
  idleTimeoutMs: 1_200_000,
  idleGraceMs: 300_000,
  maxDurationMs: 28_800_000,
  noViewerTimeoutMs: 120_000,
  maxBusyMs: 300_000,
  idleWarningLeadMs: Object.freeze([120_000, 30_000]),
  maxDurationWarningLeadMs: Object.freeze([900_000, 300_000, 60_000]),
});

/** This module's local stand-in for a `session.expiring`/`session.draining` wire notice; see the module doc. */
export type SessionNotice =
  | {
      readonly kind: 'session.expiring';
      readonly reason: 'idle' | 'max-duration' | 'no-viewer';
      readonly inMs: number;
      readonly canExtend: boolean;
      readonly extendedCount: number;
      readonly maxExtensions: number;
    }
  | {
      readonly kind: 'session.draining';
      readonly reason: 'server-shutdown' | 'node-drain';
      readonly deadlineMs: number;
      readonly willRelocate: boolean;
    }
  | {
      readonly kind: 'stream.rebound';
      readonly streamId: number;
      readonly oldTargetId: string;
      readonly newTargetId: string;
      readonly gen: number;
    };

/**
 * One `targetId` rebind produced by a successful `R4` restart: the old
 * target (from the terminated browser) mapped to its best-effort successor
 * (from the freshly launched one). `Session.restartInstance()` pairs old
 * and new targets positionally (capture keeps this to one live screencast
 * target, so the common case is a single pair); a caller (`ManagedSession`) uses this to move an
 * existing stream subscription onto the new target id without the viewer
 * ever re-issuing `stream.subscribe`.
 */
export interface InstanceTargetRebind {
  readonly oldTargetId: string;
  readonly newTargetId: string;
}

/**
 * `R4` (`instance.restart`, manual only)'s result,
 * carried through `onEffect` once `restartInstanceExecutor` (or its
 * default, never-succeeds stand-in) resolves. `ok: true` carries the fresh
 * `CdpBridge`/`TargetRegistry` `Session` itself already swapped in
 * (`restartInstance()`'s `applyRebind`), so a transport layer that also
 * holds its own direct reference to the pre-restart pair (`ManagedSession`
 * does, for `navigate`/`capture`/`probe`/etc.) can swap them in too, rather
 * than keep issuing CDP commands against a bridge whose WebSocket the
 * terminated browser process closed out from under it.
 */
export type InstanceRestartResult =
  | {
      readonly ok: true;
      readonly durationMs: number;
      readonly bridge: CdpBridge;
      readonly registry: TargetRegistry;
      readonly targetRebinds: readonly InstanceTargetRebind[];
      /** Old target ids with no successor in the freshly launched browser (more targets existed before than after); their streams are gone, not rebound. */
      readonly targetsLost: readonly string[];
    }
  | { readonly ok: false; readonly durationMs: number };

/** Every effect `Session`/`Viewer` produce, for a transport layer to consume. */
export type SessionEffect =
  | { readonly kind: 'lease'; readonly targetId: string; readonly effect: LeaseEffect }
  | { readonly kind: 'recovery.progress'; readonly event: RecoveryProgressEvent }
  | { readonly kind: 'recovery.recovered'; readonly event: RecoveredEvent }
  | { readonly kind: 'recovery.unrecoverable'; readonly event: UnrecoverableEvent }
  | { readonly kind: 'notice'; readonly notice: SessionNotice }
  | {
      readonly kind: 'close_viewer';
      readonly viewerId: string;
      readonly code: number;
      readonly reason: string;
    }
  | { readonly kind: 'close_all_viewers'; readonly code: number; readonly reason: string }
  /** `R4` started: one attempt, manual only. See {@link InstanceRestartResult}. */
  | { readonly kind: 'instance.restart.progress'; readonly attempt: number }
  | { readonly kind: 'instance.restart.result'; readonly result: InstanceRestartResult }
  /**
   * One `TargetDiagnostics` sink callback for `targetId`, forwarded
   * verbatim. `Session` adds no
   * `targetId` field of its own to the payload here since one collector is
   * scoped to exactly one target and none of `DiagnosticsSink`'s four
   * methods carry it; a transport layer (`ManagedSession`) needs it to
   * decide which subscribed, `devtools`-holding viewers to fan the resulting
   * wire message out to, so this is where it gets attached.
   */
  | {
      readonly kind: 'diagnostics.console';
      readonly targetId: string;
      readonly entry: ConsoleEntryPayload;
    }
  | {
      readonly kind: 'diagnostics.pageError';
      readonly targetId: string;
      readonly entry: PageErrorPayload;
    }
  | {
      readonly kind: 'diagnostics.networkRequest';
      readonly targetId: string;
      readonly entry: NetworkRequestPayload;
    }
  | {
      readonly kind: 'diagnostics.networkSummary';
      readonly targetId: string;
      readonly entry: NetworkSummaryPayload;
    }
  /**
   * One `DownloadBridge` sink callback for `targetId`, forwarded verbatim,
   * mirroring the four `diagnostics.*` variants immediately above in every
   * respect (including why `targetId` is attached here rather than by the
   * payload itself). `ManagedSession` is the one that turns
   * `download.completed` into a hashed file, a signed URL, and a call to
   * the `onDownload` hook (`packages/server/src/hooks/types.ts`); `Session`
   * only relays what `DownloadBridge` observed.
   */
  | {
      readonly kind: 'download.started';
      readonly targetId: string;
      readonly entry: DownloadStartedPayload;
    }
  | {
      readonly kind: 'download.progress';
      readonly targetId: string;
      readonly entry: DownloadProgressPayload;
    }
  | {
      readonly kind: 'download.completed';
      readonly targetId: string;
      readonly entry: DownloadCompletedPayload;
    }
  | {
      readonly kind: 'download.failed';
      readonly targetId: string;
      readonly entry: DownloadFailedPayload;
    }
  /**
   * One `InputDispatcher` outcome that did not reach CDP: a stale
   * generation, a denied lease fence, a shed move, a malformed message, a
   * rate limit, or a CDP dispatch failure.
   *
   * This exists because the alternative was silence. `InputDispatcher`
   * reported every one of these through `onSignal`, and `Session` wired
   * `onSignal` to an empty function with a note saying the wire layer would
   * pick them up later. It never did, because nothing told it they existed,
   * so a dropped input produced no error reply, no wire traffic and no log
   * line anywhere in the system, and `bgls.error.input.gen_stale` sat in the
   * error registry having never been emitted by anything. Three separate
   * defects that stopped automation input dead were invisible for exactly
   * this reason.
   *
   * Routed through `SessionEffect` rather than through a second
   * `onSignal` option on `SessionOptions`, because the transport already
   * consumes this channel for every other thing `core` needs to tell it, and
   * a second parallel channel is how one of them stays unwired.
   */
  | { readonly kind: 'input.signal'; readonly targetId: string; readonly signal: InputSignal };

/** One viewer's identity as `Session`/the control lease engine need it. Mirrors `../control/types.ts`'s `ViewerRef`. */
export interface SessionViewerIdentity {
  readonly viewerId: string;
  readonly identity: string;
  readonly label: string;
  readonly kind: 'human' | 'agent';
  readonly capabilities: readonly Capability[];
  readonly isAdmin: boolean;
}
