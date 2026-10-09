/**
 * `probeCdpIdentity`, exported for the runtime adapters (`runtime-host`,
 * `runtime-remote`) to confirm they are talking to the Chrome they think
 * they are, before ever opening the multiplexed `CdpBridge` socket.
 */

import { CdpError } from './errors.js';
import { type MinimalFetch, globalFetch, monotonicNow, scheduleTimer } from './platform.js';

/** Which invariant {@link probeCdpIdentity} is confirming. */
export type ProbeCdpIdentityMode = 'fresh' | 'reused' | 'adopt';

/** Options for {@link probeCdpIdentity}. */
export interface ProbeCdpIdentityOptions {
  /** The HTTP origin CDP's `/json/version` endpoint answers on, for example `http://127.0.0.1:9222`. */
  cdpUrl: string;
  mode: ProbeCdpIdentityMode;
  /** Required for `mode: 'reused'`: the probe succeeds once the observed GUID differs from this. */
  excludeBrowserGuid?: string;
  /** Required for `mode: 'adopt'`: the probe succeeds once the observed GUID matches this exactly. */
  expectBrowserGuid?: string;
  /** Overall budget across every attempt. Default 15000. */
  overallTimeoutMs?: number;
  /** Per request timeout. Default 2000. */
  perRequestTimeoutMs?: number;
  /** Delay between consecutive polls, and the window `mode: 'fresh'` requires stability across. Default 300. */
  pollIntervalMs?: number;
  /** Injectable for tests; defaults to the real global `fetch`. */
  fetchImpl?: MinimalFetch;
}

/** What one successful {@link probeCdpIdentity} confirms. */
export interface CdpIdentity {
  browserGuid: string;
  webSocketDebuggerUrl: string;
  raw: Readonly<Record<string, unknown>>;
}

/**
 * Thrown by {@link probeCdpIdentity} when its deadline is exhausted before
 * the invariant for its `mode` is confirmed. Carries the attempt count,
 * the last observed HTTP status, and whether any GUID was ever seen at
 * all.
 */
export class CdpProbeTimeoutError extends CdpError {
  readonly attempts: number;
  readonly lastHttpStatus: number | null;
  readonly anyGuidSeen: boolean;

  constructor(init: {
    attempts: number;
    lastHttpStatus: number | null;
    anyGuidSeen: boolean;
    elapsedMs: number;
  }) {
    super('E_CDP_TIMEOUT', {
      kind: 'timeout',
      retryable: true,
      elapsedMs: init.elapsedMs,
      message: `probeCdpIdentity exhausted its deadline after ${init.attempts} attempts, last HTTP status ${String(init.lastHttpStatus)}, GUID ever seen: ${String(init.anyGuidSeen)}`,
    });
    this.name = 'CdpProbeTimeoutError';
    this.attempts = init.attempts;
    this.lastHttpStatus = init.lastHttpStatus;
    this.anyGuidSeen = init.anyGuidSeen;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => scheduleTimer(resolve, ms));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = scheduleTimer(() => reject(new Error(`fetch timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => {
        timer.unref?.();
        resolve(v);
      },
      (e: unknown) => {
        timer.unref?.();
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function extractGuid(webSocketDebuggerUrl: string): string | null {
  const match = /\/browser\/([^/]+)$/.exec(webSocketDebuggerUrl);
  return match ? (match[1] as string) : null;
}

/**
 * Polls `GET <cdpUrl>/json/version` to confirm one identity invariant,
 * depending on `mode`:
 *
 * * `'fresh'`: the GUID observed is stable across two consecutive polls
 *   `pollIntervalMs` apart.
 * * `'reused'`: the GUID observed differs from `excludeBrowserGuid`, the
 *   stale CDP race guard for an endpoint that may still be answering for a
 *   previous browser.
 * * `'adopt'`: the GUID observed matches `expectBrowserGuid` exactly.
 *
 * Each request is bounded at `perRequestTimeoutMs` (default 2000). Once
 * `overallTimeoutMs` (default 15000) elapses without confirming the
 * invariant, throws {@link CdpProbeTimeoutError}.
 */
export async function probeCdpIdentity(opts: ProbeCdpIdentityOptions): Promise<CdpIdentity> {
  const fetchImpl = opts.fetchImpl ?? globalFetch();
  const perRequestTimeoutMs = opts.perRequestTimeoutMs ?? 2000;
  const pollIntervalMs = opts.pollIntervalMs ?? 300;
  const overallTimeoutMs = opts.overallTimeoutMs ?? 15000;
  const startedAt = monotonicNow();
  const deadline = startedAt + overallTimeoutMs;

  let attempts = 0;
  let lastHttpStatus: number | null = null;
  let anyGuidSeen = false;
  let previousGuid: string | null = null;

  while (monotonicNow() < deadline) {
    attempts += 1;
    let guid: string | null = null;
    let webSocketDebuggerUrl: string | null = null;
    let raw: Record<string, unknown> | null = null;

    try {
      const res = await withTimeout(fetchImpl(`${opts.cdpUrl}/json/version`), perRequestTimeoutMs);
      lastHttpStatus = res.status;
      if (res.ok) {
        raw = (await res.json()) as Record<string, unknown>;
        webSocketDebuggerUrl =
          typeof raw['webSocketDebuggerUrl'] === 'string'
            ? (raw['webSocketDebuggerUrl'] as string)
            : null;
        guid = webSocketDebuggerUrl ? extractGuid(webSocketDebuggerUrl) : null;
      }
    } catch {
      // Network error or per-request timeout on this attempt; retry until the overall deadline.
    }

    if (guid) {
      anyGuidSeen = true;
      if (opts.mode === 'adopt') {
        if (opts.expectBrowserGuid !== undefined && guid === opts.expectBrowserGuid) {
          return {
            browserGuid: guid,
            webSocketDebuggerUrl: webSocketDebuggerUrl as string,
            raw: raw ?? {},
          };
        }
      } else if (opts.mode === 'reused') {
        if (opts.excludeBrowserGuid !== undefined && guid !== opts.excludeBrowserGuid) {
          return {
            browserGuid: guid,
            webSocketDebuggerUrl: webSocketDebuggerUrl as string,
            raw: raw ?? {},
          };
        }
      } else {
        if (previousGuid !== null && previousGuid === guid) {
          return {
            browserGuid: guid,
            webSocketDebuggerUrl: webSocketDebuggerUrl as string,
            raw: raw ?? {},
          };
        }
        previousGuid = guid;
      }
    }

    if (monotonicNow() + pollIntervalMs >= deadline) {
      break;
    }
    await sleep(pollIntervalMs);
  }

  throw new CdpProbeTimeoutError({
    attempts,
    lastHttpStatus,
    anyGuidSeen,
    elapsedMs: monotonicNow() - startedAt,
  });
}
