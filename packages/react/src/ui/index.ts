/**
 * `@browserglass/react/ui`: the thirteen headless-plus-one-default UI
 * primitives (the original twelve plus `<CursorLayer/>`, which shared
 * control added: with several people driving one tab at once, per viewer cursors
 * are what tells one person's input apart from another's). Import the
 * stylesheet separately and explicitly:
 *
 * ```ts
 * import '@browserglass/react/ui/styles.css';
 * ```
 *
 * it is never injected at runtime.
 */

export { AddressBar } from './AddressBar.js';
export { ConnectionBanner } from './ConnectionBanner.js';
export { ContextMenu } from './ContextMenu.js';
export { ControlBadge } from './ControlBadge.js';
export { CursorLayer } from './CursorLayer.js';
export { DebugOverlay } from './DebugOverlay.js';
export { DialogPrompt } from './DialogPrompt.js';
export { FileChooserPrompt } from './FileChooserPrompt.js';
export { QualitySelector } from './QualitySelector.js';
export { RequestControlButton } from './RequestControlButton.js';
export { StatusBar } from './StatusBar.js';
export { TabStrip } from './TabStrip.js';
export { ViewerList } from './ViewerList.js';

export type {
  AddressBarBlocked,
  AddressBarProps,
  BaseUiProps,
  ConnectionBannerProps,
  ContextMenuItem,
  ContextMenuProps,
  ControlBadgeProps,
  CursorLayerProps,
  DebugOverlayProps,
  DialogPromptProps,
  FileChooserPromptProps,
  QualitySelectorProps,
  RequestControlButtonProps,
  StatusBarProps,
  TabStripProps,
  ViewerListProps,
} from './types.js';
