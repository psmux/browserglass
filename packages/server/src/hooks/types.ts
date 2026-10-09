import type { AppId, BrowserSpec, Capability, Principal, TenantId } from '@browserglass/protocol';

/** Fields every hook event carries. `reason` is mutable: a vetoing hook sets it to surface a specific message to the viewer. */
export interface HookEventBase {
  readonly at: number;
  readonly tenantId: TenantId;
  readonly appId: AppId;
  readonly requestId: string;
  reason?: string;
}

export interface InstanceLaunchedEvent extends HookEventBase {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly nodeId: string;
  readonly poolId: string | null;
  readonly subject: string;
  readonly spec: BrowserSpec;
  readonly profile: {
    readonly profileId: string | null;
    readonly key: string;
    readonly mode: string;
    readonly created: boolean;
  };
  readonly reused: boolean;
  readonly timings: {
    readonly profileMs: number;
    readonly launchMs: number;
    readonly totalMs: number;
  };
  readonly metadata: Readonly<Record<string, string>>;
}

export interface SessionStartedEvent extends HookEventBase {
  readonly sessionId: string;
  readonly instanceId: string;
}

export interface ViewerJoinedEvent extends HookEventBase {
  readonly sessionId: string;
  readonly viewerId: string;
  readonly principal: Principal;
  readonly resumed: boolean;
  readonly remoteAddress: string;
  readonly userAgent: string | null;
  readonly existingViewers: number;
}

export interface ControlGrantedEvent extends HookEventBase {
  readonly sessionId: string;
  readonly targetId: string;
  readonly viewerId: string;
  readonly leaseId: string;
  readonly subject: string;
  readonly forceClaimed: boolean;
  readonly previousHolder: { readonly viewerId: string; readonly subject: string } | null;
  readonly ttlMs: number;
}

export interface NavigationEvent extends HookEventBase {
  readonly sessionId: string;
  readonly targetId: string;
  readonly viewerId: string | null;
  readonly url: string;
  readonly fromUrl: string;
  readonly kind: 'user' | 'automation' | 'redirect' | 'page';
  readonly redirectChain: readonly string[];
}

export interface DownloadEvent extends HookEventBase {
  readonly sessionId: string;
  readonly targetId: string;
  readonly viewerId: string;
  readonly downloadId: string;
  readonly suggestedName: string;
  readonly bytes: number;
  readonly mimeType: string | null;
  readonly sha256: string;
  readonly sourceUrl: string;
}

export interface RecoveryEvent extends HookEventBase {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly rung: 0 | 1 | 2 | 3 | 4;
  readonly rungName:
    | 'restart_stream'
    | 'recreate_cdp'
    | 'reload_target'
    | 'restart_instance'
    | 'relocate';
  readonly trigger: 'frame_silence' | 'cdp_error' | 'target_crashed' | 'watchdog' | 'manual';
  readonly attempt: number;
  readonly succeeded: boolean | null;
  readonly detail: string;
}

export interface InstanceReleasedEvent extends HookEventBase {
  readonly instanceId: string;
  readonly sessionId: string;
  readonly reason: string;
  readonly durationMs: number;
  readonly profileAction: 'keep' | 'destroy' | 'snapshotThenKeep' | 'snapshotThenDestroy';
  readonly profileBytes: number | null;
  readonly viewerSeconds: number;
  readonly framesSent: number;
  readonly bytesSent: number;
}

export interface QuotaExceededEvent extends HookEventBase {
  readonly scope: 'tenant' | 'app' | 'subject' | 'pool';
  readonly limit: string;
  readonly limitValue: number;
  readonly current: number;
  readonly subject: string | null;
  readonly action: 'queued' | 'rejected' | 'evicted';
}

/**
 * One outbound request a Target is about to make, gated in process by the
 * request gate `docs/cdp-and-interception.md` describes
 * (`packages/core/src/interception/**`, wired separately: this file
 * declares the shape and the timeout policy only, the engine that actually
 * calls `dispatch('onRequest', ...)` lives there). `postData` is optional and is only ever populated when the
 * caller that registered the gate asked for it: see that same doc's
 * `includeRequestBody` argument, which ties reading a request
 * body to the same trust boundary `evaluate` already gates (reading page
 * content), not to `onRequest` itself.
 */
export interface RequestEvent extends HookEventBase {
  readonly sessionId: string;
  readonly targetId: string;
  readonly url: string;
  readonly method: string;
  readonly resourceType: string;
  readonly postData?: string;
}

/**
 * The ten lifecycle hooks. Registered via `config.hooks` or `bg.on(name,
 * fn)`. Vetoing hooks (`onViewerJoined`, `onControlGranted`,
 * `onNavigation`, `onDownload`, `onRequest`) return `false` (or throw) to
 * veto; the first `false`/throw among multiple handlers wins and later
 * handlers are skipped. See {@link HOOK_TIMEOUTS} for the exact per hook
 * timeout and fail open/closed behaviour.
 */
export interface Hooks {
  onInstanceLaunched?(e: InstanceLaunchedEvent): void | Promise<void>;
  onSessionStarted?(e: SessionStartedEvent): void | Promise<void>;
  onViewerJoined?(e: ViewerJoinedEvent): boolean | undefined | Promise<boolean | undefined>;
  onControlGranted?(e: ControlGrantedEvent): boolean | undefined | Promise<boolean | undefined>;
  onNavigation?(e: NavigationEvent): boolean | undefined | Promise<boolean | undefined>;
  onDownload?(e: DownloadEvent): boolean | undefined | Promise<boolean | undefined>;
  onRecovery?(e: RecoveryEvent): void | Promise<void>;
  onInstanceReleased?(e: InstanceReleasedEvent): void | Promise<void>;
  onQuotaExceeded?(e: QuotaExceededEvent): void | Promise<void>;
  onRequest?(e: RequestEvent): boolean | undefined | Promise<boolean | undefined>;
}

export type HookName = keyof Hooks;

/**
 * Per hook timeout in milliseconds and what happens when it is exceeded.
 * `onDownload` and `onRequest` are the two hooks that fail closed (a timed
 * out check is a veto); every other hook fails open (a timed out check is
 * treated as an allow, or for a non-vetoing hook, is simply abandoned).
 *
 * `onRequest` fails closed for the same reason `onDownload` does, stated
 * plainly in `docs/cdp-and-interception.md`: a request
 * gate that fails open on a slow or wedged handler is not a gate, it is a
 * gate shaped piece of decoration that an operator believes is protecting
 * them. 1500ms sits between `onControlGranted`'s 1000ms and `onDownload`'s
 * 5000ms: a request gate runs far more often than either (once per
 * matched network request, not once per session or per file), so it
 * cannot afford `onDownload`'s five second allowance without stalling a
 * page load for every held request, but it still needs enough room for a
 * handler that does a real out of process check (an allowlist lookup, a
 * policy service call) rather than a pure in memory decision.
 */
export const HOOK_TIMEOUTS: Readonly<
  Record<
    HookName,
    { readonly timeoutMs: number; readonly vetoes: boolean; readonly failClosed: boolean }
  >
> = Object.freeze({
  onInstanceLaunched: { timeoutMs: 2000, vetoes: false, failClosed: false },
  onSessionStarted: { timeoutMs: 2000, vetoes: false, failClosed: false },
  onViewerJoined: { timeoutMs: 1500, vetoes: true, failClosed: false },
  onControlGranted: { timeoutMs: 1000, vetoes: true, failClosed: false },
  onNavigation: { timeoutMs: 750, vetoes: true, failClosed: false },
  onDownload: { timeoutMs: 5000, vetoes: true, failClosed: true },
  onRecovery: { timeoutMs: 2000, vetoes: false, failClosed: false },
  onInstanceReleased: { timeoutMs: 2000, vetoes: false, failClosed: false },
  onQuotaExceeded: { timeoutMs: 1000, vetoes: false, failClosed: false },
  onRequest: { timeoutMs: 1500, vetoes: true, failClosed: true },
});
