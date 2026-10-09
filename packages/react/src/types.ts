import type {
  BrowserGlassClient,
  CanvasFit,
  Capability,
  ClientTransportOptions,
  Codec,
  DprMode,
  FatalInfo,
  OverlayContext,
  QualityProfile,
} from '@browserglass/client';
import type { CSSProperties, ReactNode } from 'react';

/**
 * Options for {@link useBrowserGlass}. Everything except `url` is optional;
 * omitting `ticket`/`token`/`credentials` entirely is valid (the client
 * simply has nothing to connect with until `credentials` is supplied later
 * via a reconnect).
 */
export interface UseBrowserGlassOptions {
  /** `wss://` in production; `ws://` tolerated on `localhost` only. */
  url: string;
  /** Single-use admission ticket for the first connect. */
  ticket?: string;
  /** Bearer JWT. Node/test only in a browser context; falls back to `credentials`. */
  token?: string;
  /**
   * Called whenever the client needs a credential it does not have,
   * including the StrictMode double-mount `ticket_consumed` retry. Wraps
   * {@link UseBrowserGlassOptions.onTicketExpired} when both are supplied;
   * `credentials` wins if both are present.
   */
  credentials?: () => Promise<{ ticket?: string; token?: string }>;
  /** React-shaped credential refresh: `credentials` wraps this as `async () => ({ ticket: await onTicketExpired() })`. */
  onTicketExpired?: () => Promise<string>;
  /** Default `true`. */
  autoReconnect?: boolean;
  /** Folded into `hello` to save a round trip. */
  subscribe?: Array<{
    targetId: string;
    quality?: QualityProfile;
    codec?: Codec;
    maxFps?: number;
    thumbnail?: boolean;
    paused?: boolean;
  }>;
  /** Decode capabilities advertised in `hello.capabilities`. Default `['jpeg']`. */
  codecs?: Codec[];
  transport?: ClientTransportOptions;
  /** Default `false`. Publishes this viewer's cursor via `presence.cursor`; mirrors `<BrowserGlass sendCursor>`. */
  presenceCursor?: boolean;
  /** Default `true`. See `BrowserGlassClientOptions.keyboardLock`. */
  keyboardLock?: boolean;
  /** Shown to other viewers in presence. */
  label?: string;
  /** Default `false`. */
  debug?: boolean;
}

/**
 * What `<BrowserGlass overlay={(ctx) => ReactNode}>` is called with. Re-exported
 * from `@browserglass/client` (that package computes the dimming ladder centrally
 * so every framework layer renders the identical brightness/message pair).
 */
export type { OverlayContext };

/**
 * Behaviour for `dimOnDisconnect`'s per-state multiplier form. `false` (on
 * the prop itself) disables dimming entirely; this shape supplies the three
 * non-`live` multipliers when dimming is on. Matches
 * `BrowserGlassClient`'s own dimming ladder.
 */
export interface DimOnDisconnectLevels {
  degraded: number;
  reconnecting: number;
  fatal: number;
}

/** The full prop table for {@link BrowserGlass}. */
export interface BrowserGlassProps {
  /** Use an existing client instead of creating one. Required for multi-pane layouts sharing one socket. When given, this component never calls `connect()`/`destroy()` on it; the app owns that lifecycle. */
  client?: BrowserGlassClient;
  /** Required when `client` is absent. Relative resolves against `location.origin`. */
  url?: string;
  /** Admission ticket for first connect. */
  ticket?: string;
  /** The `credentials` client option, React-shaped. */
  onTicketExpired?: () => Promise<string>;
  /** Node/test only; falls back to the browser credential path when `client` is absent. */
  token?: string;
  /**
   * Transport-scoped socket tuning for the client this component creates
   * when `client` is absent, most commonly `transport.WebSocketImpl` for a
   * Node/test environment's own `WebSocket` implementation. This prop
   * exists because there is otherwise
   * no way to inject a transport into the owned-client (`url`/`ticket`)
   * path at all, which the StrictMode and unmount-ordering tests both need.
   * An app supplying its own
   * `client` configures transport there instead, via
   * `BrowserGlassClientOptions.transport`.
   */
  transport?: ClientTransportOptions;
  /** Omitted equals the instance's active target, tracked live. */
  targetId?: string;
  /** Default `'contain'`. */
  fit?: CanvasFit;
  /** Default `'auto'`. Initial quality request. */
  quality?: QualityProfile;
  /** Force codec, diagnostics only. */
  codec?: Codec;
  /** Default server default (30). */
  maxFps?: number;
  /** Default `false`. Implies `interactive={false}`. */
  thumbnail?: boolean;
  /** Default `false`. Toggling repaints from the retained bitmap. */
  paused?: boolean;
  /** Default `true`. `false` equals view-only: removes ALL listeners, not just ignores events. */
  interactive?: boolean;
  /** Default `'onInteract'`: request control on the first pointer/key event, release on unmount. */
  autoControl?: 'onInteract' | 'onMount' | 'never';
  /** Default server default (60000). Renewal is automatic regardless. */
  controlTtlMs?: number;
  /** Default `= interactive`. */
  keyboard?: boolean;
  /** Default `= interactive`. Always attached `{passive:false}`, never through JSX. */
  wheel?: boolean;
  /** Default `= interactive`. */
  touch?: boolean;
  /** Default `= interactive`. Needs the `upload` capability. Not wired yet; see `@browserglass/client`'s own `upload()` doc comment. */
  dropFiles?: boolean;
  /** Default `= interactive`. Needs clipboard capabilities. Not wired yet. */
  clipboard?: boolean;
  /** Default `true`. `true` suppresses the local browser menu and renders `<ContextMenu/>`. `'suppress-only'` suppresses and renders nothing (app supplies its own). `false` restores the viewer's own browser context menu. */
  contextMenu?: boolean | 'suppress-only';
  /** Default `false`. Runs `watchHover`, feeds `<StatusBar hoverUrl>`. */
  hoverProbe?: boolean;
  /** Default `true`. */
  smoothing?: boolean;
  /** Default `'transparent'`. */
  letterboxColour?: string;
  /** Default `'ignore'`. */
  dpr?: DprMode;
  /** Default `{degraded:0.6, reconnecting:0.4, fatal:0.25}`. `false` disables dimming entirely. */
  dimOnDisconnect?: boolean | DimOnDisconnectLevels;
  /** Default `true`. Built-in `<ConnectionBanner>`. */
  showBanner?: boolean;
  /** Default `3`. */
  bannerAfterAttempt?: number;
  /** Default `false`. Draws other viewers' cursors from `presence.cursor`. */
  showCursors?: boolean;
  /** Default `false`. Publishes this viewer's cursor. */
  sendCursor?: boolean;
  /** Receives connection state, stream info, and `toClient`. */
  overlay?: (ctx: OverlayContext) => ReactNode;
  /** Rendered before the first frame; no cached bitmap yet. Default: a built-in skeleton. */
  placeholder?: ReactNode;
  /** Default: a built-in panel. */
  errorFallback?: (err: FatalInfo) => ReactNode;
  onState?: (ev: { from: string; to: string; reason: string }) => void;
  onConnected?: (ev: { viewerId: string; sessionId: string; resumed: boolean }) => void;
  onDisconnected?: (ev: { code: number; reason: string; willReconnect: boolean }) => void;
  /** Hot path: keep this handler cheap. */
  onFrame?: (ev: { seq: number; width: number; height: number; decodeMs: number }) => void;
  onTargets?: (targets: readonly unknown[]) => void;
  onNav?: (state: { url: string; title: string; loading: boolean }) => void;
  onControl?: (ev: { targetId: string; hasControl: boolean }) => void;
  /** Non-fatal errors only; fatal errors go to `errorFallback`. */
  onError?: (err: { code: string; message: string }) => void;
  /** Unhandled means the built-in `<DialogPrompt/>` renders. */
  onDialog?: (ev: { dialogId: string; kind: string; message: string }) => void;
  /** Unhandled means the built-in `<FileChooserPrompt/>` renders. */
  onFileChooser?: (ev: { chooserId: string; multiple: boolean; accept: string[] }) => void;
  /** Default `false`. */
  debug?: boolean;
  className?: string;
  style?: CSSProperties;
  /** Container focusability, needed for keyboard capture. Default `0`. */
  tabIndex?: number;
  /** Default `'Remote browser'`. */
  'aria-label'?: string;
}

/** Re-exported so `@browserglass/react`'s own consumers rarely need a direct `@browserglass/client` dependency just for hook return-type annotations. */
export type { Capability, Codec, QualityProfile };
