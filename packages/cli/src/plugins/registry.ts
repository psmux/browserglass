/**
 * "Which plugin serves this extension point, on this machine, right now":
 * the two functions every consumer actually calls, {@link encoderFor} and
 * {@link assistFor}, built on `load.ts`'s lifecycle and `record.ts`'s
 * parsed `bgls-plugins.json`.
 *
 * **Absence is the normal case, and it is cheap and quiet.**
 * Nothing is installed by default, so "no plugin for this extension
 * point" is the expected answer. Nothing
 * installed for a kind ({@link PluginAvailability}'s `'absent'`) costs one
 * array filter and returns synchronously wrapped in a resolved promise:
 * no file read beyond the `PluginsFile` the caller already parsed, no hash,
 * no import.
 *
 * **Platform gating happens at listing time, not at invocation time**:
 * a plugin whose `platforms` excludes `process.platform` is
 * reported as `'not-applicable'`, distinct from `'absent'`, because a
 * shared `bgls-plugins.json` committed across a mixed fleet genuinely does
 * have an entry for this kind, it just does not run here. `bgls plugins
 * list` and `bgls doctor` (built by a later stage) depend on being able to
 * tell "nothing recorded" from "recorded, but not for this machine" apart,
 * per the four-state table (`ready` / `unusable` / `not-applicable`
 * / absent).
 *
 * **This module never imports a plugin itself.** Every actual verify/
 * import/validate/probe step is `load.ts`'s; this file only decides WHICH
 * record entry (if any) is worth asking `load.ts` to load, and translates
 * `load.ts`'s richer {@link PluginLoadResult} into the same vocabulary
 * `bgls plugins list` and a calling command both need.
 *
 * **On more than one installed entry of the same kind.** `bgls-plugins.json`'s
 * shape (`record.ts`) allows it, only `id` is required to be unique, not
 * `kind`, but nothing in the two built in uses of plugins ever installs two encoders or two permission
 * assistants at once. The policy here is deliberately the simplest one
 * that is still honest: **the first matching entry in file order is
 * authoritative.** A second entry of the same kind is accepted by the
 * record format (so `bgls plugins add` never has to refuse installing a
 * second one) but is never consulted by {@link encoderFor} or
 * {@link assistFor}. This is a real limitation, stated plainly rather than
 * hidden behind a priority list this design was never asked to specify:
 * an operator who wants to switch encoders removes the first before adding
 * the second.
 */

import type {
  FrameEncoderPlugin,
  PermissionAssistPlugin,
  PluginProbe,
} from '@browserglass/plugin-api';
import { type PluginLoadResult, loadPlugin } from './load.js';
import type { PluginsFile } from './record.js';

/**
 * What asking "give me the plugin for this extension point" can honestly
 * answer. Six states, matching `load.ts`'s `PluginLoadResult` one-for-one
 * plus the one case `load.ts` cannot produce on its own: nothing recorded
 * for this kind at all.
 */
export type PluginAvailability<TPlugin> =
  /** No entry of this kind is recorded in `bgls-plugins.json` at all. The normal, default state. */
  | { readonly status: 'absent' }
  /** An entry of this kind is recorded, but not for `process.platform` (or its own manifest disagrees with the record about that). */
  | { readonly status: 'not-applicable'; readonly reason: string }
  /** The recorded entry's file does not match its recorded hash. Not imported. */
  | { readonly status: 'integrity-mismatch'; readonly reason: string }
  /** `import()` failed, the manifest is malformed, or its `id`/`kind` disagrees with the record. */
  | { readonly status: 'load-failed'; readonly reason: string }
  /** Loaded and validated, but its `hostApi` range does not admit this host's contract version. Not called. */
  | {
      readonly status: 'unsupported-host-api';
      readonly reason: string;
      readonly declared: string;
      readonly hostApiVersion: string;
    }
  /** Loaded, but `probe()` itself threw or did not return in time. */
  | { readonly status: 'probe-failed'; readonly reason: string }
  /** Loaded, and `probe()` honestly reports it cannot run right now (e.g. no system ffmpeg). Not a failure of the registry or the loader, the plugin answering its own question. */
  | { readonly status: 'unusable'; readonly plugin: TPlugin; readonly probe: PluginProbe }
  /** Loaded, validated, and ready to call. */
  | { readonly status: 'ready'; readonly plugin: TPlugin; readonly probe: PluginProbe };

/** Translates `load.ts`'s {@link PluginLoadResult} into a {@link PluginAvailability}, narrowing `plugin` from the loader's `ValidatedPlugin` union to the specific interface this function's caller asked for. The narrowing is safe: `loadPlugin` is called with `expectedKind` and refuses (as `'load-failed'`) any manifest whose own `kind` disagrees, so a `'ready'`/`'unusable'`/`'probe-failed'` result here is guaranteed to carry a plugin of exactly `TPlugin`'s kind. */
function toAvailability<TPlugin>(result: PluginLoadResult): PluginAvailability<TPlugin> {
  switch (result.status) {
    case 'not-applicable':
      return { status: 'not-applicable', reason: result.reason };
    case 'integrity-mismatch':
      return { status: 'integrity-mismatch', reason: result.reason };
    case 'load-failed':
      return { status: 'load-failed', reason: result.reason };
    case 'unsupported-host-api':
      return {
        status: 'unsupported-host-api',
        reason: result.reason,
        declared: result.declared,
        hostApiVersion: result.hostApiVersion,
      };
    case 'probe-failed':
      return { status: 'probe-failed', reason: result.reason };
    case 'unusable':
      return { status: 'unusable', plugin: result.plugin as TPlugin, probe: result.probe };
    case 'ready':
      return { status: 'ready', plugin: result.plugin as TPlugin, probe: result.probe };
  }
}

/**
 * The shared implementation behind {@link encoderFor} and
 * {@link assistFor}: find the first `bgls-plugins.json` entry of `kind`
 * (see this module's doc comment on that policy), and if one exists, ask
 * `load.ts` to run the full lifecycle on it. Nothing recorded at all is
 * `'absent'` and never touches `load.ts`.
 */
async function pluginFor<TPlugin>(
  file: PluginsFile,
  dataDir: string,
  kind: 'frame-encoder' | 'permission-assist',
): Promise<PluginAvailability<TPlugin>> {
  const entry = file.plugins.find((p) => p.kind === kind);
  if (!entry) {
    return { status: 'absent' };
  }
  const result = await loadPlugin(entry, dataDir, kind);
  return toAvailability<TPlugin>(result);
}

/**
 * Resolves the `frame-encoder` plugin for this record and this machine, or
 * a named reason there is not one right now. `bgls record export --video`
 * (a later stage) is the caller: on `'ready'` it calls `.encode()`, on
 * anything else it takes the "not silently succeeding with less"
 * path, reporting the reason and still writing the frame sequence it
 * already promised.
 */
export function encoderFor(
  file: PluginsFile,
  dataDir: string,
): Promise<PluginAvailability<FrameEncoderPlugin>> {
  return pluginFor<FrameEncoderPlugin>(file, dataDir, 'frame-encoder');
}

/**
 * Resolves the `permission-assist` plugin for this record and this
 * machine, or a named reason there is not one right now. `bgls attach`
 * (a later stage) is the caller: on `'ready'` it calls `.assist()` and
 * re-probes `discoverLocalBrowser` before trusting a `'resolved'` outcome;
 * on anything else, today's imperative error stands
 * unchanged.
 */
export function assistFor(
  file: PluginsFile,
  dataDir: string,
): Promise<PluginAvailability<PermissionAssistPlugin>> {
  return pluginFor<PermissionAssistPlugin>(file, dataDir, 'permission-assist');
}
