/**
 * `@browserglass/plugin-permission-assist`: the reference `permission-
 * assist` plugin.
 *
 * This needs no `CdpBridge`, no `Session`, and no target id, for the same
 * reason the extension point itself is shaped that way: it runs precisely when
 * CDP is unavailable, which is the definition of the situation
 * (`local-browser-discovery.ts`'s `'permission-blocked'` and
 * `'remote-debugging-disabled'` statuses). Handing it a live connection
 * would be handing it the thing whose absence is the entire problem.
 *
 * Only one half of browser-harness's choreography lives here, and that
 * split is deliberate, not accidental. Opening
 * `chrome://inspect/#remote-debugging`, rate limited by a marker file's
 * mtime, is cross platform and belongs in `packages/cli/src/commands/
 * attach.ts`, next to the discovery call, because
 * it is useful with or without this plugin installed, so it is not gated
 * behind installing anything. What belongs here is the part that is
 * genuinely platform specific and genuinely fragile: pressing a button in
 * another application's window via macOS accessibility traversal
 * (`./macos.ts`). `platforms: ['darwin']` below is not decoration; it is
 * checked by `packages/cli/src/plugins/load.ts` before this file is even
 * imported on any other platform, and `probe()` refuses honestly off macOS too, so this plugin
 * cannot claim a capability it does not have on the platform it is asked
 * to run on.
 *
 * `assist()`'s `'resolved'` is this plugin's own claim, and the design is
 * explicit that the host must not trust it: `packages/cli/src/commands/attach.ts` re-probes
 * `discoverLocalBrowser()` before retrying an attach, exactly the way
 * `local-browser-discovery.ts` never trusts a `DevToolsActivePort` file on
 * its own. Nothing in this file, or anywhere in this package, tries to
 * make that claim more convincing than it is: a claim from third party
 * code, checked by a live round trip, same as every other claim this
 * repository's security posture is built around.
 */
import type {
  AssistOutcome,
  AssistResult,
  AssistSituation,
  PermissionAssistPlugin,
  PluginProbe,
} from '@browserglass/plugin-api';
import { type MacApproveStatus, approveRemoteDebugging } from './macos.js';

/**
 * The host contract range this plugin was built against, pinned to the
 * `@browserglass/plugin-api` version it was actually built against, the
 * same convention `plugin-video-export`'s own `HOST_API_RANGE` follows.
 */
const HOST_API_RANGE = '^0.1.0-alpha.0';

async function probe(): Promise<PluginProbe> {
  if (process.platform !== 'darwin') {
    return {
      usable: false,
      detail: `${process.platform} is not supported; this plugin only automates macOS Chrome's "Allow remote debugging?" sheet via AppleScript accessibility traversal`,
    };
  }
  return {
    usable: true,
    detail:
      'darwin: will click Chrome\'s "Allow remote debugging?" sheet via AppleScript accessibility traversal when assist() is called; requires the chrome://inspect toggle already ticked and Accessibility granted to the process running bgls, both checked at assist time, not here',
  };
}

/**
 * Maps `./macos.ts`'s six-outcome vocabulary, ported unchanged from
 * browser-harness's `approve_remote_debugging()`, onto
 * {@link AssistResult}'s three-word {@link AssistOutcome}
 * as follows: `'ready'` becomes
 * `'resolved'`; `'setup-required'` and `'not-found'` become
 * `'user-action-required'`, carrying the same warning browser-harness's
 * own `admin.py` gives that Chrome shows one more "Allow" popup on the
 * next connection attempt, and that this is expected per-connection
 * approval, not a re-ask; `'accessibility-required'`, `'unsupported'` and
 * `'error'` all become `'unavailable'`.
 */
function toAssistResult(status: MacApproveStatus, detail: string | null): AssistResult {
  switch (status) {
    case 'ready':
      return { outcome: 'resolved', detail: 'clicked Chrome\'s "Allow remote debugging?" sheet' };
    case 'setup-required':
    case 'not-found':
      return {
        outcome: 'user-action-required',
        detail: `${detail ?? 'user action required'}. Chrome will show one more "Allow" popup on the next connection attempt; that is expected per-connection approval, not a re-ask.`,
      };
    case 'accessibility-required':
    case 'unsupported':
    case 'error':
      return { outcome: 'unavailable', detail: detail ?? `assist unavailable (${status})` };
  }
}

async function assist(situation: AssistSituation, signal: AbortSignal): Promise<AssistResult> {
  // `AssistSituation.status` is already narrowed to the two actionable
  // values by `@browserglass/plugin-api`'s own type, so this is a defence
  // against a host that disagrees with its own contract, not a case this
  // plugin expects to hit.
  if (
    situation.status !== 'permission-blocked' &&
    situation.status !== 'remote-debugging-disabled'
  ) {
    const unexpected = situation as { readonly status: string };
    return {
      outcome: 'unavailable',
      detail: `unexpected situation status ${JSON.stringify(unexpected.status)}`,
    };
  }
  try {
    const result = await approveRemoteDebugging(signal);
    return toAssistResult(result.status, result.detail);
  } catch (err) {
    // A throw at call time is caught here too, as a second line
    // of defence behind `attach.ts`'s own deadline and catch, so this
    // plugin never depends on its caller to keep a throw from propagating.
    return {
      outcome: 'unavailable',
      detail: `permission-assist threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const plugin: PermissionAssistPlugin = {
  id: '@browserglass/plugin-permission-assist',
  kind: 'permission-assist',
  hostApi: HOST_API_RANGE,
  // Truthful, not aspirational: this plugin's only real capability is
  // macOS-only AppleScript accessibility traversal, so this is the one
  // platform it declares, not the three `plugin-video-export` declares for
  // its genuinely cross platform ffmpeg search.
  platforms: ['darwin'],
  summary:
    'Clicks Chrome\'s own "Allow remote debugging?" sheet via AppleScript accessibility traversal, on macOS only, without foregrounding Chrome.',
  probe,
  assist,
};

export default plugin;
