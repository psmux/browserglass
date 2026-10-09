import type { FrameEncoderPlugin } from './frame-encoder.js';
/**
 * Run-time validation of a plugin's default export.
 *
 * A plugin is third party code fetched once by `bgls plugins add` and its
 * manifest is untrusted input, so the host validates the object it
 * actually got rather than casting a type onto it: types are erased and
 * the module came from outside.
 *
 * What this file deliberately does NOT check: whether `id` matches the
 * record in `bgls-plugins.json`, whether `platforms` includes the running
 * `process.platform`, and whether `hostApi` satisfies the host's own
 * contract version. Those three checks need data this package does not
 * have (the record, the running platform, the host's version), so they
 * belong to the loader in `packages/cli/src/plugins/load.ts`, not here.
 * This file answers only "is this shaped like a plugin".
 */
import { type PluginKind, isPluginKind } from './manifest.js';
import type { PermissionAssistPlugin } from './permission-assist.js';

/** A candidate that passed structural validation, narrowed to its own kind. */
export type ValidatedPlugin = FrameEncoderPlugin | PermissionAssistPlugin;

/** {@link validatePluginManifest}'s answer. */
export type PluginValidationResult =
  | { readonly ok: true; readonly manifest: ValidatedPlugin }
  | { readonly ok: false; readonly reason: string };

function fail(reason: string): PluginValidationResult {
  return { ok: false, reason };
}

/**
 * Checks that `candidate`, a plugin module's default export, has the shape
 * {@link FrameEncoderPlugin} or {@link PermissionAssistPlugin} requires.
 *
 * Never throws: a malformed candidate comes back as `{ ok: false }` so the
 * host can report it and continue rather than crash, the same rule the
 * loader applies to every other load failure.
 */
export function validatePluginManifest(candidate: unknown): PluginValidationResult {
  if (typeof candidate !== 'object' || candidate === null) {
    return fail('plugin default export is not an object');
  }
  const c = candidate as Record<string, unknown>;

  if (typeof c['id'] !== 'string' || c['id'] === '') {
    return fail("missing or invalid 'id': expected a non-empty string");
  }
  if (!isPluginKind(c['kind'])) {
    return fail(
      `missing or invalid 'kind': expected 'frame-encoder' or 'permission-assist', got ${JSON.stringify(c['kind'])}`,
    );
  }
  if (typeof c['hostApi'] !== 'string' || c['hostApi'] === '') {
    return fail("missing or invalid 'hostApi': expected a non-empty semver range string");
  }
  if (
    !Array.isArray(c['platforms']) ||
    c['platforms'].length === 0 ||
    !c['platforms'].every((p) => typeof p === 'string')
  ) {
    return fail("missing or invalid 'platforms': expected a non-empty array of platform strings");
  }
  if (typeof c['summary'] !== 'string' || c['summary'] === '') {
    return fail("missing or invalid 'summary': expected a non-empty string");
  }
  if (typeof c['probe'] !== 'function') {
    return fail("missing or invalid 'probe': expected a function");
  }

  const kind: PluginKind = c['kind'];
  if (kind === 'frame-encoder') {
    if (typeof c['encode'] !== 'function') {
      return fail(
        "missing or invalid 'encode': a frame-encoder plugin must export an encode function",
      );
    }
    return { ok: true, manifest: candidate as FrameEncoderPlugin };
  }
  if (typeof c['assist'] !== 'function') {
    return fail(
      "missing or invalid 'assist': a permission-assist plugin must export an assist function",
    );
  }
  return { ok: true, manifest: candidate as PermissionAssistPlugin };
}
