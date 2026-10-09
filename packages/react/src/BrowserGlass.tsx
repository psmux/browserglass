'use client';

import { InputCapture } from '@browserglass/client';
import type {
  BrowserGlassClient,
  Capability,
  ClientEvents,
  ConnectionState,
  FatalInfo,
  ProbeResult,
  StreamHandle,
} from '@browserglass/client';
import type { ErrorMsg } from '@browserglass/protocol';
import type { ReactElement, MouseEvent as ReactMouseEvent } from 'react';
import { useCallback, useEffect, useState } from 'react';
import { useIsomorphicLayoutEffect } from './internal/dom.js';
import type { BrowserGlassProps, DimOnDisconnectLevels } from './types.js';
import { ConnectionBanner } from './ui/ConnectionBanner.js';
import { ContextMenu } from './ui/ContextMenu.js';
import { DialogPrompt } from './ui/DialogPrompt.js';
import { FileChooserPrompt } from './ui/FileChooserPrompt.js';
import { useBrowserGlass } from './useBrowserGlass.js';
import { useTargets } from './useTargets.js';

const EMPTY_GRANTED: ReadonlySet<Capability> = new Set();

interface ConnSnapshot {
  state: ConnectionState;
  reconnectAttempt: number;
  fatal: FatalInfo | null;
  error: ErrorMsg | null;
}

function initialConnSnapshot(): ConnSnapshot {
  return { state: 'idle', reconnectAttempt: 0, fatal: null, error: null };
}

/**
 * Tracks connection lifecycle fields directly off whichever client
 * `<BrowserGlass/>` ends up using, whether that client was created by
 * `useBrowserGlass` internally or supplied via the `client` prop. Kept
 * separate from `useBrowserGlass`'s own snapshot because that hook's
 * lifecycle state is only populated for the client it itself owns.
 */
function useConnectionSnapshot(client: BrowserGlassClient | null): ConnSnapshot {
  const [snap, setSnap] = useState<ConnSnapshot>(initialConnSnapshot);
  useEffect(() => {
    if (!client) {
      setSnap(initialConnSnapshot());
      return;
    }
    setSnap({ state: client.state, reconnectAttempt: 0, fatal: null, error: client.lastError });
    const offs = [
      client.on('state', (ev) => setSnap((s) => ({ ...s, state: ev.to }))),
      client.on('reconnecting', (ev) => setSnap((s) => ({ ...s, reconnectAttempt: ev.attempt }))),
      client.on('fatal', (ev) => setSnap((s) => ({ ...s, fatal: ev }))),
      client.on('error', (ev) => setSnap((s) => ({ ...s, error: ev }))),
      client.on('connected', () => setSnap((s) => ({ ...s, reconnectAttempt: 0, error: null }))),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client]);
  return snap;
}

function DefaultPlaceholder(): ReactElement {
  return (
    <div data-bgls-part="placeholder" className="bgls-placeholder">
      Connecting…
    </div>
  );
}

function DefaultErrorPanel({ fatal }: { fatal: FatalInfo }): ReactElement {
  return (
    <div data-bgls-part="error-panel" className="bgls-error-panel">
      <p data-bgls-part="error-message">{fatal.message}</p>
    </div>
  );
}

function dimLevelFor(state: ConnectionState, levels: DimOnDisconnectLevels): number {
  switch (state) {
    case 'degraded':
      return levels.degraded;
    case 'reconnecting':
    case 'resuming':
      return levels.reconnecting;
    case 'fatal':
      return levels.fatal;
    default:
      return 1;
  }
}

/**
 * The primary embed. Renders a canvas bound to one target's stream, handles
 * its own connection (or uses one supplied via `client`), captures pointer,
 * wheel, and keyboard input imperatively, and layers the built-in banner,
 * context menu, dialog, and file chooser prompts on top.
 *
 * `'use client'`: this module constructs a `WebSocket`-backed client,
 * touches `document`/canvas APIs, and calls `createImageBitmap` indirectly
 * through `@browserglass/client`'s renderer.
 */
export function BrowserGlass(props: BrowserGlassProps): ReactElement {
  const interactive = props.thumbnail ? false : (props.interactive ?? true);
  const keyboardEnabled = props.keyboard ?? interactive;
  const autoControl = props.autoControl ?? 'onInteract';
  const fit = props.fit ?? 'contain';
  const contextMenuMode = props.contextMenu ?? true;

  const ownsClient = props.client === undefined;
  const owned = useBrowserGlass({
    url: ownsClient ? (props.url ?? '') : '',
    ...(props.ticket !== undefined ? { ticket: props.ticket } : {}),
    ...(props.token !== undefined ? { token: props.token } : {}),
    ...(props.onTicketExpired !== undefined ? { onTicketExpired: props.onTicketExpired } : {}),
    ...(props.sendCursor !== undefined ? { presenceCursor: props.sendCursor } : {}),
    ...(props.debug !== undefined ? { debug: props.debug } : {}),
    ...(props.transport !== undefined ? { transport: props.transport } : {}),
  });
  const client = props.client ?? owned.client;

  const connSnap = useConnectionSnapshot(client);
  const connected =
    connSnap.state === 'live' || connSnap.state === 'degraded' || connSnap.state === 'resuming';

  const targetsResult = useTargets(client);
  const targetId = props.targetId ?? targetsResult.activeTargetId;

  const [handle, setHandle] = useState<StreamHandle | null>(null);
  const [containerEl, setContainerEl] = useState<HTMLDivElement | null>(null);
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null);
  const [menuState, setMenuState] = useState<{
    x: number;
    y: number;
    probe: ProbeResult | null;
  } | null>(null);
  const [activeDialog, setActiveDialog] = useState<ClientEvents['dialog'] | null>(null);
  const [activeChooser, setActiveChooser] = useState<ClientEvents['filechooser'] | null>(null);

  // ---- subscribe: one wire subscription per (client, targetId) pair ----
  useEffect(() => {
    setHandle(null);
    if (!client || !targetId || !connected) return;
    let cancelled = false;
    let created: StreamHandle | null = null;
    client
      .subscribe(targetId, {
        ...(props.quality !== undefined ? { quality: props.quality } : {}),
        ...(props.codec !== undefined ? { codec: props.codec } : {}),
        ...(props.maxFps !== undefined ? { maxFps: props.maxFps } : {}),
        thumbnail: props.thumbnail ?? false,
        paused: props.paused ?? false,
      })
      .then((h) => {
        if (cancelled) {
          void h.unsubscribe();
          return;
        }
        created = h;
        setHandle(h);
      })
      .catch(() => {
        // Surfaced already through the `error` event this component's
        // `onError` wiring below forwards; nothing further to do here.
      });
    return () => {
      cancelled = true;
      void created?.unsubscribe();
    };
  }, [
    client,
    targetId,
    connected,
    props.quality,
    props.codec,
    props.maxFps,
    props.thumbnail,
    props.paused,
  ]);

  // ---- attach: canvas renderer plus (when interactive) input capture,
  // constructed imperatively inside a layout effect. `InputCapture`'s own
  // constructor attaches wheel with `{passive:false}` directly via
  // `addEventListener`, never through a JSX prop; this effect is what makes
  // that construction happen before paint rather than as a JSX prop on the
  // canvas. Cleanup order matters: this effect (declared after the
  // subscribe effect above) cleans up FIRST on unmount, releasing any
  // acquired lease and destroying the input capture and renderer, before
  // the subscribe effect's own cleanup unsubscribes the stream, before
  // `useBrowserGlass`'s effect (declared before either) destroys an owned
  // client last. -----------------------------------------------------
  useIsomorphicLayoutEffect(() => {
    if (!handle || !canvasEl || !containerEl || !client) return;

    const renderer = handle.attach(canvasEl, containerEl, {
      fit,
      smoothing: props.smoothing ?? true,
      letterboxColour: props.letterboxColour ?? 'transparent',
      dpr: props.dpr ?? 'ignore',
    });

    let capture: InputCapture | null = null;
    let acquiredLease = false;
    let onFirstInteract: ((e: Event) => void) | null = null;

    const releaseIfHeld = (): void => {
      if (!acquiredLease) return;
      acquiredLease = false;
      void client.releaseControl(handle.targetId);
    };

    const requestOnce = (): void => {
      if (acquiredLease) return;
      acquiredLease = true;
      client
        .requestControl(handle.targetId, {
          ...(props.controlTtlMs !== undefined ? { ttlMs: props.controlTtlMs } : {}),
        })
        .then((outcome) => {
          if (outcome.granted) {
            capture?.setLeaseId(outcome.leaseId);
          } else {
            acquiredLease = false;
          }
        })
        .catch(() => {
          acquiredLease = false;
        });
    };

    if (interactive) {
      capture = new InputCapture(canvasEl, containerEl, {
        renderer,
        targetId: handle.targetId,
        leaseId: '',
        send: (msg) => client.sendInput(msg),
        keyboard: keyboardEnabled,
      });

      if (autoControl === 'onMount') {
        requestOnce();
      } else if (autoControl === 'onInteract') {
        onFirstInteract = () => requestOnce();
        canvasEl.addEventListener('pointerdown', onFirstInteract);
        canvasEl.addEventListener('keydown', onFirstInteract);
      }
    }

    let hoverUnsub: (() => void) | null = null;
    if (props.hoverProbe) {
      hoverUnsub = client.watchHover(handle.targetId, () => {
        // `<StatusBar hoverUrl>` reads this through the app's own state;
        // this component does not itself surface hover results.
      });
    }

    return () => {
      hoverUnsub?.();
      if (onFirstInteract) {
        canvasEl.removeEventListener('pointerdown', onFirstInteract);
        canvasEl.removeEventListener('keydown', onFirstInteract);
      }
      releaseIfHeld();
      capture?.destroy();
      handle.detach();
    };
  }, [
    handle,
    canvasEl,
    containerEl,
    client,
    interactive,
    keyboardEnabled,
    autoControl,
    fit,
    props.smoothing,
    props.letterboxColour,
    props.dpr,
    props.hoverProbe,
    props.controlTtlMs,
  ]);

  // ---- dimOnDisconnect override. `BrowserGlassClient` already applies its
  // own dimming ladder to every attached renderer automatically; this only
  // overrides that default when the app asked for `false` or custom levels.
  useEffect(() => {
    if (!handle?.renderer) return;
    const levels = props.dimOnDisconnect;
    if (levels === false) {
      handle.renderer.setDim(1);
      handle.renderer.setGreyscale(false);
      return;
    }
    if (typeof levels === 'object') {
      handle.renderer.setDim(dimLevelFor(connSnap.state, levels));
      handle.renderer.setGreyscale(connSnap.state === 'fatal');
    }
  }, [handle, connSnap.state, props.dimOnDisconnect]);

  // ---- lifecycle/event callback forwarding ----
  useEffect(() => {
    if (!client) return;
    const offs: Array<() => void> = [];
    if (props.onState)
      offs.push(
        client.on('state', (ev) =>
          props.onState?.({ from: ev.from, to: ev.to, reason: ev.reason }),
        ),
      );
    if (props.onConnected)
      offs.push(
        client.on('connected', (ev) =>
          props.onConnected?.({
            viewerId: ev.viewerId,
            sessionId: ev.sessionId,
            resumed: ev.resumed,
          }),
        ),
      );
    if (props.onDisconnected)
      offs.push(
        client.on('disconnected', (ev) =>
          props.onDisconnected?.({
            code: ev.code,
            reason: ev.reason,
            willReconnect: ev.willReconnect,
          }),
        ),
      );
    if (props.onTargets) offs.push(client.on('targets', (ev) => props.onTargets?.(ev.targets)));
    if (props.onControl && targetId)
      offs.push(
        client.on('control', () =>
          props.onControl?.({ targetId, hasControl: client.hasControl(targetId) }),
        ),
      );
    if (props.onError)
      offs.push(
        client.on('error', (ev) => props.onError?.({ code: ev.code, message: ev.message })),
      );
    offs.push(
      client.on('dialog', (ev) => {
        if (props.onDialog) props.onDialog(ev);
        else setActiveDialog(ev);
      }),
    );
    offs.push(
      client.on('filechooser', (ev) => {
        if (props.onFileChooser) props.onFileChooser(ev);
        else setActiveChooser(ev);
      }),
    );
    return () => {
      for (const off of offs) off();
    };
  }, [
    client,
    targetId,
    props.onState,
    props.onConnected,
    props.onDisconnected,
    props.onTargets,
    props.onControl,
    props.onError,
    props.onDialog,
    props.onFileChooser,
  ]);

  useEffect(() => {
    if (!handle || !props.onNav) return;
    // `nav` is a client-wide event filtered to this target; wiring it here
    // (rather than the block above) keeps it scoped to a live subscription.
    return client?.on('nav', (ev) => {
      if (ev.targetId === handle.targetId)
        props.onNav?.({ url: ev.url, title: ev.title, loading: ev.loading });
    });
  }, [handle, client, props.onNav]);

  useEffect(() => {
    if (!handle || !props.onFrame) return;
    return handle.on('frame', (ev) =>
      props.onFrame?.({ seq: ev.seq, width: ev.width, height: ev.height, decodeMs: ev.decodeMs }),
    );
  }, [handle, props.onFrame]);

  const handleContextMenu = useCallback(
    (e: ReactMouseEvent<HTMLCanvasElement>) => {
      if (contextMenuMode === false) return;
      e.preventDefault();
      if (contextMenuMode === 'suppress-only') {
        setMenuState(null);
        return;
      }
      if (!client || !handle) {
        setMenuState(null);
        return;
      }
      const p = handle.renderer?.toFrame(e.clientX, e.clientY);
      setMenuState({ x: e.clientX, y: e.clientY, probe: null });
      if (p?.inside) {
        client
          .probe(handle.targetId, p.x, p.y, { detail: 'hover' })
          .then((r) => setMenuState((s) => (s ? { ...s, probe: r } : s)))
          .catch(() => {
            // Probe failure/timeout: the menu just stays shorter.
          });
      }
    },
    [client, handle, contextMenuMode],
  );

  const overlayRenderer = props.overlay;
  const overlayNode =
    overlayRenderer && handle && handle.renderer
      ? overlayRenderer({
          state: connSnap.state,
          dim: 1,
          greyscale: connSnap.state === 'fatal',
          message: null,
          attempt: connSnap.state === 'reconnecting' ? connSnap.reconnectAttempt : null,
          stream: handle.info(),
          toClient: (x, y) => handle.renderer?.toClient(x, y) ?? { clientX: x, clientY: y },
        })
      : null;

  return (
    <div
      ref={setContainerEl}
      className={props.className}
      // `overflow: hidden` is load bearing, not decoration. `handle.attach()`
      // (in `@browserglass/client`) letterboxes the canvas for `fit:
      // 'contain'` by giving it a computed top/bottom margin so it centres
      // inside whatever box this container turns out to be, and that
      // computation can briefly overshoot right after a subscription
      // attaches, before the first resize settles it (observed: ~15-30px on
      // a freshly live pane). This container has no border or padding of its
      // own, so with `overflow` left at its default a canvas margin that
      // size collapses straight through it: the container's own top edge
      // gets pushed down by the same amount while its height stays fixed at
      // 100% of ITS parent, and the difference sticks out past the
      // container's bottom edge, over whatever this app stacked underneath
      // it (a "Take control" button here). The clicks were never dropped or
      // denied; they were landing on this div instead of the button beneath
      // it, silently, because the div is transparent and unlabelled.
      // Clipping here is the correct fix independent of why the margin was
      // briefly wrong: a sized container should not let its own children
      // paint or hit-test outside its box.
      style={{ position: 'relative', overflow: 'hidden', ...props.style }}
      tabIndex={props.tabIndex ?? 0}
      aria-label={props['aria-label'] ?? 'Remote browser'}
      data-bgls-part="browserglass-container"
    >
      <canvas
        ref={setCanvasEl}
        data-bgls-part="browserglass-canvas"
        onContextMenu={handleContextMenu}
        style={{ width: '100%', height: '100%', display: 'block' }}
      />
      {!handle && (props.placeholder ?? <DefaultPlaceholder />)}
      {connSnap.fatal &&
        (props.errorFallback ? (
          props.errorFallback(connSnap.fatal)
        ) : (
          <DefaultErrorPanel fatal={connSnap.fatal} />
        ))}
      {(props.showBanner ?? true) && (
        <ConnectionBanner
          state={connSnap.state}
          attempt={connSnap.reconnectAttempt}
          nextDelayMs={null}
          error={connSnap.fatal}
          afterAttempt={props.bannerAfterAttempt ?? 3}
        />
      )}
      {contextMenuMode === true && menuState && (
        <ContextMenu
          open
          x={menuState.x}
          y={menuState.y}
          granted={client?.granted ?? EMPTY_GRANTED}
          hasControl={targetId ? (client?.hasControl(targetId) ?? false) : false}
          probe={menuState.probe}
          onAction={() => setMenuState(null)}
          onClose={() => setMenuState(null)}
        />
      )}
      {activeDialog && !props.onDialog && (
        <DialogPrompt
          dialog={activeDialog}
          onAnswer={(accept, text) => {
            void client?.answerDialog(activeDialog.dialogId, accept, text);
            setActiveDialog(null);
          }}
        />
      )}
      {activeChooser && !props.onFileChooser && (
        <FileChooserPrompt
          chooser={activeChooser}
          onCancel={() => {
            void client?.answerFileChooser(activeChooser.chooserId, null);
            setActiveChooser(null);
          }}
        />
      )}
      {overlayNode}
    </div>
  );
}
