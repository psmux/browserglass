/**
 * The manifest shared by every plugin kind, and the run-time check for
 * {@link PluginKind} itself.
 *
 * A plugin's default export is data
 * from outside this repository (fetched once by `bgls plugins add`, never
 * at run time), so its shape is checked against these types at load, not
 * merely declared by them. `validate.ts` in this package is that check.
 */

/** The two kinds of extension point this build has. A third needs its own design. */
export type PluginKind = 'frame-encoder' | 'permission-assist';

/** Every {@link PluginKind} value, for run-time membership checks. */
export const PLUGIN_KINDS: readonly PluginKind[] = ['frame-encoder', 'permission-assist'];

/** Checks whether `value` is one of the two canonical {@link PluginKind} strings. */
export function isPluginKind(value: unknown): value is PluginKind {
  return typeof value === 'string' && (PLUGIN_KINDS as readonly string[]).includes(value);
}

/** What every plugin's default export must satisfy, whatever its kind. */
export interface PluginManifest {
  /** Must equal the `id` recorded for this plugin in `bgls-plugins.json`, checked at load. */
  readonly id: string;
  readonly kind: PluginKind;
  /** Semver range of the host contract this plugin was built against. */
  readonly hostApi: string;
  /** Platforms this plugin is willing to load on. Filtered against `process.platform` before the entry file is even read. */
  readonly platforms: readonly NodeJS.Platform[];
  /** One line, printed by `bgls plugins list` and `bgls plugins add`. */
  readonly summary: string;
  /** "Would I work right now, on this machine, as configured." Never throws. */
  probe(): Promise<PluginProbe>;
}

/** {@link PluginManifest.probe}'s answer. `detail` is printed, never executed. */
export interface PluginProbe {
  readonly usable: boolean;
  readonly detail: string;
}
