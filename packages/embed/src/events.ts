/**
 * The DOM `CustomEvent` surface `<browser-glass>` dispatches on itself.
 * Every event is `bubbles: true, composed: true` so a host page can listen
 * once at `document` level rather than wiring a listener onto every widget
 * individually, and so the event crosses this element's shadow boundary
 * (composed events are the one kind of DOM event shadow DOM does not stop
 * at the boundary). Every detail payload is a plain object: no class
 * instances, no methods, safe to log or `JSON.stringify`.
 *
 * Names are prefixed `bgls:` rather than left bare (`connected`,
 * `error`, ...) because a plain HTML page is exactly the environment where
 * a bare event name is most likely to collide with something else already
 * on the page; a custom element embedded by script tag has no module
 * scope to hide behind the way a React prop callback does.
 */

/** `<browser-glass connected>`: the underlying gateway connection is live. */
export interface BrowserGlassConnectedDetail {
  viewerId: string;
  sessionId: string;
  resumed: boolean;
}

/** The gateway connection dropped, whether or not it will retry on its own. */
export interface BrowserGlassDisconnectedDetail {
  code: number;
  reason: string;
  willReconnect: boolean;
}

/** This element now holds the control lease for its `target-id` and may drive it. */
export interface BrowserGlassControlGainedDetail {
  targetId: string;
  leaseId: string;
}

/** This element no longer holds the control lease, whether released voluntarily, expired, or preempted by another viewer. */
export interface BrowserGlassControlLostDetail {
  targetId: string;
  /**
   * A superset of `@browserglass/client`'s own `controllost` reasons, which
   * this element forwards verbatim, plus `'released'` for a lease this
   * element gave up itself (the client reports that as an absence of the
   * event rather than as a reason, so the element supplies it).
   *
   * `'human_takeover'` and `'kind_changed'` arrived with shared control:
   * a person reclaiming a target an automation client was driving, and a
   * tenure ended because a reauth changed the holder's identity class.
   * Both are worth telling an embedding page apart from `'preempted'`,
   * because "a person took over" and "another viewer outranked you" are
   * different sentences to show a user, and only `'kind_changed'` is worth
   * an immediate re-request.
   */
  reason:
    | 'expired'
    | 'idle'
    | 'admin'
    | 'preempted'
    | 'human_takeover'
    | 'kind_changed'
    | 'target_gone'
    | 'session_ended'
    | 'released';
}

/** One `console.*` call on the remote page. Only delivered when the `devtools` capability is granted. */
export interface BrowserGlassConsoleDetail {
  level: string;
  text: string;
  url?: string;
  line?: number;
}

/** An uncaught exception or unhandled rejection on the remote page. Only delivered when the `devtools` capability is granted. */
export interface BrowserGlassPageErrorDetail {
  name: string;
  message: string;
  stack?: string;
}

/** The remote page navigated, or its loading/URL/title state changed. */
export interface BrowserGlassNavigationDetail {
  url: string;
  title: string;
  loading: boolean;
}

/**
 * Something this element cannot recover from on its own: a missing
 * required attribute, a fatal connection failure, or the duplicate-target
 * conflict described in `client-pool.ts`'s doc comment. `code` is a stable
 * machine-readable string; `message` is for a developer console, not for
 * showing untranslated to an end user.
 */
export interface BrowserGlassErrorDetail {
  code:
    | 'missing-url'
    | 'missing-target-id'
    | 'duplicate-target'
    | 'connection-fatal'
    | 'connection-error'
    | 'control-denied'
    | 'not-attached';
  message: string;
}

/** The full map from event name to its detail payload type, for {@link dispatchBrowserGlassEvent}'s own type checking. */
export interface BrowserGlassEventDetailMap {
  'bgls:connected': BrowserGlassConnectedDetail;
  'bgls:disconnected': BrowserGlassDisconnectedDetail;
  'bgls:controlgained': BrowserGlassControlGainedDetail;
  'bgls:controllost': BrowserGlassControlLostDetail;
  'bgls:console': BrowserGlassConsoleDetail;
  'bgls:pageerror': BrowserGlassPageErrorDetail;
  'bgls:navigation': BrowserGlassNavigationDetail;
  'bgls:error': BrowserGlassErrorDetail;
}

/** Dispatches one of {@link BrowserGlassEventDetailMap}'s events on `target`, typed end to end so a call site cannot pair the wrong detail shape with an event name. */
export function dispatchBrowserGlassEvent<K extends keyof BrowserGlassEventDetailMap>(
  target: EventTarget,
  type: K,
  detail: BrowserGlassEventDetailMap[K],
): void {
  target.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
}
