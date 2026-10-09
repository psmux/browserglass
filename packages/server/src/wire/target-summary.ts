/**
 * Maps `@browserglass/core`'s `TargetRuntime` (the CDP layer's internal,
 * richer target record) onto `@browserglass/protocol`'s wire `TargetSummary`
 * (`welcome.targets`, `target.listed`, `target.created`/`.updated`). Router's
 * own `attach()`/`acquire()` never populate a real targets snapshot (router
 * has no CDP access), so this transport layer builds
 * `TargetSummary[]` itself from a live `TargetRegistry`, which is the only
 * thing in this build that actually knows what tabs a browser has open.
 */

import type { TargetKind, TargetSummary } from '@browserglass/protocol';

/** The subset of `core`'s `TargetRuntime` this mapping reads. Kept structural (not imported from `@browserglass/core` directly) so this module has no compile-time dependency on `core`'s CDP-internal type surface beyond field names. */
export interface TargetRuntimeLike {
  readonly id: string;
  readonly type: string;
  readonly title: string;
  readonly url: string;
  readonly faviconUrl: string | null;
  readonly openerId: string | null;
  readonly loading: boolean;
  readonly canGoBack: boolean;
  readonly canGoForward: boolean;
  readonly order: number;
  readonly createdAt: number;
  /** The OS window this target lives in (`Browser.getWindowForTarget`, cached by `TargetRegistry.windowIdFor`). Null when unknown, matching `core`'s own `TargetRuntime.windowId`. */
  readonly windowId: number | null;
}

const KIND_MAP: Readonly<Record<string, TargetKind>> = Object.freeze({
  page: 'page',
  iframe: 'iframe',
  worker: 'worker',
  service_worker: 'service_worker',
  shared_worker: 'other',
  browser: 'other',
  other: 'other',
});

/**
 * Builds one wire `TargetSummary`. `activeTargetIds` (one live-screencast
 * target per OS window, per the activation policy and window
 * isolation's per-window activation) drives `active`: a target is LIVE
 * exactly when it appears in that set, so membership alone answers "is
 * this the active target of its own window" without this function ever
 * needing to compare windows against each other. `viewerCount` is this
 * transport layer's own per-target subscriber count, since `core` tracks
 * subscription membership only for the recovery watchdog's participant
 * count, not as a wire-facing number.
 */
export function toTargetSummary(
  t: TargetRuntimeLike,
  opts: { readonly activeTargetIds: readonly string[]; readonly viewerCount: number },
): TargetSummary {
  return {
    targetId: t.id,
    kind: KIND_MAP[t.type] ?? 'other',
    title: t.title,
    url: t.url,
    faviconUrl: t.faviconUrl,
    index: t.order,
    active: opts.activeTargetIds.includes(t.id),
    windowId: t.windowId,
    audible: false,
    muted: false,
    loading: t.loading,
    // Both are real now: `TargetRegistry` enables the `Page` domain on every
    // attached tab and keeps them in step with
    // `Page.getNavigationHistory` (see `wirePageDomain`). They were hard
    // coded `false` while no prior task wired that domain, which made a tab
    // strip's back and forward controls permanently dead.
    canGoBack: t.canGoBack,
    canGoForward: t.canGoForward,
    openerTargetId: t.openerId,
    viewers: opts.viewerCount,
    createdAt: t.createdAt,
  };
}
