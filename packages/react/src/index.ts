/**
 * `@browserglass/react`: `<BrowserGlass/>`, eight hooks, and (under the
 * `./ui` subpath) the UI primitives.
 *
 * Every hook accepts `client: BrowserGlassClient | null` and returns
 * sensible empty defaults for `null`, so no guard clause is needed before
 * render. Six of the eight cover the session itself: `useBrowserGlass`,
 * `useTargets`, `useNav`, `useControlLease`, `usePresence`,
 * `useInstanceStats`. `useConsole` and `useNetwork` are the other two,
 * each an opt in per target bounded ring buffer over the `devtools`-gated
 * diagnostics feeds. There is deliberately no hook for listing browser
 * instances; `useTargets` covers the tab list within one session, and
 * listing separate browser instances is REST-based app code.
 */

export { BrowserGlass } from './BrowserGlass.js';
export { useBrowserGlass } from './useBrowserGlass.js';
export type { UseBrowserGlassResult } from './useBrowserGlass.js';
export { useTargets } from './useTargets.js';
export type { UseTargetsResult } from './useTargets.js';
export { useNav } from './useNav.js';
export type { BlockedNav, UseNavResult } from './useNav.js';
export { useControlLease } from './useControlLease.js';
export type { UseControlLeaseResult } from './useControlLease.js';
export { driversOf, usePresence } from './usePresence.js';
export type { Driver, DriverKind, PresenceCursor, UsePresenceResult } from './usePresence.js';
export { useInstanceStats } from './useInstanceStats.js';
export type { UseInstanceStatsOptions, UseInstanceStatsResult } from './useInstanceStats.js';
export { useConsole } from './useConsole.js';
export type { ConsoleLogEntry, UseConsoleOptions, UseConsoleResult } from './useConsole.js';
export { useNetwork } from './useNetwork.js';
export type { NetworkRow, UseNetworkOptions, UseNetworkResult } from './useNetwork.js';

export type {
  BrowserGlassProps,
  DimOnDisconnectLevels,
  OverlayContext,
  UseBrowserGlassOptions,
} from './types.js';
