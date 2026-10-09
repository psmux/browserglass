/**
 * `createCdpRecoveryTarget`: the real, CDP-backed implementation of the
 * recovery module's `RecoveryTarget` seam (`../recovery/types.js`), wiring
 * `CdpBridge` and `TargetRegistry` (`../cdp/**`) together with whichever
 * `FrameSource` (`../stream/**`) currently backs the target into the four
 * automatic rungs plus the confirmation probe. `../recovery/runner.ts` stays
 * fully decoupled from CDP (testable with a plain object), and this module
 * is the one adapter that makes a rung actually talk to Chrome.
 *
 * At most one target per Chrome window ever produces continuous live
 * screencast frames; every other subscribed target gets a `ScreenshotPollSource`
 * instead. This module never assumes which kind of `FrameSource` a target
 * currently has: R0/R1/R3 restart whatever `capture()` returns by calling
 * its `stop()`/`start()` through {@link RecoveryCapture}, not a hardcoded
 * `Page.startScreencast`/`Page.stopScreencast` pair. `TargetActivationPolicy`
 * (`./target-activation.ts`) is the piece that actually decides, per target,
 * which `FrameSource` kind is current; this module only ever restarts it.
 */

import type { TargetId } from '@browserglass/protocol';
import type { CdpBridge } from '../cdp/bridge.js';
import type { TargetRegistry } from '../cdp/target-registry.js';
import type { CdpSessionId } from '../cdp/types.js';
import type { RecoveryTarget } from '../recovery/types.js';
import { RendererProbe } from '../stream/renderer-probe.js';
import type { FrameSource } from '../stream/types.js';

/**
 * The capture-management surface a rung needs from Session, decoupled from
 * whether the current `FrameSource` is a `CdpScreencastSource` (the active
 * target) or a `ScreenshotPollSource` (every other subscribed target).
 * Session (`./session.ts`, via `TargetActivationPolicy`) is the one
 * caller that knows which kind belongs on which target.
 */
export interface RecoveryCapture {
  /** The target's current `FrameSource`, or `null` if it has none (not currently subscribed by any viewer). */
  current(): FrameSource | null;
  /**
   * Builds and starts a fresh `FrameSource` of whatever kind this target
   * currently deserves (screencast if it is the active target, poll
   * otherwise) on `sessionId`, replacing whatever `current()` returns
   * afterward. Resolves the new source once `start()` has completed.
   */
  rebuild(sessionId: CdpSessionId): Promise<FrameSource>;
}

/** Constructor options for {@link createCdpRecoveryTarget}. */
export interface CdpRecoveryTargetOptions {
  readonly targetId: TargetId;
  readonly bridge: CdpBridge;
  readonly registry: TargetRegistry;
  readonly capture: RecoveryCapture;
  /** `Page.reload`'s wait budget. Default 8000ms. */
  readonly reloadTimeoutMs?: number;
}

const REACHABLE_SESSION_TIMEOUT_MS = 5000;

/**
 * Builds a `RecoveryTarget` for one CDP target. Every rung is best effort:
 * a thrown `CdpError` (a gone session, a closed bridge, a target that no
 * longer exists) resolves the rung `false` rather than rejecting, which is
 * what lets `RecoveryRunner`'s "a rung failure proceeds to the next rung"
 * property hold without every rung re-implementing its own try/catch.
 */
export function createCdpRecoveryTarget(opts: CdpRecoveryTargetOptions): RecoveryTarget {
  const { targetId, bridge, registry, capture } = opts;
  const reloadTimeoutMs = opts.reloadTimeoutMs ?? 8000;
  const probe = new RendererProbe({ targetId });

  function currentSessionId(): CdpSessionId | null {
    const target = registry.get(targetId);
    return (target?.cdpSessionId as CdpSessionId | null) ?? null;
  }

  async function forceFrame(): Promise<boolean> {
    const source = capture.current();
    if (!source) return false;
    return source.forceFrame().catch(() => false);
  }

  async function restartScreencast(): Promise<boolean> {
    const sessionId = currentSessionId();
    const source = capture.current();
    if (!sessionId || !source) return false;
    try {
      await source.stop().catch(() => undefined);
      await capture.rebuild(sessionId);
      await forceFrame();
      return true;
    } catch {
      return false;
    }
  }

  async function reattachSession(): Promise<boolean> {
    try {
      const oldSource = capture.current();
      await oldSource?.stop().catch(() => undefined);
      await registry.detach(targetId).catch(() => undefined);
      const handle = await registry.attach(targetId);
      await capture.rebuild(handle.id);
      await forceFrame();
      return true;
    } catch {
      return false;
    }
  }

  async function reloadPage(): Promise<boolean> {
    const sessionId = currentSessionId();
    if (!sessionId) return false;
    let dialogUnsub: (() => void) | null = null;
    try {
      // Auto-accept a `beforeunload` dialog within the reload budget, so an
      // unattended dialog does not stall the reload for the full timeout.
      dialogUnsub = bridge.on(
        'Page.javascriptDialogOpening',
        () => {
          bridge.sendNoReply('Page.handleJavaScriptDialog', { accept: true }, sessionId);
        },
        sessionId,
      );

      const loadEventPromise = new Promise<void>((resolve) => {
        const unsub = bridge.on(
          'Page.loadEventFired',
          () => {
            unsub();
            resolve();
          },
          sessionId,
        );
      });

      await bridge.send('Page.reload', {}, sessionId, { timeoutMs: reloadTimeoutMs });

      const timedOut = await Promise.race([
        loadEventPromise.then(() => false),
        new Promise<boolean>((resolve) => {
          bridge.sendNoReply('Runtime.evaluate', { expression: '1' }, sessionId); // keeps the socket busy; the real deadline is the setTimeout below.
          setTimeout(() => resolve(true), reloadTimeoutMs);
        }),
      ]);

      const oldSource = capture.current();
      await oldSource?.stop().catch(() => undefined);
      await capture.rebuild(sessionId);
      await forceFrame();
      return !timedOut;
    } catch {
      return false;
    } finally {
      dialogUnsub?.();
    }
  }

  async function recreateTarget(url: string | null): Promise<boolean> {
    try {
      const oldSource = capture.current();
      await oldSource?.stop().catch(() => undefined);
      await registry.close(targetId).catch(() => undefined);
      const created = await registry.create({ url: url ?? 'about:blank' });
      const handle = await registry.attach(created.id);
      await capture.rebuild(handle.id);
      await forceFrame();
      return true;
    } catch {
      return false;
    }
  }

  async function probeHung(): Promise<boolean> {
    const sessionId = currentSessionId();
    if (!sessionId) return true;
    return probe.confirmHung(() =>
      bridge.send('Runtime.evaluate', { expression: '1', returnByValue: true }, sessionId, {
        timeoutMs: REACHABLE_SESSION_TIMEOUT_MS,
      }),
    );
  }

  function currentUrl(): string | null {
    return registry.get(targetId)?.url ?? null;
  }

  return {
    targetId,
    restartScreencast,
    reattachSession,
    reloadPage,
    recreateTarget,
    forceFrame,
    probeHung,
    currentUrl,
  };
}
