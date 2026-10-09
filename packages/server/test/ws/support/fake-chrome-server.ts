/**
 * A real, listening WebSocket server that speaks just enough of the Chrome
 * DevTools Protocol to drive `@browserglass/core`'s `CdpBridge` and
 * `TargetRegistry` for real, over a genuine socket, mirroring
 * `@browserglass/core`'s own `test/cdp/fake-cdp-endpoint.ts` responder logic
 * but as a real listening server instead of an in-memory `CdpWebSocketLike`.
 * `CdpBridge`'s production default transport (`defaultWebSocketFactory`,
 * Node 22's global `WebSocket`) connects to it exactly as it would connect
 * to real Chrome: nothing at the socket layer is mocked.
 */

import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

/** One CDP target this fake server reports via `Target.getTargets`. */
export interface FakeTargetInfo {
  targetId: string;
  type: string;
  title: string;
  url: string;
  attached: boolean;
  openerId?: string;
  browserContextId?: string;
  /**
   * The OS window `Browser.getWindowForTarget` answers for this target
   * (`TargetRegistry.windowIdFor`, window isolation's per-target window
   * tracking). Omit to leave it unset: `Browser.getWindowForTarget` then
   * replies `{}` (no `windowId` field), matching what `windowIdFor`
   * documents as Chrome's real behaviour for a target with no resolvable
   * window, and what every test written before window isolation already
   * silently relied on (a bare 'reply({})' catch-all covered this method
   * before it needed to mean anything).
   */
  windowId?: number;
}

/**
 * One `DOM.getDocument({depth: -1, pierce: true})` node, the shape
 * `@browserglass/core`'s `pagemap/dom-tree.ts` walks. Distinct from the
 * fixed, `nodeId`-only fallback the plain `DOM.getDocument`/`DOM.enable`
 * handler below answers with for every OTHER depth (`hit-test.ts`'s
 * `depth: 1`, `accessibility.ts`'s `depth: 0`, `listeners.ts`'s own
 * `depth: 0` document lookup): a page map capture needs `backendNodeId` on
 * every node, which none of those callers do.
 */
export interface PageMapRawDomNode {
  backendNodeId: number;
  nodeType: number;
  nodeName: string;
  localName?: string;
  nodeValue?: string;
  attributes?: readonly string[];
  frameId?: string;
  shadowRootType?: string;
  contentDocument?: PageMapRawDomNode;
  shadowRoots?: readonly PageMapRawDomNode[];
  children?: readonly PageMapRawDomNode[];
}

/**
 * One `DOMSnapshot.captureSnapshot` document entry, the shape
 * `@browserglass/core`'s `pagemap/snapshot.ts` decodes: dense `nodes`,
 * sparse `layout` keyed by `nodeIndex`. Loose enough to build a
 * hand-written fixture, matching `packages/core/test/pagemap/capture.test.ts`'s
 * own `MAIN_SNAPSHOT` fixture field-for-field.
 */
export interface PageMapRawSnapshotDocument {
  readonly nodes: { readonly backendNodeId: readonly number[] };
  readonly layout?: {
    readonly nodeIndex: readonly number[];
    readonly bounds: readonly (readonly number[])[];
    readonly paintOrders?: readonly number[];
    readonly styles?: readonly (readonly number[])[];
    readonly scrollRects?: readonly (readonly number[])[];
    readonly clientRects?: readonly (readonly number[])[];
  };
  readonly scrollOffsetX?: number;
  readonly scrollOffsetY?: number;
}

/** A full `DOMSnapshot.captureSnapshot` reply: one entry in `documents` per document (main plus same-process pierced children), sharing the one `strings` table. */
export interface PageMapRawSnapshot {
  readonly documents: readonly PageMapRawSnapshotDocument[];
  readonly strings: readonly string[];
}

/** One `Page.getFrameTree` node, the shape `@browserglass/core`'s `pagemap/frames.ts` flattens. */
export interface PageMapRawFrameTreeNode {
  readonly frame: {
    readonly id: string;
    readonly parentId?: string;
    readonly loaderId?: string;
    readonly url: string;
  };
  readonly childFrames?: readonly PageMapRawFrameTreeNode[];
}

/** One `Accessibility.getFullAXTree` node, the shape `@browserglass/core`'s `cdp/accessibility.ts` (`shapeNode`) reads. */
export interface PageMapRawAxNode {
  readonly ignored?: boolean;
  readonly role?: { readonly value?: string };
  readonly name?: { readonly value?: string };
  readonly backendDOMNodeId?: number;
  readonly properties?: readonly unknown[];
}

/** A live fake Chrome endpoint. */
export interface FakeChromeServer {
  readonly url: string;
  readonly targetInfos: FakeTargetInfo[];
  /** Every `Target.createTarget` call received, params exactly as sent, in call order. Lets a test assert what `TargetRegistry.create()` actually asked Chrome for (in particular, whether `newWindow` was included) without needing to inspect `core` internals. */
  readonly createTargetCalls: Array<{ url?: string; background?: boolean; newWindow?: boolean }>;
  /** Emits a `Page.screencastFrame` event on the session attached to `targetId`. */
  emitScreencastFrame(targetId: string, opts: { readonly base64Jpeg: string }): void;
  /** Emits a `Browser.downloadWillBegin` event on the session attached to `targetId`, exactly as real Chrome does once `DownloadBridge.start()` (`Page.setDownloadBehavior{eventsEnabled:true}`) has armed that session. */
  emitDownloadWillBegin(
    targetId: string,
    opts: { readonly guid: string; readonly url: string; readonly suggestedFilename: string },
  ): void;
  /** Emits a `Browser.downloadProgress` event on the session attached to `targetId`. `filePath` is included only when explicitly given, matching real Chrome's own behaviour of omitting it on older builds (`DownloadBridge`'s fallback path). */
  emitDownloadProgress(
    targetId: string,
    opts: {
      readonly guid: string;
      readonly state: 'inProgress' | 'completed' | 'canceled';
      readonly receivedBytes: number;
      readonly totalBytes?: number;
      readonly filePath?: string;
    },
  ): void;
  /**
   * Emits a `Fetch.authRequired` event, `authChallenge.source: 'Proxy'`,
   * on the session attached to `targetId`, exactly as real Chrome does
   * once `core/src/cdp/proxy-auth.ts`'s `ProxyAuthHandler.start()`
   * (`armProxyAuth`) has armed `Fetch` on that session. Lets a test drive
   * a real `Fetch.continueWithAuth` reply and assert on its params
   * (`packages/server/test/session/factory-proxy-auth.test.ts`'s "never
   * leaks beyond this one call" assertion) without needing a real
   * upstream proxy.
   */
  emitFetchAuthRequired(
    targetId: string,
    opts: { readonly requestId: string; readonly url?: string },
  ): void;
  /** Overrides what `Page.captureScreenshot` replies with (default {@link ONE_PX_JPEG_BASE64}). Lets a test control the encoded bytes `ManagedSession.capture()` decodes dimensions out of. */
  setCaptureScreenshot(base64Data: string): void;
  /** Overrides what `Page.printToPDF` replies with, as `{data: base64Data}` (default a small fixed placeholder). Lets a test control the byte count `ManagedSession.pdf()` measures to decide inline-versus-download delivery. */
  setPrintToPdf(base64Data: string): void;
  /** Sets what `Page.getLayoutMetrics` replies with as `cssLayoutViewport`. Unset (the default), the handler falls through to the catch-all `reply({})`, matching real Chrome's shape for a target whose metrics were never queried, and `queryRealViewport()` treats that as "unknown" the same way. */
  setLayoutViewport(clientWidth: number, clientHeight: number): void;
  /**
   * Installs the responder for `Runtime.evaluate`, so a `page.evaluate`
   * test can script exactly the `RemoteObject`/`exceptionDetails` shape
   * real Chrome would send for a value, a live object, an unserializable
   * primitive or a throw. Returning `undefined` from the responder means
   * "not handled", falling through to the catch-all `reply({})`.
   *
   * Deliberately a responder rather than a fixed reply, because the whole
   * point of the evaluate tests is that Chrome answers the SAME method
   * with half a dozen structurally different shapes, and the layer under
   * test has to have a defined answer for each.
   */
  setRuntimeEvaluate(fn: (params: Record<string, unknown>) => unknown): void;
  /**
   * Registers a DOM element this endpoint's `DOM.querySelector` will match.
   * `attributes` is CDP's own flat `[name, value, name, value, ...]` list,
   * so a file input is `['type', 'file']` and a multi-file one adds
   * `'multiple', ''` (a bare HTML attribute has an empty string value, not
   * an absent one, which is the case `file-input.ts` has to get right).
   * A selector never registered here matches nothing, exactly as a real
   * page would answer with `nodeId: 0`.
   */
  addElement(selector: string, nodeName: string, attributes: readonly string[]): void;
  /**
   * Registers what this endpoint answers for a HOVER hit test: the
   * `DOM.getNodeForLocation` + `DOM.describeNode` + `DOM.getBoxModel`
   * sequence `core`'s `hitTestAtPoint` sends, which is what
   * `ManagedSession.probe()` runs on every `target.probe`.
   *
   * `null` (the default) makes `DOM.getNodeForLocation` answer with the
   * protocol error real Chrome sends for a point with nothing under it,
   * `-32000 "No node found at given location"`, which is an ERROR and not
   * an empty result: a probe of empty space is the case a plausible
   * implementation crashes on rather than reporting `hit: false`.
   *
   * `attributes` is CDP's own flat `[name, value, ...]` list. `content` is
   * `DOM.getBoxModel`'s eight-number content quad (four corners, clockwise
   * from the top left, viewport CSS px); omit it to make Chrome refuse a
   * box model the way it does for `display: none`. `frameId` defaults to
   * the main frame, so set it to something else to model a node found
   * inside an iframe.
   */
  setHitTestNode(
    node: {
      readonly localName: string;
      readonly attributes?: readonly string[];
      readonly content?: readonly number[];
      readonly frameId?: string;
    } | null,
  ): void;
  /** Every CDP command this endpoint received, in call order, params and session id exactly as sent. The only way to assert on which commands a feature causes to go out, as opposed to what it returns. */
  readonly cdpCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId: string | undefined;
  }>;
  /**
   * Every `Input.*` command this endpoint received, in call order, params
   * exactly as sent.
   *
   * The only way to prove an input message actually REACHED the page.
   * `InputDispatcher` reports a gen-stale or fence-denied drop through
   * `onSignal`, and `core`'s `Session` wires `onSignal` to an empty
   * function (`session.ts`'s own comment: routing them to the wire was left
   * to a later task and never done), so a dropped input produces no error
   * reply, no log line and no wire traffic of any kind. A test asserting
   * "no error came back" therefore proves nothing at all: that is equally
   * true of an input that was silently discarded. Assert on this instead.
   */
  readonly inputCalls: Array<{ method: string; params: Record<string, unknown> }>;
  /** Every `DOM.setFileInputFiles` this endpoint received, in call order: the paths and the node they were attached to. */
  readonly setFileInputFilesCalls: Array<{ nodeId: number; files: string[] }>;
  /** Every `Runtime.evaluate` this endpoint received, params exactly as sent, in call order. Lets a test assert what actually reached Chrome (that a session id was attached, that `returnByValue` was set) without reaching into `core`. */
  readonly runtimeEvaluateCalls: Array<{
    params: Record<string, unknown>;
    sessionId: string | undefined;
  }>;
  /**
   * Emits `Network.requestWillBeSent` on the session attached to
   * `targetId`, mirroring `emitDownloadWillBegin`'s own pattern: a real,
   * scriptable CDP event rather than a stubbed reply, since `page.responsebody.get`'s
   * whole scoping bound depends on a real `requestId` having actually
   * travelled through `core`'s `TargetDiagnostics` and `ManagedSession`'s
   * own `network.request` fan-out, not on a value a test invented.
   */
  emitNetworkRequestWillBeSent(
    targetId: string,
    opts: {
      readonly requestId: string;
      readonly url: string;
      readonly method?: string;
      readonly resourceType?: string;
    },
  ): void;
  /** Emits `Network.responseReceived` on the session attached to `targetId`. */
  emitNetworkResponseReceived(
    targetId: string,
    opts: { readonly requestId: string; readonly status?: number },
  ): void;
  /** Emits `Network.loadingFinished` on the session attached to `targetId`, the terminal event `TargetDiagnostics.onLoadingFinished` needs before it emits a `network.request` payload at all. */
  emitNetworkLoadingFinished(targetId: string, opts: { readonly requestId: string }): void;
  /**
   * Installs the responder for `Network.getResponseBody`, mirroring
   * `setRuntimeEvaluate`'s own shape: returning `undefined` means "not
   * handled" (falls through to the catch-all `reply({})`, which lacks
   * `body`/`base64Encoded` and is therefore itself a useful shape for a
   * test that wants to see how a malformed reply is handled); returning
   * `{ error }` sends a raw CDP JSON-RPC error, exactly as real Chrome
   * does for `-32000 "No resource with given identifier found"` once a
   * body has been evicted or never existed.
   */
  setNetworkGetResponseBody(
    fn: (params: { readonly requestId: string }) =>
      | { readonly body: string; readonly base64Encoded: boolean }
      | { readonly error: { readonly code: number; readonly message: string } }
      | undefined,
  ): void;
  /**
   * Installs the raw `DOM.getDocument({depth: -1, pierce: true})` reply,
   * read only by a page map capture's own DOM tree walk
   * (`@browserglass/core`'s `pagemap/dom-tree.ts`). Distinct from the fixed,
   * depth-independent document every OTHER `DOM.getDocument` call gets from
   * this endpoint (see {@link PageMapRawDomNode}'s own doc): unset, a
   * `depth: -1` call answers with an empty `#document` node (no children),
   * which `buildDomTree` decodes successfully into a one-node, zero-child
   * tree rather than failing outright.
   */
  setPageMapDomTree(root: PageMapRawDomNode): void;
  /**
   * Installs the raw `DOMSnapshot.captureSnapshot` reply for a page map
   * capture (`pagemap/snapshot.ts`). Unset, every call answers
   * `{ documents: [], strings: [] }`, which `captureDomSnapshot` decodes
   * successfully into an empty node map rather than failing.
   */
  setPageMapSnapshot(snapshot: PageMapRawSnapshot): void;
  /**
   * Installs the responder for `Page.getFrameTree`, but ONLY for the page
   * map capture path: every other real caller of this method in this
   * codebase (`TargetRegistry.initPageDomain` on every ordinary target
   * attach, a `CdpBridge` reconnect) keeps getting the unset catch-all
   * `reply({})` it always has, because this responder answers nothing at
   * all until a test installs it.
   */
  setPageMapFrameTree(frameTree: PageMapRawFrameTreeNode): void;
  /**
   * Registers the `DOM.getFrameOwner`/`DOM.getBoxModel` pair
   * `pagemap/frames.ts` sends, on the frame's PARENT session, to compute a
   * non-main frame's document-space offset. `frameId` is the CHILD frame
   * (`DOM.getFrameOwner({frameId})`'s own param); `backendNodeId`/`content`
   * answer the owner element's box model (CDP's own eight-number content
   * quad, viewport CSS px). A frame with no entry here falls through to the
   * catch-all `reply({})` for `DOM.getFrameOwner`, which `frames.ts` records
   * as a per-frame `phase: 'frameTree'` failure and excludes from the
   * capture entirely, so a test exercising a per-frame ACCESSIBILITY
   * failure (as opposed to a frame-tree one) must register this first or
   * that frame never reaches Phase B at all.
   */
  setPageMapFrameOwner(
    frameId: string,
    opts: { readonly backendNodeId: number; readonly content: readonly number[] },
  ): void;
  /**
   * Installs the responder for `Accessibility.getFullAXTree`, scriptable
   * per call the way {@link setRuntimeEvaluate} is, keyed on the request's
   * own `frameId` (`ax-merge.ts` calls this once per frame, main frame
   * included, always passing its `frameId` explicitly). Returning an
   * `Error` fails that one call, exactly the per-frame degrade
   * `mergeAccessibility` already handles. Unset, every call answers
   * `{ nodes: [] }`: a read that succeeded and named nothing.
   */
  setPageMapAccessibility(
    fn: (params: { readonly frameId?: string }) =>
      | { readonly nodes: readonly PageMapRawAxNode[] }
      | Error,
  ): void;
  /**
   * Installs the responder for `DOMDebugger.getEventListeners`, the
   * listener-signal phase's one call (`pagemap/listeners.ts`'s
   * `mintClickListenerNodes`), same scriptable shape as
   * {@link setPageMapAccessibility}. Unset, every call answers
   * `{ listeners: [] }`: the signal ran and found nothing.
   */
  setPageMapEventListeners(
    fn: (params: Record<string, unknown>) => { readonly listeners: readonly unknown[] } | Error,
  ): void;
  close(): Promise<void>;
}

const ONE_PX_JPEG_BASE64 =
  '/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCdABmX/9k=';

/** `btoa('%PDF-1.4 fake')`, a tiny placeholder `Page.printToPDF` reply, well under `MAX_INLINE_PDF_BYTES`; a size test overrides it via `setPrintToPdf`. */
const TINY_PDF_BASE64 = 'JVBERi0xLjQgZmFrZQ==';

/** Starts a {@link FakeChromeServer} on an ephemeral loopback port. */
export async function startFakeChromeServer(): Promise<FakeChromeServer> {
  const targetInfos: FakeTargetInfo[] = [];
  const sessionsByTargetId = new Map<string, string>();
  const socketBySessionId = new Map<string, WebSocket>();
  const createTargetCalls: Array<{ url?: string; background?: boolean; newWindow?: boolean }> = [];
  const elementsBySelector = new Map<
    string,
    { nodeId: number; nodeName: string; attributes: readonly string[] }
  >();
  const setFileInputFilesCalls: Array<{ nodeId: number; files: string[] }> = [];
  let nextNodeId = 100;
  let attachCounter = 0;
  let createCounter = 0;
  // Starts well clear of the small integers (1, 2, 3, ...) a test typically
  // hand-picks for `addTarget({ windowId })` fixtures, so an auto-assigned
  // `newWindow: true` window id can never collide with one a test set
  // explicitly.
  let nextAutoWindowId = 1000;
  let captureScreenshotBase64 = ONE_PX_JPEG_BASE64;
  let printToPdfBase64 = TINY_PDF_BASE64;
  const runtimeEvaluateCalls: Array<{
    params: Record<string, unknown>;
    sessionId: string | undefined;
  }> = [];
  let runtimeEvaluate: ((params: Record<string, unknown>) => unknown) | null = null;
  let networkGetResponseBody:
    | ((params: { readonly requestId: string }) =>
        | { readonly body: string; readonly base64Encoded: boolean }
        | { readonly error: { readonly code: number; readonly message: string } }
        | undefined)
    | null = null;
  let layoutViewport: { clientWidth: number; clientHeight: number } | null = null;
  const inputCalls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const cdpCalls: Array<{
    method: string;
    params: Record<string, unknown>;
    sessionId: string | undefined;
  }> = [];
  /** The one backend node id every hit test answer uses; `DOM.getNodeForLocation` returns no `nodeId` for a node not already pushed to the frontend, so this is the only handle the follow-up calls may use. */
  const HIT_BACKEND_NODE_ID = 9;
  const MAIN_FRAME_ID = 'FRAME_MAIN';
  let hitTestNode: {
    localName: string;
    attributes?: readonly string[];
    content?: readonly number[];
    frameId?: string;
  } | null = null;
  let pageMapDomTree: PageMapRawDomNode | null = null;
  let pageMapSnapshot: PageMapRawSnapshot | null = null;
  let pageMapFrameTree: PageMapRawFrameTreeNode | null = null;
  const pageMapFrameOwners = new Map<
    string,
    { backendNodeId: number; content: readonly number[] }
  >();
  let pageMapAccessibility:
    | ((params: { frameId?: string }) => { nodes: readonly PageMapRawAxNode[] } | Error)
    | null = null;
  let pageMapEventListeners:
    | ((params: Record<string, unknown>) => { listeners: readonly unknown[] } | Error)
    | null = null;

  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));

  wss.on('connection', (ws) => {
    ws.on('message', (raw) => {
      let msg: { id: number; method: string; params?: Record<string, unknown>; sessionId?: string };
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }
      const reply = (result: unknown): void => {
        ws.send(
          JSON.stringify({
            id: msg.id,
            result,
            ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
          }),
        );
      };

      // Recorded before dispatch and deliberately NOT returned early: every
      // `Input.*` command still falls through to the catch-all `reply({})`
      // below, exactly as before.
      if (msg.method.startsWith('Input.')) {
        inputCalls.push({ method: msg.method, params: msg.params ?? {} });
      }
      cdpCalls.push({ method: msg.method, params: msg.params ?? {}, sessionId: msg.sessionId });

      // The hover hit test (`core`'s `cdp/hit-test.ts`). Deliberately
      // ahead of the generic `DOM.describeNode` responder below, which
      // answers `nodeId` lookups for `setFileInputFiles` and knows nothing
      // about backend node ids.
      if (msg.method === 'DOM.getNodeForLocation') {
        if (hitTestNode === null) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: 'No node found at given location' },
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
          return;
        }
        reply({
          backendNodeId: HIT_BACKEND_NODE_ID,
          frameId: hitTestNode.frameId ?? MAIN_FRAME_ID,
        });
        return;
      }
      if (
        msg.method === 'DOM.getBoxModel' &&
        msg.params?.['backendNodeId'] === HIT_BACKEND_NODE_ID
      ) {
        if (!hitTestNode?.content) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: 'Could not compute box model.' },
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
          return;
        }
        const q = hitTestNode.content;
        reply({
          model: {
            content: [...q],
            width: (q[2] ?? 0) - (q[0] ?? 0),
            height: (q[5] ?? 0) - (q[1] ?? 0),
          },
        });
        return;
      }
      if (
        msg.method === 'DOM.describeNode' &&
        msg.params?.['backendNodeId'] === HIT_BACKEND_NODE_ID
      ) {
        reply(
          hitTestNode
            ? {
                node: {
                  backendNodeId: HIT_BACKEND_NODE_ID,
                  nodeType: 1,
                  nodeName: hitTestNode.localName.toUpperCase(),
                  localName: hitTestNode.localName,
                  attributes: [...(hitTestNode.attributes ?? [])],
                },
              }
            : {},
        );
        return;
      }

      // Page map capture (`@browserglass/core`'s `pagemap/*.ts`). Every
      // branch here is additive: unset, each one either falls through to
      // the existing catch-all `reply({})` (so a non-pagemap test's own
      // assumptions about, say, `Page.getFrameTree` are unaffected), or
      // answers with a documented "ran, found nothing" empty default (see
      // each `FakeChromeServer` setter's own doc for which).
      if (msg.method === 'DOM.getDocument' && msg.params?.['depth'] === -1) {
        reply({
          root: pageMapDomTree ?? {
            backendNodeId: 1,
            nodeType: 9,
            nodeName: '#document',
            children: [],
          },
        });
        return;
      }
      if (msg.method === 'DOMSnapshot.captureSnapshot') {
        reply(pageMapSnapshot ?? { documents: [], strings: [] });
        return;
      }
      if (msg.method === 'Page.getFrameTree' && pageMapFrameTree !== null) {
        reply({ frameTree: pageMapFrameTree });
        return;
      }
      if (msg.method === 'DOM.getFrameOwner') {
        const frameId = msg.params?.['frameId'] as string | undefined;
        const owner = frameId !== undefined ? pageMapFrameOwners.get(frameId) : undefined;
        if (owner) {
          reply({ backendNodeId: owner.backendNodeId });
          return;
        }
        // No registration for this frame: falls through to the catch-all
        // `reply({})` below, which `frames.ts` records as a per-frame
        // `phase: 'frameTree'` failure. See `setPageMapFrameOwner`'s own
        // doc.
      }
      if (msg.method === 'DOM.getBoxModel') {
        const backendNodeId = msg.params?.['backendNodeId'] as number | undefined;
        if (backendNodeId !== undefined && backendNodeId !== HIT_BACKEND_NODE_ID) {
          const owner = [...pageMapFrameOwners.values()].find(
            (o) => o.backendNodeId === backendNodeId,
          );
          if (owner) {
            reply({ model: { content: [...owner.content] } });
            return;
          }
        }
        // Not a registered page-map frame owner: falls through (the
        // existing hit-test-specific `DOM.getBoxModel` branch above already
        // returned for `HIT_BACKEND_NODE_ID`; anything else reaches the
        // catch-all `reply({})`).
      }
      if (msg.method === 'DOM.resolveNode') {
        // `pagemap/listeners.ts`'s own document resolve, the sole caller of
        // this method in this codebase. One fixed objectId is enough: this
        // endpoint never actually holds a live object, only echoes an id
        // back for `DOMDebugger.getEventListeners` and `Runtime.releaseObject`
        // to reference.
        reply({ object: { objectId: 'pagemap-doc-object' } });
        return;
      }
      if (msg.method === 'Accessibility.getFullAXTree') {
        const params = (msg.params ?? {}) as { frameId?: string };
        const scripted = pageMapAccessibility?.(params) ?? { nodes: [] };
        if (scripted instanceof Error) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: scripted.message },
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
          return;
        }
        reply(scripted);
        return;
      }
      if (msg.method === 'DOMDebugger.getEventListeners') {
        const params = msg.params ?? {};
        const scripted = pageMapEventListeners?.(params) ?? { listeners: [] };
        if (scripted instanceof Error) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: { code: -32000, message: scripted.message },
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
          return;
        }
        reply(scripted);
        return;
      }

      if (msg.method === 'Browser.getVersion') {
        reply({
          protocolVersion: '1.3',
          product: 'Chrome/131.0.6778.86',
          revision: '@abcdef',
          userAgent: 'Mozilla/5.0 (fake)',
          jsVersion: '13.1.0',
        });
        return;
      }
      if (msg.method === 'Target.getTargets') {
        reply({ targetInfos });
        return;
      }
      if (msg.method === 'Target.attachToTarget') {
        const targetId = msg.params?.['targetId'] as string;
        attachCounter += 1;
        const sessionId = `S_${targetId}_${attachCounter}`;
        sessionsByTargetId.set(targetId, sessionId);
        socketBySessionId.set(sessionId, ws);
        reply({ sessionId });
        return;
      }
      if (msg.method === 'Runtime.evaluate') {
        const params = msg.params ?? {};
        runtimeEvaluateCalls.push({ params, sessionId: msg.sessionId });
        const scripted = runtimeEvaluate?.(params);
        reply(scripted === undefined ? {} : scripted);
        return;
      }
      if (msg.method === 'Network.getResponseBody') {
        const params = (msg.params ?? {}) as { requestId: string };
        const scripted = networkGetResponseBody?.(params);
        if (scripted === undefined) {
          reply({});
          return;
        }
        if ('error' in scripted) {
          ws.send(
            JSON.stringify({
              id: msg.id,
              error: scripted.error,
              ...(msg.sessionId ? { sessionId: msg.sessionId } : {}),
            }),
          );
          return;
        }
        reply(scripted);
        return;
      }
      // The DOM domain, enough of it for `core`'s `setFileInputFiles`:
      // `DOM.getDocument` returns a root id, `DOM.querySelector` matches
      // whatever `addElement` registered (and answers `nodeId: 0` for
      // anything else, which is CDP's own "no match" and not an error),
      // `DOM.describeNode` reports the registered shape, and
      // `DOM.setFileInputFiles` is recorded rather than acted on.
      if (msg.method === 'DOM.getDocument' || msg.method === 'DOM.enable') {
        reply(
          msg.method === 'DOM.enable'
            ? {}
            : {
                root: {
                  nodeId: 1,
                  nodeName: '#document',
                  // `hitTestAtPoint` reads the base URL from here to
                  // absolutise a relative `href`, and the main frame's id
                  // from the element child, to tell a node in this
                  // document from one inside an iframe.
                  documentURL: 'https://fake.test/',
                  baseURL: 'https://fake.test/sub/',
                  children: [
                    { nodeType: 10, nodeName: 'html' },
                    { nodeType: 1, nodeName: 'HTML', localName: 'html', frameId: MAIN_FRAME_ID },
                  ],
                },
              },
        );
        return;
      }
      if (msg.method === 'DOM.querySelector') {
        const selector = (msg.params?.['selector'] as string | undefined) ?? '';
        const found = elementsBySelector.get(selector);
        reply({ nodeId: found?.nodeId ?? 0 });
        return;
      }
      if (msg.method === 'DOM.describeNode') {
        const nodeId = (msg.params?.['nodeId'] as number | undefined) ?? 0;
        const found = [...elementsBySelector.values()].find((e) => e.nodeId === nodeId);
        reply(
          found
            ? { node: { nodeId, nodeName: found.nodeName, attributes: [...found.attributes] } }
            : {},
        );
        return;
      }
      if (msg.method === 'DOM.setFileInputFiles') {
        setFileInputFilesCalls.push({
          nodeId: (msg.params?.['nodeId'] as number | undefined) ?? 0,
          files: [...((msg.params?.['files'] as string[] | undefined) ?? [])],
        });
        reply({});
        return;
      }
      if (msg.method === 'Page.captureScreenshot') {
        reply({ data: captureScreenshotBase64 });
        return;
      }
      if (msg.method === 'Page.printToPDF') {
        reply({ data: printToPdfBase64 });
        return;
      }
      if (msg.method === 'Page.getLayoutMetrics') {
        // `cssVisualViewport` is always present (a page map capture's own
        // `mainViewport`/`currentScroll` reads, `pagemap/capture.ts` and
        // `pagemap/frames.ts`, need it unconditionally), unlike
        // `cssLayoutViewport`, which stays opt-in via `setLayoutViewport`:
        // `queryRealViewport`'s own "falls back to the documented default
        // when the browser cannot answer" test depends on that field being
        // absent until a test sets it.
        reply({
          ...(layoutViewport ? { cssLayoutViewport: layoutViewport } : {}),
          cssVisualViewport: {
            pageX: 0,
            pageY: 0,
            clientWidth: layoutViewport?.clientWidth ?? 1024,
            clientHeight: layoutViewport?.clientHeight ?? 768,
          },
        });
        return;
      }
      if (msg.method === 'Target.createTarget') {
        const params = (msg.params ?? {}) as {
          url?: string;
          background?: boolean;
          newWindow?: boolean;
        };
        createTargetCalls.push(params);
        createCounter += 1;
        const targetId = `fake-created-${createCounter}`;
        const info: FakeTargetInfo = {
          targetId,
          type: 'page',
          title: '',
          url: params.url ?? 'about:blank',
          attached: false,
        };
        // A real `newWindow: true` gets its own OS window; real Chrome
        // without it opens the target as a tab of the browser's one
        // existing window. Mirrored here as a fresh, never-before-used
        // window id per `newWindow` call; a target created without it gets
        // no `windowId` at all (falls through to the same "unresolved"
        // response `Browser.getWindowForTarget` gives below), which is
        // enough for a test to tell the two cases apart.
        if (params.newWindow) {
          nextAutoWindowId += 1;
          info.windowId = nextAutoWindowId;
        }
        targetInfos.push(info);
        reply({ targetId });
        return;
      }
      if (msg.method === 'Target.getTargetInfo') {
        const targetId = (msg.params?.['targetId'] as string | undefined) ?? '';
        const info = targetInfos.find((t) => t.targetId === targetId);
        reply({
          targetInfo: info ?? {
            targetId,
            type: 'page',
            title: '',
            url: 'about:blank',
            attached: false,
          },
        });
        return;
      }
      if (msg.method === 'Browser.getWindowForTarget') {
        const targetId = (msg.params?.['targetId'] as string | undefined) ?? '';
        const info = targetInfos.find((t) => t.targetId === targetId);
        // No `windowId` field at all (not even `null`) when unset, exactly
        // like real Chrome's response shape; `TargetRegistry.windowIdFor`
        // treats a missing field the same as a failed call, both resolving
        // to `null` (see its own doc comment).
        reply(info?.windowId === undefined ? {} : { windowId: info.windowId });
        return;
      }
      reply({});
    });
  });

  const address = wss.address() as AddressInfo;
  const url = `ws://127.0.0.1:${address.port}`;

  return {
    url,
    targetInfos,
    createTargetCalls,
    inputCalls,
    setCaptureScreenshot(base64Data) {
      captureScreenshotBase64 = base64Data;
    },
    setPrintToPdf(base64Data) {
      printToPdfBase64 = base64Data;
    },
    setLayoutViewport(clientWidth, clientHeight) {
      layoutViewport = { clientWidth, clientHeight };
    },
    runtimeEvaluateCalls,
    setRuntimeEvaluate(fn) {
      runtimeEvaluate = fn;
    },
    setNetworkGetResponseBody(fn) {
      networkGetResponseBody = fn;
    },
    setFileInputFilesCalls,
    addElement(selector, nodeName, attributes) {
      nextNodeId += 1;
      elementsBySelector.set(selector, { nodeId: nextNodeId, nodeName, attributes });
    },
    cdpCalls,
    setHitTestNode(node) {
      hitTestNode = node === null ? null : { ...node };
    },
    emitScreencastFrame(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Page.screencastFrame',
          sessionId,
          params: {
            data: opts.base64Jpeg,
            metadata: {
              deviceWidth: 1440,
              deviceHeight: 900,
              pageScaleFactor: 1,
              scrollOffsetX: 0,
              scrollOffsetY: 0,
              timestamp: Date.now() / 1000,
            },
            sessionId: 1,
          },
        }),
      );
    },
    emitFetchAuthRequired(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Fetch.authRequired',
          sessionId,
          params: {
            requestId: opts.requestId,
            request: { url: opts.url ?? 'https://a.example/', method: 'GET', headers: {} },
            frameId: MAIN_FRAME_ID,
            resourceType: 'Document',
            authChallenge: {
              source: 'Proxy',
              origin: 'http://proxy.example:8080',
              scheme: 'basic',
              realm: '',
            },
          },
        }),
      );
    },
    emitDownloadWillBegin(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Browser.downloadWillBegin',
          sessionId,
          params: {
            frameId: MAIN_FRAME_ID,
            guid: opts.guid,
            url: opts.url,
            suggestedFilename: opts.suggestedFilename,
          },
        }),
      );
    },
    emitDownloadProgress(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Browser.downloadProgress',
          sessionId,
          params: {
            guid: opts.guid,
            state: opts.state,
            receivedBytes: opts.receivedBytes,
            ...(opts.totalBytes !== undefined ? { totalBytes: opts.totalBytes } : {}),
            ...(opts.filePath !== undefined ? { filePath: opts.filePath } : {}),
          },
        }),
      );
    },
    emitNetworkRequestWillBeSent(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Network.requestWillBeSent',
          sessionId,
          params: {
            requestId: opts.requestId,
            request: { url: opts.url, method: opts.method ?? 'GET' },
            type: opts.resourceType ?? 'XHR',
            wallTime: Date.now() / 1000,
            timestamp: Date.now() / 1000,
          },
        }),
      );
    },
    emitNetworkResponseReceived(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Network.responseReceived',
          sessionId,
          params: { requestId: opts.requestId, response: { status: opts.status ?? 200 } },
        }),
      );
    },
    emitNetworkLoadingFinished(targetId, opts) {
      const sessionId = sessionsByTargetId.get(targetId);
      const socket = sessionId ? socketBySessionId.get(sessionId) : undefined;
      if (!socket || !sessionId) return;
      socket.send(
        JSON.stringify({
          method: 'Network.loadingFinished',
          sessionId,
          params: { requestId: opts.requestId, timestamp: Date.now() / 1000, encodedDataLength: 0 },
        }),
      );
    },
    setPageMapDomTree(root) {
      pageMapDomTree = root;
    },
    setPageMapSnapshot(snapshot) {
      pageMapSnapshot = snapshot;
    },
    setPageMapFrameTree(frameTree) {
      pageMapFrameTree = frameTree;
    },
    setPageMapFrameOwner(frameId, opts) {
      pageMapFrameOwners.set(frameId, { backendNodeId: opts.backendNodeId, content: opts.content });
    },
    setPageMapAccessibility(fn) {
      pageMapAccessibility = fn;
    },
    setPageMapEventListeners(fn) {
      pageMapEventListeners = fn;
    },
    async close() {
      await new Promise<void>((resolve, reject) =>
        wss.close((err) => (err ? reject(err) : resolve())),
      );
    },
  };
}

/** A ready-to-use one-pixel JPEG, base64 encoded, for `emitScreencastFrame`. */
export { ONE_PX_JPEG_BASE64 };
