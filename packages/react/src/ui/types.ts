import type {
  Capability,
  ConnectionState,
  FatalInfo,
  LeaseState,
  ProbeResult,
  QualityProfile,
  TargetSummary,
} from '@browserglass/client';
import type { ClientEvents } from '@browserglass/client';
import type { ReactNode } from 'react';
import type { Driver, PresenceCursor } from '../usePresence.js';

/** Shared by every UI primitive: a merged `className` and, on the outermost element, `data-bgls-part`. */
export interface BaseUiProps {
  className?: string;
}

/** Props for `<TabStrip/>`. */
export interface TabStripProps extends BaseUiProps {
  targets: TargetSummary[];
  activeTargetId: string | null;
  onSelect: (targetId: string) => void;
  onClose?: (targetId: string) => void;
  onNew?: () => void;
  onReorder?: (targetIds: string[]) => void;
  /** `false` hides close/new/reorder affordances. */
  canManage: boolean;
  renderTitle?: (target: TargetSummary) => ReactNode;
}

/** A navigation blocked by policy, as surfaced to `<AddressBar/>`. */
export interface AddressBarBlocked {
  url: string;
  rule?: string;
  message: string;
}

/** Props for `<AddressBar/>`. See `AddressBar.tsx` for the focus/dirty rule this component implements. */
export interface AddressBarProps extends BaseUiProps {
  url: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  canNavigate: boolean;
  securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
  onNavigate: (url: string) => void;
  onBack?: () => void;
  onForward?: () => void;
  onReload?: () => void;
  onStop?: () => void;
  blocked: AddressBarBlocked | null;
  onDismissBlocked?: () => void;
  placeholder?: string;
  renderAction?: () => ReactNode;
}

/** Props for `<StatusBar/>`. Deliberately minimal: a progress line, a security icon, and the hover link target. Not allowed to grow into a toolbar. */
export interface StatusBarProps extends BaseUiProps {
  progress: number | null;
  loading: boolean;
  url: string;
  /** UNTRUSTED, page-derived; always rendered as text. */
  hoverUrl?: string | null;
  securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
  compact?: boolean;
}

/** One item in `<ContextMenu/>`'s built-in menu. */
export interface ContextMenuItem {
  id: string;
  label: string;
  disabled?: boolean;
}

/** Props for `<ContextMenu/>`. See `ContextMenu.tsx` for the open-immediately/probe-fills-in, double href validation, and unconditional `preventDefault()` rules. */
export interface ContextMenuProps extends BaseUiProps {
  open: boolean;
  x: number;
  y: number;
  granted: ReadonlySet<Capability>;
  hasControl: boolean;
  /** `null` while the probe is in flight or was never fired; `hit:false` once it lands with nothing under the pointer. */
  probe: ProbeResult | null;
  /** Extra app-supplied items, appended after the built-in ones. */
  items?: ContextMenuItem[];
  onAction: (id: string) => void;
  onClose: () => void;
  renderItem?: (item: ContextMenuItem) => ReactNode;
}

/** Props for `<ControlBadge/>`. */
export interface ControlBadgeProps extends BaseUiProps {
  lease: LeaseState | null;
  /** This viewer's own id, to distinguish "you are driving" from "{name} is driving". */
  myViewerId: string | null;
  /**
   * Everyone driving this target, when the caller knows. Omitted, the badge
   * reads `lease.holderViewerId`, which names exactly one person and is the
   * whole truth only in exclusive mode. Supplied, this wins: with several
   * concurrent drivers "You are driving" is true and still misleading,
   * because it leaves out the two other people typing into the same page.
   *
   * `driversOf()` from `@browserglass/react` builds this from presence.
   */
  drivers?: readonly Driver[];
  /**
   * Renders the lease's own `mode` next to the label. Off by default so
   * nothing appears in an app that never offered a second mode; on, a
   * viewer can tell "I am driving, and so can anyone else" apart from
   * "I am driving, and everyone else is queued behind me", which are two
   * very different things to be told about the same page.
   */
  showMode?: boolean;
  showAvatar?: boolean;
  compact?: boolean;
}

/** Props for `<RequestControlButton/>`. Three states in one control: take / request+queue / release. */
export interface RequestControlButtonProps extends BaseUiProps {
  lease: LeaseState | null;
  myViewerId: string | null;
  canRequest: boolean;
  requesting?: boolean;
  onRequest: (reason?: string) => void;
  onRelease: () => void;
  reason?: string;
  /**
   * Whether this viewer is one of the current drivers. Omitted, the button
   * falls back to `lease.holderViewerId === myViewerId`. In shared mode
   * that comparison is wrong for every driver but one, so a caller with
   * several drivers in hand should pass this explicitly.
   */
  iAmDriving?: boolean;
  /**
   * The target's lease mode, which decides what the button can honestly
   * promise. `'shared'` never shows a queue, because in shared mode there
   * is nothing to queue behind: the grant is immediate. Omitted, the mode
   * is read off `lease.mode`, and a null lease is treated as exclusive,
   * which is the SDK default.
   */
  mode?: LeaseState['mode'];
}

/**
 * Props for `<CursorLayer/>`.
 *
 * Rendered through `<BrowserGlass overlay={...}>`, which is the only place
 * `toClient` exists: it belongs to that pane's renderer and already knows
 * the letterboxing and scale that map one frame pixel onto one screen
 * pixel for THIS viewer's canvas size.
 */
export interface CursorLayerProps extends BaseUiProps {
  /** Every cursor known to the session; this component filters by `targetId` itself. `usePresence().cursors.values()` is the intended argument. */
  cursors: Iterable<PresenceCursor>;
  /** Only cursors on this target are drawn. */
  targetId: string;
  /** Never drawn: this viewer already has a real mouse pointer on screen, and a second one lagging 40ms behind it is worse than nothing. */
  myViewerId: string | null;
  /** Frame space to client (viewport) coordinates, straight from `OverlayContext.toClient`. */
  toClient: (x: number, y: number) => { clientX: number; clientY: number };
  /** Viewers driving this target, drawn solid rather than hollow. Everyone else is watching. */
  drivingViewerIds?: readonly string[];
  /** A cursor nobody has moved for this long stops being drawn. Default 8000. */
  staleAfterMs?: number;
}

/** Props for `<ViewerList/>`. */
export interface ViewerListProps extends BaseUiProps {
  viewers: ClientEvents['presence']['viewers'];
  myViewerId: string | null;
  /**
   * Draws a marker beside anyone whose `controlling` list is non-empty.
   * Default `true`. The `data-bgls-driving` attribute has always carried
   * this, but an attribute only styles; with several people driving at
   * once the list is the one place the whole room is visible, and it has
   * to say who is driving without the app writing its own CSS first.
   */
  showDriving?: boolean;
  onKick?: (viewerId: string) => void;
  /** `false` hides the kick affordance regardless of `onKick`. */
  canKick?: boolean;
  compact?: boolean;
}

/** Props for `<ConnectionBanner/>`. Invisible in `live` and the first `afterAttempt - 1` reconnect attempts. */
export interface ConnectionBannerProps extends BaseUiProps {
  state: ConnectionState;
  attempt: number;
  nextDelayMs: number | null;
  /** Populated only in the `fatal` state; the source for the close code, message, and (via `error.error`) remediation text this component renders. */
  error: FatalInfo | null;
  afterAttempt?: number;
  onRetry?: () => void;
}

/** Props for `<QualitySelector/>`. */
export interface QualitySelectorProps extends BaseUiProps {
  quality: QualityProfile;
  /** The level the adaptation controller actually settled on, shown next to the "Auto" label. */
  adaptedTo?: QualityProfile;
  onChange: (quality: QualityProfile) => void;
  showAuto?: boolean;
}

/** Props for `<DebugOverlay/>`. */
export interface DebugOverlayProps extends BaseUiProps {
  fps: number;
  rttMs: number;
  backlog: number;
  droppedFrames: number;
  bytesPerSec: number;
  decodeMsP50: number;
  decodeMsP95: number;
  codec: string | null;
  quality: string | null;
  resumeCount?: number;
  lastCloseCode?: number | null;
  position?: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right';
  expanded?: boolean;
}

/** Props for `<DialogPrompt/>` (built-in default for `dialog.opened`). */
export interface DialogPromptProps extends BaseUiProps {
  dialog: ClientEvents['dialog'];
  onAnswer: (accept: boolean, promptText?: string) => void;
}

/** Props for `<FileChooserPrompt/>` (built-in default for `filechooser.opened`). */
export interface FileChooserPromptProps extends BaseUiProps {
  chooser: ClientEvents['filechooser'];
  onChoose?: (files: FileList) => void;
  onCancel: () => void;
}
