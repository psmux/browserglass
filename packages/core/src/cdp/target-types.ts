/**
 * `TargetRuntime`, the core-internal target record `TargetRegistry` keeps
 * in memory. It adds six fields the domain `Target` record lacks
 * (`dialogOpen`, `degraded`, `loadTimedOut`, `role`, `pinned`, and the
 * init-script identifiers). It extends `@browserglass/protocol`'s
 * `domain/entities.ts` `Target` (`cdpTargetId`, `cdpSessionId`,
 * `streamable`, viewport, scroll, and so on) rather than the wire
 * `TargetSummary`, since the domain `Target` is the shape those six fields
 * are actually missing from; a wire-facing layer maps `TargetRuntime` down
 * to `TargetSummary`.
 */

import type { Target as DomainTarget } from '@browserglass/protocol';

/** A `Page.javascriptDialogOpening` in progress on a target. */
export interface TargetDialogState {
  type: string;
  message: string;
  defaultPrompt: string | null;
  hasBrowserHandler: boolean;
}

/** How a target with a Chrome `openerId` was classified from the `Page.windowOpen` that created it. */
export type TargetRole = 'tab' | 'popup' | 'auth_popup' | null;

/**
 * The core-internal target record. Everything `TargetRegistry` tracks that
 * is not part of the durable, wire-facing `Target` domain shape.
 */
export interface TargetRuntime extends DomainTarget {
  /** Set while a modal JS dialog blocks this target's renderer main thread. */
  dialogOpen: TargetDialogState | null;
  /** Ten consecutive attach failures on this target, still listed, flagged. */
  degraded: boolean;
  /** The 30000ms `Page.loadEventFired` timer expired without a `load` event. */
  loadTimedOut: boolean;
  /** Set from the `Page.windowOpen` that created this target, when it has an opener. */
  role: TargetRole;
  /** BrowserGlass-only state; CDP never reports it. Pinned targets sort before unpinned ones. */
  pinned: boolean;
  /**
   * `Page.addScriptToEvaluateOnNewDocument` identifiers this registry owns
   * on this target's CURRENT CDP session, for later removal via
   * `TargetRegistry.removeInitScripts`. Installed by
   * `TargetRegistryImpl.installInitScripts`, replaced wholesale (never
   * appended to) on every fresh session the same target gets, since a CDP
   * session's own identifiers die with it: a cross origin navigation swaps
   * the renderer, kills the old session, and takes every identifier issued
   * on it with it, so an old value here would name a script Chrome has
   * already forgotten. Empty for a target `BrowserSpec.initScripts` is
   * empty for, and for any target with no attached session yet.
   */
  scriptIdentifiers: readonly string[];
  /** The sparse float ordering key, authoritative tab order. */
  order: number;
  /**
   * Whether this target's main frame can go back or forward, read from
   * `Page.getNavigationHistory` whenever it navigates. Both stay `false` for
   * a target with no attached page session, which is the honest answer:
   * unknown history reads as "disabled" everywhere it is rendered.
   */
  canGoBack: boolean;
  canGoForward: boolean;
  /**
   * Chrome's frame id for this target's main frame, learned from
   * `Page.getFrameTree` at attach. `Page.frameStartedLoading` and its
   * siblings fire for subframes too, and a page full of iframes would
   * otherwise flip `loading` on and off constantly; this is what those
   * events are filtered against. `null` until the frame tree is read.
   */
  mainFrameId: string | null;
  /**
   * The OS window this target lives in, from `Browser.getWindowForTarget`
   * (`TargetRegistry.windowIdFor`). `null` until resolved, and again if the
   * call ever fails: a target is still fully usable with an unknown window,
   * it just cannot be reasoned about for per-window activation
   * (`target-activation.ts`) until this is populated.
   */
  windowId: number | null;
}

/** Chrome's own `TargetInfo.type` strings, wider in practice than documented. */
export type RawCdpTargetType =
  | 'page'
  | 'iframe'
  | 'worker'
  | 'service_worker'
  | 'shared_worker'
  | 'background_page'
  | 'browser'
  | 'webview'
  | 'other'
  | 'auction_worklet'
  | 'tab';

/** One raw `TargetInfo`, the shape `Target.getTargets`/`Target.targetCreated` carry. */
export interface RawTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  browserContextId?: string;
}

/** The classification result for one raw target. */
export interface TargetClassification {
  type: DomainTarget['type'];
  autoAttach: boolean;
  streamable: boolean;
  inTabList: boolean;
}

/**
 * Normalises one of Chrome's observed `TargetInfo.type` strings, plus its
 * URL scheme, into a {@link TargetClassification}. URL scheme is the only
 * reliable discriminator for extension pages, popups, and background pages,
 * since Chrome reports all of them as ordinary `page` or `background_page`.
 */
export function classifyTarget(rawType: string, url: string): TargetClassification {
  if (rawType === 'page') {
    if (url.startsWith('chrome-extension://') || url.startsWith('devtools://')) {
      return { type: 'other', autoAttach: false, streamable: false, inTabList: false };
    }
    return { type: 'page', autoAttach: true, streamable: true, inTabList: true };
  }
  if (rawType === 'iframe') {
    return { type: 'iframe', autoAttach: false, streamable: true, inTabList: false };
  }
  if (rawType === 'worker') {
    return { type: 'worker', autoAttach: false, streamable: false, inTabList: false };
  }
  if (rawType === 'service_worker') {
    return { type: 'service_worker', autoAttach: false, streamable: false, inTabList: false };
  }
  if (rawType === 'shared_worker') {
    return { type: 'shared_worker', autoAttach: false, streamable: false, inTabList: false };
  }
  if (rawType === 'browser') {
    return { type: 'browser', autoAttach: false, streamable: false, inTabList: false };
  }
  // background_page, webview, other, auction_worklet, tab, and anything unrecognised.
  return { type: 'other', autoAttach: false, streamable: false, inTabList: false };
}
