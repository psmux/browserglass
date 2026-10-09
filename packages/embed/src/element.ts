import {
  type BrowserGlassClient,
  type CanvasRenderer,
  type CaptureOptions,
  type CaptureResult,
  type ControlOutcome,
  type ControlRequestOptions,
  InputCapture,
  type StreamHandle,
} from '@browserglass/client';
import { type TargetStreamSubscriber, acquireClient, acquireTargetStream } from './client-pool.js';
import { type BrowserGlassErrorDetail, dispatchBrowserGlassEvent } from './events.js';

/** `client.navigate()`'s resolved value, read off the method itself since `NavState` is not part of `@browserglass/client`'s own public export list (confirmed by reading `packages/client/src/index.ts`); this package has no reason to add a direct `@browserglass/protocol` dependency just to name a type its one caller can derive structurally. */
type NavResult = Awaited<ReturnType<BrowserGlassClient['navigate']>>;
type NavigateOpts = Parameters<BrowserGlassClient['navigate']>[2];
type ReloadOpts = Parameters<BrowserGlassClient['reload']>[1];

const SHADOW_STYLES = `
  :host {
    display: block;
    position: relative;
    overflow: hidden;
    background: var(--bgls-bg, #0b0d12);
    border-radius: var(--bgls-radius, 0);
    font-family: var(--bgls-font, ui-monospace, "SF Mono", Consolas, monospace);
  }
  .container {
    position: absolute;
    inset: 0;
  }
  canvas {
    width: 100%;
    height: 100%;
    display: block;
  }
  .placeholder {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5em;
    text-align: center;
    font-size: 0.8rem;
    line-height: 1.4;
    color: var(--bgls-placeholder-fg, #8b93a7);
    background: var(--bgls-placeholder-bg, transparent);
    pointer-events: none;
  }
  :host([error]) .placeholder {
    color: var(--bgls-error-fg, #ff8a8a);
  }
  .placeholder:empty {
    display: none;
  }
  .badge {
    position: absolute;
    top: 0.5em;
    right: 0.5em;
    padding: 0.15em 0.55em;
    border-radius: 999px;
    font-size: 0.65rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    background: var(--bgls-badge-bg, rgba(0, 0, 0, 0.55));
    color: var(--bgls-badge-fg, #cfd6e6);
    pointer-events: none;
  }
  :host(:not([has-control])) .badge[data-role='control'] {
    display: none;
  }
`;

/**
 * `<browser-glass>`: a self-contained custom element wrapping one
 * `@browserglass/client` subscription. Everything this class does mirrors
 * `packages/react/src/BrowserGlass.tsx`'s own subscribe/attach/input
 * capture/cleanup sequence (that component is "a thin wrapper over the
 * client" and this element is the same wrapper
 * with no React underneath it), except for two things `BrowserGlass.tsx`
 * never has to deal with because a React app usually renders one pane per
 * target: sharing one gateway connection across several elements, and
 * arbitrating which element paints when more than one names the same
 * target. Both live in `./client-pool.ts`, imported here rather than
 * reimplemented, so this file's own job is strictly "own one shadow DOM,
 * one canvas, one imperative API surface, and translate this element's
 * attributes and this element's slice of client/stream events into that."
 *
 * Attributes: `url` and `target-id` are required; `token` is required by
 * any gateway that is not wide open. `readonly` (boolean, presence-only)
 * suppresses pointer/keyboard capture and blocks the imperative
 * clickAt/type/takeControl methods; `navigate`/`reload`/`screenshot` still
 * work on a readonly element, since those are page-level actions gated by
 * the gateway's own capability model, not by which viewer holds the
 * pointer. `fit` is `'contain'` (default) or `'cover'`.
 *
 * A bearer `token` is capped at 900 seconds regardless of what was
 * requested (`docs/protocol/wire-spec.md`), so any embed that outlives
 * that window needs a way to refresh one without the host page polling
 * `token`'s current value. Two ways, since a custom element attribute
 * cannot itself carry a function: set `el.onTokenExpired = async () =>
 * newToken` as a plain JS property on the element instance (read fresh on
 * every call, so setting it after the element already connected still
 * takes effect on the next refresh), or set the `token-endpoint`
 * attribute to a URL this element `fetch()`es and reads `{ "token":
 * "..." }` from. `onTokenExpired` wins when both are set. Neither is
 * required; with neither, a client whose token expires goes `fatal` with
 * a clear message instead of retrying with a token the server already
 * refused. See `./client-pool.js`'s `acquireClient` doc comment for what
 * "refresh" means for a client shared across several elements. Setting a
 * brand new `token` attribute value at runtime (the host page's OWN
 * refresh loop, bypassing both of the above) works too: it is already
 * `url`'s and `token`'s job below to rebuild the connection whenever
 * either changes, which never hands back a pooled client still keyed to
 * the token this element is walking away from.
 *
 * Reflected state, for host CSS and host `MutationObserver`s: `state`
 * mirrors `BrowserGlassClient`'s own `ConnectionState` plus this element's
 * own `'connecting'`; `has-control` is present exactly when this element
 * currently holds the target's control lease; `error` carries a stable
 * code (see `./events.js`'s `BrowserGlassErrorDetail['code']`) whenever
 * something is wrong, including the `'duplicate-target'` state described
 * in `./client-pool.ts`. Shadow DOM parts `container`, `canvas`, and
 * `placeholder` are exposed via `::part()` for host styling; internals
 * stay inside the shadow root so a host page's own CSS cannot reach in and
 * break the canvas layout, and this element's own styles cannot leak out.
 */
export class BrowserGlassElement extends HTMLElement {
  static readonly observedAttributes = ['url', 'token', 'target-id', 'readonly', 'fit'];

  /**
   * A JS property, not an attribute: a custom element attribute cannot
   * carry a function. Called whenever the underlying client's token has
   * expired and it needs a fresh one to reconnect with (see this class's
   * own doc comment). Read live off `this` every time a refresh is
   * needed, not captured once at connect time, so a host page may set
   * this before OR after appending the element and either way it takes
   * effect on the next refresh. Takes precedence over the `token-endpoint`
   * attribute when both are set.
   */
  onTokenExpired: (() => Promise<string>) | null = null;

  readonly #containerEl: HTMLDivElement;
  readonly #canvasEl: HTMLCanvasElement;
  readonly #placeholderEl: HTMLDivElement;
  readonly #controlBadgeEl: HTMLDivElement;

  #client: BrowserGlassClient | null = null;
  #clientRelease: (() => void) | null = null;
  #streamRelease: (() => void) | null = null;
  #handle: StreamHandle | null = null;
  #capture: InputCapture | null = null;
  #onFirstInteract: ((e: Event) => void) | null = null;
  #isPrimary = false;
  #diagnosticsTargetId: string | null = null;
  #queuedNotified = false;
  #offs: Array<() => void> = [];
  /** Bumped by every teardown; every async callback captured before a teardown checks it against a snapshot taken at registration time before acting, so a slow reply arriving after this element moved on to a different target cannot mutate state that no longer belongs to it. */
  #gen = 0;
  /** `url`/`token` the current `#client` (if any) was actually constructed with, so `#syncIdentity` can tell "the connection identity changed" apart from "only target-id moved" even when several attributes were just set in the same synchronous burst. */
  #connectedUrl: string | null = null;
  #connectedToken: string | undefined = undefined;
  /** Set while a coalesced `#syncIdentity()` microtask is pending; see `attributeChangedCallback`. */
  #syncScheduled = false;

  constructor() {
    super();
    const root = this.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = SHADOW_STYLES;
    this.#containerEl = document.createElement('div');
    this.#containerEl.className = 'container';
    this.#containerEl.setAttribute('part', 'container');
    this.#canvasEl = document.createElement('canvas');
    this.#canvasEl.setAttribute('part', 'canvas');
    this.#placeholderEl = document.createElement('div');
    this.#placeholderEl.className = 'placeholder';
    this.#placeholderEl.setAttribute('part', 'placeholder');
    this.#controlBadgeEl = document.createElement('div');
    this.#controlBadgeEl.className = 'badge';
    this.#controlBadgeEl.dataset['role'] = 'control';
    this.#controlBadgeEl.setAttribute('part', 'badge');
    this.#controlBadgeEl.textContent = 'driving';
    this.#containerEl.append(this.#canvasEl, this.#placeholderEl, this.#controlBadgeEl);
    root.append(style, this.#containerEl);
  }

  connectedCallback(): void {
    // Not debounced, unlike `attributeChangedCallback` below: every
    // attribute a host set before inserting this element (`el.setAttribute
    // (...); parent.appendChild(el)`, the ordinary way to configure one)
    // is already present by the time this runs, so there is nothing to
    // wait a microtask for.
    this.#syncIdentity();
  }

  disconnectedCallback(): void {
    this.#teardown();
  }

  attributeChangedCallback(name: string): void {
    if (!this.isConnected) return;
    if (name === 'fit') {
      this.#handle?.renderer?.setFit(this.#fitValue());
      return;
    }
    if (name === 'readonly') {
      this.#applyReadonlyChange();
      return;
    }
    // 'url', 'token', 'target-id': coalesced into one microtask reaction.
    // A host page configuring an already-connected element (this
    // package's own demo does exactly this: fill in a form, then call
    // `el.setAttribute('url', ...)` / `('token', ...)` / `('target-id',
    // ...)` back to back) fires this callback three times synchronously.
    // Reacting to each one individually would see "url present, target-id
    // still missing" after the first call and report a spurious error
    // before the third call ever runs. Waiting one microtask lets a
    // same-tick burst of attribute changes settle before `#syncIdentity`
    // reads any of them.
    if (this.#syncScheduled) return;
    this.#syncScheduled = true;
    queueMicrotask(() => {
      this.#syncScheduled = false;
      if (this.isConnected) this.#syncIdentity();
    });
  }

  /**
   * Reconciles this element's `url`/`token`/`target-id` attributes against
   * whatever it is currently connected to, exactly once, called from
   * `connectedCallback` (immediately) and `attributeChangedCallback`
   * (debounced, see above). A changed `url` or `token` means the
   * connection itself is wrong and needs a full `#rebuild()`; an unchanged
   * `url`/`token` with a different (or newly present) `target-id` only
   * needs `#resubscribeTarget()`, which leaves the client and its socket
   * alone.
   */
  #syncIdentity(): void {
    const url = this.getAttribute('url');
    const token = this.getAttribute('token') ?? undefined;
    if (url !== this.#connectedUrl || token !== this.#connectedToken || !this.#client) {
      this.#rebuild();
      return;
    }
    this.#resubscribeTarget();
  }

  // ====================================================================
  // Attribute reads
  // ====================================================================

  #fitValue(): 'contain' | 'cover' {
    return this.getAttribute('fit') === 'cover' ? 'cover' : 'contain';
  }

  #readonlyValue(): boolean {
    return this.hasAttribute('readonly');
  }

  /**
   * `BrowserGlassClient`'s own `credentials` option (`acquireClient`
   * threads it through to the constructor): called only when the client
   * needs a fresh credential and neither a live ticket nor a live token
   * covers it, per `packages/client/src/transport/transport.ts`'s
   * `resolveCredential()`. Prefers `onTokenExpired` (read live, not
   * captured); falls back to fetching `token-endpoint` (also read live)
   * for `{ "token": "..." }`. Throws a clear, actionable message when
   * neither is configured, rather than letting the client fall through to
   * its own generic "no credentials available" error.
   */
  async #resolveCredentials(): Promise<{ token?: string }> {
    if (this.onTokenExpired) {
      return { token: await this.onTokenExpired() };
    }
    const endpoint = this.getAttribute('token-endpoint');
    if (endpoint) {
      const res = await fetch(endpoint, { credentials: 'include' });
      if (!res.ok) {
        throw new Error(`<browser-glass>: token-endpoint "${endpoint}" responded ${res.status}.`);
      }
      const body: unknown = await res.json();
      const token = (body as { token?: unknown } | null)?.token;
      if (typeof token !== 'string' || token.length === 0) {
        throw new Error(
          `<browser-glass>: token-endpoint "${endpoint}" did not return { "token": "..." }.`,
        );
      }
      return { token };
    }
    throw new Error(
      '<browser-glass>: the "token" attribute expired and this element has no way to refresh it. ' +
        'Set el.onTokenExpired = async () => newToken, or set the "token-endpoint" attribute to a URL ' +
        'that returns { "token": "..." }.',
    );
  }

  // ====================================================================
  // Connect / subscribe / attach lifecycle
  // ====================================================================

  #rebuild(): void {
    this.#teardown();
    this.#connect();
  }

  #connect(): void {
    const url = this.getAttribute('url');
    const targetId = this.getAttribute('target-id');
    if (!url) {
      this.#fail('missing-url', '<browser-glass>: missing required "url" attribute.');
      return;
    }
    if (!targetId) {
      this.#fail('missing-target-id', '<browser-glass>: missing required "target-id" attribute.');
      return;
    }
    const token = this.getAttribute('token') ?? undefined;
    const myGen = this.#gen;

    // Always passed, even when neither `onTokenExpired` nor
    // `token-endpoint` is set: `#resolveCredentials` itself throws a
    // clear, actionable message in that case, which reaches the client as
    // an ordinary credential failure (`fatal`, code `no_credential`)
    // instead of the generic error `BrowserGlassClient` would otherwise
    // raise. See `client-pool.ts`'s `acquireClient` doc comment for why
    // this only takes effect for whichever acquirer FIRST constructs the
    // shared client at this `(url, token)` key.
    const { client, release } = acquireClient(url, token, {
      credentials: () => this.#resolveCredentials(),
    });
    this.#client = client;
    this.#clientRelease = release;
    this.#connectedUrl = url;
    this.#connectedToken = token;
    this.setAttribute('state', client.state === 'idle' ? 'connecting' : client.state);
    this.#showPlaceholder('Connecting…');

    // Every handler below reads `this.getAttribute('target-id')` live
    // rather than closing over the `targetId` this `#connect()` call
    // started with, because `target-id` alone can change without a full
    // `#rebuild()` (see `attributeChangedCallback` and
    // `#resubscribeTarget`): the client and this listener set stay put,
    // only the subscription moves. A stale closed-over `targetId` here
    // would leave every one of these events permanently scoped to
    // whichever target this element started on.
    this.#offs = [
      client.on('state', (ev) => {
        if (this.#gen !== myGen) return;
        this.setAttribute('state', ev.to);
      }),
      client.on('connected', (ev) => {
        if (this.#gen !== myGen) return;
        dispatchBrowserGlassEvent(this, 'bgls:connected', {
          viewerId: ev.viewerId,
          sessionId: ev.sessionId,
          resumed: ev.resumed,
        });
        const currentTargetId = this.getAttribute('target-id');
        if (currentTargetId) this.#subscribeTarget(currentTargetId, myGen);
      }),
      client.on('disconnected', (ev) => {
        if (this.#gen !== myGen) return;
        dispatchBrowserGlassEvent(this, 'bgls:disconnected', {
          code: ev.code,
          reason: ev.reason,
          willReconnect: ev.willReconnect,
        });
      }),
      client.on('fatal', (ev) => {
        if (this.#gen !== myGen) return;
        this.#fail('connection-fatal', ev.message);
      }),
      client.on('error', (ev) => {
        if (this.#gen !== myGen) return;
        dispatchBrowserGlassEvent(this, 'bgls:error', {
          code: 'connection-error',
          message: ev.message,
        });
      }),
      client.on('controllost', (ev) => {
        if (this.#gen !== myGen || ev.targetId !== this.getAttribute('target-id')) return;
        this.removeAttribute('has-control');
        dispatchBrowserGlassEvent(this, 'bgls:controllost', {
          targetId: ev.targetId,
          reason: ev.reason,
        });
      }),
      client.on('nav', (ev) => {
        if (this.#gen !== myGen || ev.targetId !== this.getAttribute('target-id')) return;
        dispatchBrowserGlassEvent(this, 'bgls:navigation', {
          url: ev.url,
          title: ev.title,
          loading: ev.loading,
        });
      }),
      client.on('console', (ev) => {
        if (this.#gen !== myGen || ev.targetId !== this.getAttribute('target-id')) return;
        dispatchBrowserGlassEvent(this, 'bgls:console', {
          level: ev.level,
          text: ev.text,
          ...(ev.url !== undefined ? { url: ev.url } : {}),
          ...(ev.line !== undefined ? { line: ev.line } : {}),
        });
      }),
      client.on('pageerror', (ev) => {
        if (this.#gen !== myGen || ev.targetId !== this.getAttribute('target-id')) return;
        dispatchBrowserGlassEvent(this, 'bgls:pageerror', {
          name: ev.name,
          message: ev.message,
          ...(ev.stack !== undefined ? { stack: ev.stack } : {}),
        });
      }),
    ];

    // A shared client (see `client-pool.ts`) can already be `live` by the
    // time a second element registers for it; that element's own
    // `'connected'` listener above will never fire again for a connection
    // that connected before it subscribed, so this element still needs to
    // pick up the current state directly to subscribe.
    if (client.state === 'live' || client.state === 'degraded' || client.state === 'resuming') {
      this.#subscribeTarget(targetId, myGen);
    }
  }

  #subscribeTarget(targetId: string, myGen: number): void {
    if (!this.#client || this.#streamRelease) return;
    const subscriber: TargetStreamSubscriber = {
      onPrimary: (handle) => {
        if (this.#gen !== myGen) return;
        this.#becomePrimary(handle, targetId);
      },
      onQueued: (aheadCount) => {
        if (this.#gen !== myGen) return;
        this.#becomeQueued(aheadCount, targetId);
      },
    };
    const { release } = acquireTargetStream(
      this.#client,
      targetId,
      { quality: 'auto' },
      subscriber,
    );
    this.#streamRelease = release;
  }

  /**
   * Handles a `target-id` change (or arrival) that does not also require a
   * new connection, per `#syncIdentity`'s own dispatch: drops this
   * element's current stream subscription slot (via `client-pool.ts`'s own
   * refcounting, exactly as a normal `disconnectedCallback` would) and
   * requests the new target's slot on the existing client. That client
   * connection, and every listener `#connect()` registered on it, are left
   * completely alone; see `attributeChangedCallback`'s own comment for why.
   *
   * `#syncIdentity` only calls this when `this.#client` is already set, so
   * the `!client` branch below is unreachable through that path; it stays
   * as a defensive no-op (rather than an assertion) in case some future
   * caller invokes this directly with no connection yet, since silently
   * doing nothing is a safer failure mode here than throwing.
   */
  #resubscribeTarget(): void {
    this.#detachView();
    this.#streamRelease?.();
    this.#streamRelease = null;

    const targetId = this.getAttribute('target-id');
    if (!targetId) {
      this.#fail('missing-target-id', '<browser-glass>: missing required "target-id" attribute.');
      return;
    }
    this.removeAttribute('error');
    this.#showPlaceholder('Connecting…');

    const client = this.#client;
    if (!client) return;
    if (client.state === 'live' || client.state === 'degraded' || client.state === 'resuming') {
      this.#subscribeTarget(targetId, this.#gen);
    }
  }

  #becomePrimary(handle: StreamHandle, targetId: string): void {
    this.#handle = handle;
    this.#isPrimary = true;
    this.#queuedNotified = false;
    this.removeAttribute('error');
    this.#hidePlaceholder();

    const renderer = handle.attach(this.#canvasEl, this.#containerEl, {
      fit: this.#fitValue(),
      smoothing: true,
      letterboxColour: 'transparent',
    });

    if (!this.#readonlyValue()) this.#startInputCapture(handle, renderer);

    if (this.#client?.granted.has('devtools')) {
      this.#diagnosticsTargetId = targetId;
      void this.#client.diagnostics
        .subscribe(targetId, { console: true, errors: true })
        .catch(() => {
          this.#diagnosticsTargetId = null;
        });
    }
  }

  #becomeQueued(aheadCount: number, targetId: string): void {
    this.#isPrimary = false;
    this.setAttribute('error', 'duplicate-target');
    const message = `<browser-glass>: another element on this page is already the live view for target "${targetId}" (position ${aheadCount} in the queue). This element will attach automatically if that one disconnects.`;
    this.#showPlaceholder(message);
    if (!this.#queuedNotified) {
      this.#queuedNotified = true;
      console.warn(message);
      this.#emitError('duplicate-target', message);
    }
  }

  #startInputCapture(handle: StreamHandle, renderer: CanvasRenderer): void {
    const requestOnce = (): void => {
      const client = this.#client;
      if (!client || client.hasControl(handle.targetId)) return;
      client
        .requestControl(handle.targetId)
        .then((outcome) => this.#applyControlOutcome(handle.targetId, outcome))
        .catch(() => {});
    };
    this.#capture = new InputCapture(this.#canvasEl, this.#containerEl, {
      renderer,
      targetId: handle.targetId,
      leaseId: '',
      send: (msg) => this.#client?.sendInput(msg),
      keyboard: true,
    });
    this.#onFirstInteract = () => requestOnce();
    this.#canvasEl.addEventListener('pointerdown', this.#onFirstInteract);
    this.#canvasEl.addEventListener('keydown', this.#onFirstInteract);
  }

  #applyControlOutcome(targetId: string, outcome: ControlOutcome): boolean {
    if (outcome.granted) {
      this.#capture?.setLeaseId(outcome.leaseId);
      this.setAttribute('has-control', '');
      dispatchBrowserGlassEvent(this, 'bgls:controlgained', { targetId, leaseId: outcome.leaseId });
      return true;
    }
    if (!outcome.queued) {
      this.#emitError(
        'control-denied',
        `<browser-glass>: control request denied (${outcome.reason}): ${outcome.message}`,
      );
    }
    return false;
  }

  #stopInputCapture(): void {
    if (this.#onFirstInteract) {
      this.#canvasEl.removeEventListener('pointerdown', this.#onFirstInteract);
      this.#canvasEl.removeEventListener('keydown', this.#onFirstInteract);
      this.#onFirstInteract = null;
    }
    this.#capture?.destroy();
    this.#capture = null;
  }

  #applyReadonlyChange(): void {
    if (!this.#handle || !this.#isPrimary) return;
    if (this.#readonlyValue()) {
      if (this.#client?.hasControl(this.#handle.targetId)) {
        void this.#client.releaseControl(this.#handle.targetId);
        this.removeAttribute('has-control');
      }
      this.#stopInputCapture();
    } else if (!this.#capture && this.#handle.renderer) {
      this.#startInputCapture(this.#handle, this.#handle.renderer);
    }
  }

  #detachView(): void {
    this.#stopInputCapture();
    if (this.#client && this.#handle && this.#client.hasControl(this.#handle.targetId)) {
      void this.#client.releaseControl(this.#handle.targetId);
    }
    if (this.#diagnosticsTargetId) {
      void this.#client?.diagnostics.unsubscribe(this.#diagnosticsTargetId);
      this.#diagnosticsTargetId = null;
    }
    this.#handle?.detach();
    this.#handle = null;
    this.#isPrimary = false;
    this.removeAttribute('has-control');
  }

  #teardown(): void {
    this.#gen += 1;
    for (const off of this.#offs) off();
    this.#offs = [];
    this.#detachView();
    this.#streamRelease?.();
    this.#streamRelease = null;
    this.#clientRelease?.();
    this.#clientRelease = null;
    this.#client = null;
    this.#connectedUrl = null;
    this.#connectedToken = undefined;
    this.#queuedNotified = false;
    this.removeAttribute('state');
    this.removeAttribute('error');
    this.#hidePlaceholder();
  }

  #fail(code: BrowserGlassErrorDetail['code'], message: string): void {
    this.setAttribute('state', 'fatal');
    this.setAttribute('error', code);
    this.#showPlaceholder(message);
    console.error(message);
    this.#emitError(code, message);
  }

  #emitError(code: BrowserGlassErrorDetail['code'], message: string): void {
    dispatchBrowserGlassEvent(this, 'bgls:error', { code, message });
  }

  #showPlaceholder(text: string): void {
    this.#placeholderEl.textContent = text;
  }

  #hidePlaceholder(): void {
    this.#placeholderEl.textContent = '';
  }

  // ====================================================================
  // Imperative API. `navigate`/`reload`/`screenshot` are page-level
  // actions gated by the gateway's own capability model, not by canvas
  // ownership, so they work on a `readonly` element and on a queued
  // (not-yet-primary) duplicate-target element alike. `takeControl`,
  // `releaseControl`, `clickAt`, and `type` are about driving THIS
  // element's own view, so they require both: not `readonly`, and
  // actually attached (primary) rather than queued behind another
  // element on the same target.
  // ====================================================================

  #requireClient(): { client: BrowserGlassClient; targetId: string } {
    const targetId = this.getAttribute('target-id');
    if (!this.#client || !targetId) {
      throw new Error(
        '<browser-glass> is not connected: set the "url" and "target-id" attributes first.',
      );
    }
    return { client: this.#client, targetId };
  }

  #requirePrimary(): { client: BrowserGlassClient; targetId: string; handle: StreamHandle } {
    const base = this.#requireClient();
    if (this.#readonlyValue()) {
      throw new Error(
        '<browser-glass readonly> cannot be driven; remove the "readonly" attribute first.',
      );
    }
    if (!this.#isPrimary || !this.#handle) {
      throw new Error(
        '<browser-glass> does not currently own the live view for its target (see the "duplicate-target" error state) and cannot be driven until it does.',
      );
    }
    return { ...base, handle: this.#handle };
  }

  async #ensureControl(client: BrowserGlassClient, targetId: string): Promise<boolean> {
    if (client.hasControl(targetId)) return true;
    const outcome = await client.requestControl(targetId);
    return this.#applyControlOutcome(targetId, outcome);
  }

  /** Navigates this element's target to `url`. Works even on a `readonly` or queued element. */
  navigate(url: string, opts?: NavigateOpts): Promise<NavResult> {
    const { client, targetId } = this.#requireClient();
    return client.navigate(targetId, url, opts);
  }

  /** Reloads this element's target. Works even on a `readonly` or queued element. */
  reload(opts?: ReloadOpts): Promise<NavResult> {
    const { client, targetId } = this.#requireClient();
    return client.reload(targetId, opts);
  }

  /** Captures a screenshot of this element's target. Works even on a `readonly` or queued element. */
  screenshot(opts?: CaptureOptions): Promise<CaptureResult> {
    const { client, targetId } = this.#requireClient();
    return client.capture(targetId, opts);
  }

  /** Requests the control lease for this element's target. Throws on a `readonly` element or one that does not currently own the live view (see `#requirePrimary`). */
  async takeControl(opts?: ControlRequestOptions): Promise<ControlOutcome> {
    const { client, targetId } = this.#requirePrimary();
    const outcome = await client.requestControl(targetId, opts);
    this.#applyControlOutcome(targetId, outcome);
    return outcome;
  }

  /** Releases this element's control lease, if it holds one. */
  async releaseControl(): Promise<void> {
    const { client, targetId } = this.#requirePrimary();
    await client.releaseControl(targetId);
    this.removeAttribute('has-control');
  }

  /**
   * Synthesises a left click (mouse down then up) at `(x, y)`, in CSS
   * pixels measured from this element's own top-left corner, exactly the
   * coordinate space a host script positions its own overlay elements in.
   * Acquires the control lease first if this element does not already
   * hold it, the same as a real first click through the canvas would.
   *
   * Named `clickAt`, not `click`: `HTMLElement` already declares a native,
   * zero-argument `click()` (it synthesises a click on the element itself,
   * for form/label semantics), and overriding it with an incompatible
   * signature is both a TypeScript error (`click` would no longer be
   * assignable to the base class's) and a footgun for any code, including
   * this package's own demo, that might call `el.click()` expecting the
   * native behaviour.
   */
  async clickAt(
    x: number,
    y: number,
    opts?: { button?: 'left' | 'middle' | 'right' },
  ): Promise<void> {
    const { client, targetId, handle } = this.#requirePrimary();
    if (!(await this.#ensureControl(client, targetId))) {
      throw new Error(
        `<browser-glass>: control was not granted for target "${targetId}"; clickAt() was not sent.`,
      );
    }
    const renderer = handle.renderer;
    if (!renderer)
      throw new Error('<browser-glass>: no renderer attached; clickAt() was not sent.');
    const rect = this.#canvasEl.getBoundingClientRect();
    const point = renderer.toFrame(rect.left + x, rect.top + y);
    const { fw, fh, gen } = renderer.frameSize();
    const base = { v: 1 as const, ts: Date.now(), targetId, fw, fh, gen, leaseId: '' };
    const button = opts?.button ?? 'left';
    client.sendInput({
      ...base,
      t: 'input.mouse',
      kind: 'down',
      x: point.x,
      y: point.y,
      button,
      buttons: 1,
      modifiers: 0,
      clickCount: 1,
    });
    client.sendInput({
      ...base,
      t: 'input.mouse',
      kind: 'up',
      x: point.x,
      y: point.y,
      button,
      buttons: 0,
      modifiers: 0,
    });
  }

  /**
   * Sends `text` as a single `input.text` insertion, the same wire path a
   * real IME autocomplete or paste uses (see
   * `packages/client/src/input/InputCapture.ts`'s `onBeforeInput`). Not a
   * per-key simulation: there is no synthesised `keydown`/`keyup` pair, so
   * a remote page listening for specific key codes rather than `input`
   * events will not see this. Acquires the control lease first if needed.
   */
  async type(text: string): Promise<void> {
    const { client, targetId, handle } = this.#requirePrimary();
    if (!(await this.#ensureControl(client, targetId))) {
      throw new Error(
        `<browser-glass>: control was not granted for target "${targetId}"; type() was not sent.`,
      );
    }
    const renderer = handle.renderer;
    const size = renderer ? renderer.frameSize() : { fw: 0, fh: 0, gen: 0 };
    client.sendInput({
      v: 1,
      ts: Date.now(),
      targetId,
      ...size,
      leaseId: '',
      t: 'input.text',
      text,
    });
  }

  /** Whether this element currently owns the live view for its target (`false` while queued behind a duplicate-target conflict, or before the first frame). */
  get isPrimary(): boolean {
    return this.#isPrimary;
  }

  /** The underlying `BrowserGlassClient` this element is using, or `null` before it has one. Shared across every `<browser-glass>` element pointed at the same `url`/`token` (see `./client-pool.js`); do not `destroy()` it directly. */
  get client(): BrowserGlassClient | null {
    return this.#client;
  }
}
