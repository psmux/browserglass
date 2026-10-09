/**
 * The `permission-assist` extension point: runs precisely when CDP is
 * unavailable, so it is handed a description of that failure and nothing
 * that would make the failure moot (handing this plugin a CDP connection
 * would be handing it the thing whose absence is the entire problem).
 *
 * The plugin does its own work; the host never becomes an execution engine
 * for a plugin supplied string. There is deliberately no shape here in
 * which a plugin returns a script, a shell command, or a path for the host
 * to run: {@link AssistOutcome} is three words and {@link AssistResult}'s
 * `detail` is printed to the human verbatim, never executed.
 */
import type { PluginManifest } from './manifest.js';

/** What the host observed. Every field came from `probeLocalBrowserCandidate` (`packages/runtime-host/src/local-browser-discovery.ts`). */
export interface AssistSituation {
  /** A subset of `LocalBrowserCandidateStatus`: only these two are actionable. */
  readonly status: 'permission-blocked' | 'remote-debugging-disabled';
  readonly userDataDir: string;
  /** Vendor/channel label: 'chrome', 'chrome-canary', 'msedge', 'brave'. */
  readonly label: string;
  /** The `http://127.0.0.1:<port>` origin, non-null only for `'permission-blocked'`. */
  readonly cdpUrl: string | null;
  /** The probe's own `detail`, so the plugin need not re-derive what the host already knows. */
  readonly detail: string;
}

/** Three words. Nothing here can name a command, a script, a path to run, or a URL to open. */
export type AssistOutcome =
  /** The plugin believes it fixed it. The host does NOT believe this; it re-probes before retrying. */
  | 'resolved'
  /** The plugin could not, and a person must act. `detail` says what to ask for. */
  | 'user-action-required'
  /** The plugin cannot run here at all: no Accessibility grant, wrong Chrome root, no toggle. */
  | 'unavailable';

export interface AssistResult {
  readonly outcome: AssistOutcome;
  /** Printed to the human verbatim. Never executed, never parsed, never a path. */
  readonly detail: string;
}

/** A plugin that attempts to clear a local browser permission blocker on this machine. */
export interface PermissionAssistPlugin extends PluginManifest {
  readonly kind: 'permission-assist';
  assist(s: AssistSituation, signal: AbortSignal): Promise<AssistResult>;
}
