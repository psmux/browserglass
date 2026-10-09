/**
 * `DownloadBridge`: relays one Target's downloads, driven directly by a
 * `CdpBridge` + `CdpSessionId`. No `Session` dependency, matching
 * `../diagnostics/target-diagnostics.ts`'s own split: `packages/server/src/session/managed-session.ts`
 * owns turning what this class emits into wire messages, capability
 * gating, hashing the finished bytes, minting a signed URL, and firing the
 * `onDownload` hook. This class's whole job is "what did Chrome tell us
 * about a download on this target", nothing more.
 *
 * Domain ownership: `Page.setDownloadBehavior` is the method this class
 * sends, on purpose, not `Browser.setDownloadBehavior`. Both exist in real
 * Chrome and both can turn on `eventsEnabled`, but they are not
 * interchangeable here:
 *
 *  - `Browser.setDownloadBehavior` is BROWSER (or `browserContextId`)
 *    scoped, not session scoped. It carries no `CdpSessionId` of its own to
 *    bind to a `CdpBridge.send(method, params, sessionId)` call the way
 *    every other per-target domain in this codebase does, and Chrome does
 *    not expose the `Browser` domain to a target-attached session at all
 *    (confirmed against real Chrome 151: sending it WITH a target session
 *    id errors; `Browser` methods only answer on the browser-level
 *    connection). A class built around it would have no session to
 *    `rebind()` and no honest way to say "this target's downloads are now
 *    off" versus "every target's are".
 *  - `Page.setDownloadBehavior` IS session scoped (deprecated in the CDP
 *    spec in favour of the `Browser` method, but still the only session
 *    scoped way to reach the same switch), which is exactly what this
 *    class needs to match `TargetDiagnostics`'s per-session enable/rebind
 *    model, and it is already the method this codebase's own
 *    `CdpBridge.probeFeatures()` uses to probe for the capability
 *    (`../cdp/bridge.ts`, the `'downloadEvents'` probe) at session-less
 *    connect time. This class is the first real caller of that probed
 *    capability.
 *
 * Despite the method living in the `Page` domain, the EVENTS it turns on
 * are still `Browser.downloadWillBegin`/`Browser.downloadProgress` (CDP
 * consolidated download events under `Browser` some versions ago and never
 * gave `Page` its own copy back); they arrive scoped to the session that
 * called `Page.setDownloadBehavior`, which is what makes listening for them
 * with `bridge.on(event, handler, this.sessionId)` (the same per-session
 * keying `TargetDiagnostics` and `RequestGate` both rely on) correct here.
 *
 * FILESYSTEM SAFETY (see also `packages/server/src/files/safe-name.ts`'s
 * module doc, the upload path's version of this argument): `behavior:
 * 'allowAndName'` is deliberate, not `'allow'`. `'allowAndName'` makes
 * Chrome itself rename the finished file to its own opaque `guid` inside
 * `downloadPath`, so the attacker-controlled `suggestedFilename` a hostile
 * page supplies (`Browser.downloadWillBegin`'s `suggestedFilename`, echoed
 * here as `suggestedName`) NEVER becomes a path component, not even
 * transiently on disk. `downloadPath` itself is never attacker reachable
 * either: it is `start()`'s `downloadPath` argument, supplied by
 * `Session.startDownloadCapture` from server side configuration, the same
 * trust boundary `UploadStore`'s own `root` sits behind.
 */

import type { CdpBridge } from '../cdp/bridge.js';
import type { CdpSessionId, Unsubscribe } from '../cdp/types.js';
import type { DownloadSink } from './types.js';

/**
 * Bound on downloads this collector is tracking between `downloadWillBegin`
 * and a terminal event (`completed`/`canceled`), mirroring
 * `target-diagnostics.ts`'s `MAX_PENDING_REQUESTS` and its reasoning
 * exactly: a page that starts many downloads and lets none of them finish
 * must not grow this map without bound for the life of the collector. Past
 * this many outstanding downloads the oldest (by insertion order) is
 * evicted and reported failed, rather than tracked forever.
 */
const MAX_PENDING_DOWNLOADS = 100;

/** One `downloadWillBegin` awaiting a terminal `downloadProgress`, keyed by CDP `guid`. */
interface PendingDownload {
  suggestedName: string;
}

/** Constructor options for {@link DownloadBridge}. */
export interface DownloadBridgeOptions {
  bridge: CdpBridge;
  sessionId: CdpSessionId;
  targetId: string;
  sink: DownloadSink;
}

export class DownloadBridge {
  readonly targetId: string;
  private readonly bridge: CdpBridge;
  private readonly sink: DownloadSink;

  private sessionId: CdpSessionId;
  private unsubs: Unsubscribe[] = [];
  private stopped = false;

  /** What `start()` was last asked to write into, so `rebind()` can re-apply it against a fresh session without the caller having to remember and re-supply it. `null` until `start()` has been called at least once. */
  private requestedDownloadPath: string | null = null;
  /** Whether `Page.setDownloadBehavior{eventsEnabled:true}` is currently believed to be armed on `this.sessionId`, the one-member `enabledDomains`-style flag `target-diagnostics.ts`'s module doc describes: this collector owns exactly one CDP switch, so a `Set` would carry a single element for no benefit a `boolean` does not already give it. */
  private enabled = false;

  private readonly pending = new Map<string, PendingDownload>();

  constructor(opts: DownloadBridgeOptions) {
    this.bridge = opts.bridge;
    this.sessionId = opts.sessionId;
    this.targetId = opts.targetId;
    this.sink = opts.sink;
    this.subscribeListeners();
  }

  /** Whether download capture is actually armed right now (not merely requested): honest even when the underlying `Page.setDownloadBehavior` call failed. */
  get armed(): boolean {
    return this.enabled;
  }

  /**
   * Arms download capture for this target, writing completed files into
   * `downloadPath` (a directory the caller owns; see the module doc).
   * Idempotent: calling it again with the same path re-sends nothing.
   */
  async start(downloadPath: string): Promise<void> {
    if (this.stopped) throw new Error('DownloadBridge: cannot start after stop()');
    this.requestedDownloadPath = downloadPath;
    if (this.enabled) return;
    await this.tryEnable(downloadPath);
  }

  /**
   * Re-establishes this collector against a new `CdpSessionId` for the same
   * target, after a cross-origin navigation (or any other renderer swap)
   * killed the old session, mirroring `TargetDiagnostics.rebind()` exactly
   * (see its doc for the full argument on why the session, not the target,
   * owns every CDP domain enable and event subscription this class makes).
   *
   * Every download still `pending` at the moment of the swap is reported
   * `onDownloadFailed` first, with reason `'session_rebound'`, rather than
   * silently forgotten. Chrome does not carry `downloadProgress` across a
   * session swap for a download that started under the dead renderer any
   * more than `target-diagnostics.ts` found it carries `Network.*`
   * correlation, so a caller waiting on that download's `download.ready`
   * would otherwise wait forever with nothing in any log to explain why.
   * A no-op if `sessionId` is already the current one.
   */
  async rebind(sessionId: CdpSessionId): Promise<void> {
    if (this.stopped) throw new Error('DownloadBridge: cannot rebind after stop()');
    if (sessionId === this.sessionId) return;

    this.failAllPending('session_rebound');
    for (const u of this.unsubs) u();
    this.unsubs = [];
    this.enabled = false;

    this.sessionId = sessionId;
    this.subscribeListeners();
    if (this.requestedDownloadPath !== null) {
      await this.tryEnable(this.requestedDownloadPath);
    }
  }

  /**
   * Disarms download capture and drops every listener. Idempotent. Every
   * download still `pending` is reported `onDownloadFailed` first (reason
   * `'target_torn_down'`), for the same "never leave the caller hanging"
   * reason {@link rebind} does.
   */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;

    this.failAllPending('target_torn_down');
    for (const u of this.unsubs) u();
    this.unsubs = [];

    if (this.enabled) {
      this.enabled = false;
      await this.bridge
        .send(
          'Page.setDownloadBehavior',
          { behavior: 'default', eventsEnabled: false },
          this.sessionId,
        )
        .catch(() => {
          // The session may already be gone (target closed, renderer
          // swapped without a rebind ever landing); a disable that never
          // reaches the browser leaves nothing to clean up on this end
          // either way, matching `TargetDiagnostics.stop()`'s own
          // reasoning.
        });
    }
  }

  private failAllPending(reason: string): void {
    for (const [downloadId] of this.pending) {
      this.sink.onDownloadFailed({ downloadId, reason });
    }
    this.pending.clear();
  }

  private async tryEnable(downloadPath: string): Promise<void> {
    try {
      await this.bridge.send(
        'Page.setDownloadBehavior',
        { behavior: 'allowAndName', downloadPath, eventsEnabled: true },
        this.sessionId,
      );
      this.enabled = true;
    } catch {
      // A target that died, or a session mid-swap, between
      // `startDownloadCapture` and the domain actually enabling is
      // ordinary, not exceptional: matches `TargetDiagnostics.tryEnable`'s
      // own precedent. `this.enabled` stays false, so `stop()`/`rebind()`
      // never send a disable for something that never actually enabled.
    }
  }

  private readonly onDownloadWillBegin = (params: Record<string, unknown>): void => {
    if (!this.enabled) return;
    const downloadId = typeof params['guid'] === 'string' ? (params['guid'] as string) : undefined;
    if (!downloadId) return;
    const suggestedName =
      typeof params['suggestedFilename'] === 'string'
        ? (params['suggestedFilename'] as string)
        : '';
    const url = typeof params['url'] === 'string' ? (params['url'] as string) : '';

    if (this.pending.size >= MAX_PENDING_DOWNLOADS && !this.pending.has(downloadId)) {
      const oldestKey = this.pending.keys().next().value;
      if (oldestKey !== undefined) {
        this.pending.delete(oldestKey);
        this.sink.onDownloadFailed({ downloadId: oldestKey, reason: 'too_many_pending_downloads' });
      }
    }
    this.pending.set(downloadId, { suggestedName });
    this.sink.onDownloadStarted({ downloadId, suggestedName, url });
  };

  private readonly onDownloadProgress = (params: Record<string, unknown>): void => {
    if (!this.enabled) return;
    const downloadId = typeof params['guid'] === 'string' ? (params['guid'] as string) : undefined;
    if (!downloadId) return;
    const state = typeof params['state'] === 'string' ? (params['state'] as string) : '';
    const receivedBytes =
      typeof params['receivedBytes'] === 'number' ? (params['receivedBytes'] as number) : 0;

    if (state === 'inProgress') {
      const totalBytesRaw =
        typeof params['totalBytes'] === 'number' ? (params['totalBytes'] as number) : 0;
      this.sink.onDownloadProgress({
        downloadId,
        receivedBytes,
        totalBytes: totalBytesRaw > 0 ? totalBytesRaw : null,
      });
      return;
    }

    const info = this.pending.get(downloadId);
    this.pending.delete(downloadId);

    if (state === 'completed') {
      // `filePath` is present on recent Chrome (behind the same flag that
      // gates `eventsEnabled`) and is the authoritative location; when a
      // build omits it this collector falls back to the one place
      // `behavior: 'allowAndName'` (see the module doc) guarantees the
      // bytes landed: `<downloadPath>/<guid>`, with no extension, because
      // that is literally what `allowAndName` means. `requestedDownloadPath`
      // is guaranteed non-null here: a `completed` event cannot arrive
      // before `tryEnable` succeeded, and `tryEnable` is only ever called
      // with a non-null path.
      const filePath =
        typeof params['filePath'] === 'string' && params['filePath']
          ? (params['filePath'] as string)
          : this.requestedDownloadPath !== null
            ? `${this.requestedDownloadPath}/${downloadId}`
            : null;
      if (filePath === null) {
        this.sink.onDownloadFailed({ downloadId, reason: 'no_download_path' });
        return;
      }
      this.sink.onDownloadCompleted({
        downloadId,
        suggestedName: info?.suggestedName ?? '',
        path: filePath,
        sizeBytes: receivedBytes,
      });
      return;
    }

    // `state === 'canceled'`, or anything this version of CDP names that
    // this collector does not recognise: reported failed rather than
    // silently dropped, since a caller waiting on this `downloadId` has no
    // other way to learn it will never complete.
    this.sink.onDownloadFailed({
      downloadId,
      reason: state === 'canceled' ? 'canceled' : `unknown_state:${state}`,
    });
  };

  /**
   * Subscribes both events unconditionally, exactly like
   * `TargetDiagnostics.subscribeListeners()`: subscribing is free, and each
   * handler independently checks `this.enabled` before doing any work, so
   * `Page.setDownloadBehavior` never having been sent (or having failed)
   * simply means Chrome never emits these events on this session in the
   * first place.
   */
  private subscribeListeners(): void {
    const boundSessionId = this.sessionId;
    const guard =
      <T extends (params: Record<string, unknown>) => void>(fn: T) =>
      (params: Record<string, unknown>): void => {
        // See `target-diagnostics.ts`'s module doc: a handler still in
        // flight from before a `rebind()` moved past this session must not
        // touch state that by now belongs to a different session.
        if (boundSessionId !== this.sessionId) return;
        try {
          fn(params);
        } catch {
          // A malformed CDP payload must never throw into the bridge's
          // synchronous event dispatch loop.
        }
      };

    this.unsubs = [
      this.bridge.on('Browser.downloadWillBegin', guard(this.onDownloadWillBegin), boundSessionId),
      this.bridge.on('Browser.downloadProgress', guard(this.onDownloadProgress), boundSessionId),
    ];
  }
}
