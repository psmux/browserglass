import type { Envelope } from '../envelope.js';

/** The lifecycle state of a browser Instance, as seen by a viewer socket. */
export type InstanceState =
  | 'launching'
  | 'running'
  | 'recovering'
  | 'degraded'
  | 'releasing'
  | 'released'
  | 'failed';

/**
 * S to C: an Instance's lifecycle state changed. `welcome.instance` carries
 * the same shape of information inline on connect and that field is always
 * populated, but this standalone push has no emission site of its own in
 * packages/server/src yet.
 */
export interface InstanceStateMsg extends Envelope {
  t: 'instance.state';
  instanceId: string;
  state: InstanceState;
  reason?: string;
  since: number;
  engineVersion?: string;
  viewport?: { width: number; height: number; dpr: number };
}

/**
 * The recovery-ladder rung, R0 to R6. This build implements R0 to R3
 * automatically (watchdog-driven) and R4 manually only, via
 * `instance.restart`. R5 and R6 are typed and never emitted.
 */
export type RecoveryRung = 'R0' | 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

/** S to C: a recovery rung started running. */
export interface InstanceRecovering extends Envelope {
  t: 'instance.recovering';
  instanceId: string;
  rung: RecoveryRung;
  signal: 'no_frames' | 'renderer_hung' | 'cdp_dead' | 'process_gone' | 'oom' | 'manual';
  attempt: number;
  estimatedMs: number | null;
  message: string;
  /** Set when invoked by a viewer, not the watchdog. */
  requestedByLabel?: string;
  /** The viewer's reason, already sanitised (see `packages/server/src/wire/sanitize.ts`). */
  requestedReason?: string;
}

/** S to C: a recovery rung completed successfully. */
export interface InstanceRecovered extends Envelope {
  t: 'instance.recovered';
  instanceId: string;
  rung: RecoveryRung;
  durationMs: number;
  targetsPreserved: boolean;
  /** `streamId`s that survived. */
  streamsResubscribed: number[];
  /** `streamId`s whose target did not survive. */
  streamsLost: number[];
}

/**
 * C to S: a manual invocation of recovery rung R4, nothing else. Reuses
 * `instance.recovering`/`instance.recovered` with `rung:'R4'`,
 * `signal:'manual'`. Single-flight per instance: concurrent requests
 * collapse into one restart.
 */
export interface InstanceRestart extends Envelope {
  t: 'instance.restart';
  /** Named explicitly, so a restart can't land on the wrong instance. */
  instanceId: string;
  /** Capped at 200 bytes. */
  reason?: string;
  /** Default true. `false` wipes the profile directory and additionally requires `profile.write`. */
  preserveProfile?: boolean;
}

/**
 * S to C: the Instance is gone and this session with it. No emission site
 * in packages/server/src yet; the WS close code (4006,
 * `instance_released` in wire/close.ts) is how a viewer currently learns
 * this happened.
 */
export interface InstanceReleased extends Envelope {
  t: 'instance.released';
  instanceId: string;
  reason: 'idle' | 'max_duration' | 'app_request' | 'quota' | 'admin' | 'node_lost';
}

/**
 * S to C: a draining node moves a viewer without dropping it. Typed only,
 * not wired yet (single-node embedded never relocates).
 */
export interface InstanceRelocate extends Envelope {
  t: 'instance.relocate';
  instanceId: string;
  url: string;
  ticket: string;
  reason: 'drain' | 'rebalance' | 'node_lost';
  graceMs: number;
}
