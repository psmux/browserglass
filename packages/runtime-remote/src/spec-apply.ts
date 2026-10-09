/**
 * Compares a resolved `BrowserSpec` against what a remote browser actually
 * is, applies everything CDP can still change after the fact, and records
 * one `SPEC_IGNORED` incident per field that cannot be honoured:
 *
 * > `launch()` on this runtime does NOT fail because a spec field cannot be
 * > honoured. It: (1) attaches, (2) compares the resolved spec against what
 * > the browser actually is, (3) records ONE `SPEC_IGNORED` incident per
 * > field that could not be honoured, (4) applies every field that CAN be
 * > applied after the fact via CDP.
 *
 * `BrowserSpec` is the "fully merged" spec (every field always concretely
 * populated, `domain/entities.ts` line 316's comment), so "cannot be
 * honoured" is computed as "differs from `DEFAULT_BROWSER_SPEC`, and this
 * runtime has no way to make the remote browser match it": a spec that
 * never asked for anything beyond the package default produces zero
 * incidents, which is the useful behaviour (a pool that happens to route to
 * a remote endpoint should not warn on every single launch for fields
 * nobody actually set).
 */

import { DEFAULT_BROWSER_SPEC } from '@browserglass/protocol';
import type { BrowserSpec } from '@browserglass/protocol';
import type { CdpCommandSender } from './cdp-client.js';
import { wallNow } from './platform.js';

/**
 * One record of a `BrowserSpec` field this runtime could not honour on a
 * remote endpoint. `Instance.incidents` (owned by `protocol`'s
 * `domain/entities.ts`) is the durable home for this once a router-side
 * caller appends it there; this package has no store access, so it
 * surfaces incidents in memory via `RemoteRuntime`'s `listIncidents()` and
 * an optional constructor-supplied sink.
 */
export interface SpecIgnoredIncident {
  at: number;
  code: 'SPEC_IGNORED';
  field: keyof BrowserSpec;
  detail: string;
}

/** The result of one `applyResolvedSpec` call. */
export interface ApplySpecResult {
  incidents: readonly SpecIgnoredIncident[];
  appliedFields: readonly (keyof BrowserSpec)[];
}

/**
 * `BrowserSpec` fields fixed at launch time everywhere else, which
 * `runtime-remote` has no way to change on an already-running browser it
 * did not start. Checked against {@link DEFAULT_BROWSER_SPEC}; `engine` is
 * excluded (always `'chromium'`, not a meaningful signal) and
 * `launchTimeoutMs` is excluded (governed by `capabilities().maxLaunchTimeoutMs`
 * as a clamp, not a browser-level CDP-applicable setting).
 */
const UNHONOURABLE_FIELDS: readonly (keyof BrowserSpec)[] = [
  'channel',
  'executablePath',
  'headless',
  'window',
  'proxy',
  'extraArgs',
  'ignoreDefaultArgs',
  'env',
  'extensions',
  'stealth',
  'ignoreHttpsErrors',
  'downloadDir',
  'uploadDir',
  'acceptDownloads',
  'maxDownloadBytes',
  'resources',
  'initialUrl',
];

/** Structural equality sufficient for `BrowserSpec`'s field shapes: primitives, arrays of primitives, and one level of plain objects. */
function specFieldEquals(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => specFieldEquals(v, b[i]));
  }
  if (a !== null && b !== null && typeof a === 'object' && typeof b === 'object') {
    const aRec = a as Record<string, unknown>;
    const bRec = b as Record<string, unknown>;
    const keys = new Set([...Object.keys(aRec), ...Object.keys(bRec)]);
    for (const key of keys) {
      if (!specFieldEquals(aRec[key], bRec[key])) {
        return false;
      }
    }
    return true;
  }
  return false;
}

function describeValue(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Maps a `ClientHintsSpec` to CDP's `Emulation.setUserAgentOverride` `userAgentMetadata` shape. */
function toUserAgentMetadata(
  hints: BrowserSpec['clientHints'],
): Record<string, unknown> | undefined {
  if (!hints) {
    return undefined;
  }
  return {
    brands: hints.brands.map((b) => ({ brand: b.brand, version: b.version })),
    platform: hints.platform ?? '',
    platformVersion: hints.platformVersion ?? '',
    architecture: hints.architecture ?? '',
    model: hints.model ?? '',
    mobile: hints.mobile ?? false,
    fullVersion: hints.fullVersion ?? '',
  };
}

/**
 * Applies every honourable field of `spec` to the attached browser via CDP,
 * and returns one `SpecIgnoredIncident` for every unhonourable field whose
 * resolved value differs from the package default. `hasPageSession` is
 * `false` when the remote browser has no page target to attach to, in
 * which case even the honourable, page-scoped fields (everything except
 * `permissions`, which `Browser.grantPermissions` applies browser wide)
 * cannot be applied and are folded into the incident list too.
 */
export async function applyResolvedSpec(
  client: CdpCommandSender,
  spec: BrowserSpec,
  hasPageSession: boolean,
): Promise<ApplySpecResult> {
  const incidents: SpecIgnoredIncident[] = [];
  const appliedFields: (keyof BrowserSpec)[] = [];
  const now = wallNow();

  const recordIgnored = (field: keyof BrowserSpec, detail: string): void => {
    incidents.push({ at: now, code: 'SPEC_IGNORED', field, detail });
  };

  for (const field of UNHONOURABLE_FIELDS) {
    if (!specFieldEquals(spec[field], DEFAULT_BROWSER_SPEC[field])) {
      recordIgnored(
        field,
        `runtime-remote cannot set ${field} on an already-running browser it did not launch, requested ${describeValue(spec[field])}`,
      );
    }
  }

  const applyOrIgnore = async (
    field: keyof BrowserSpec,
    requiresPageSession: boolean,
    apply: () => Promise<void>,
  ): Promise<void> => {
    if (requiresPageSession && !hasPageSession) {
      recordIgnored(
        field,
        `${field} needs a page target to apply to, and the remote browser reported none`,
      );
      return;
    }
    try {
      await apply();
      appliedFields.push(field);
    } catch (err) {
      recordIgnored(
        field,
        `applying ${field} via CDP failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  // A REMOTE browser is somebody's real Chrome on a real screen; forcing a
  // device-metrics override makes `screen.*` report the emulated size (a fingerprint tell). Opt out
  // with BGLS_REMOTE_NO_EMULATION=1 (the viewer then streams the browser's true window size).
  if (
    (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[
      'BGLS_REMOTE_NO_EMULATION'
    ] !== '1'
  ) {
    await applyOrIgnore('viewport', true, () =>
      client
        .sendPage('Emulation.setDeviceMetricsOverride', {
          width: spec.viewport.width,
          height: spec.viewport.height,
          deviceScaleFactor: spec.viewport.deviceScaleFactor,
          mobile: false,
        })
        .then(() => undefined),
    );
  }

  if (spec.userAgent !== null) {
    await applyOrIgnore('userAgent', true, () =>
      client
        .sendPage('Emulation.setUserAgentOverride', {
          userAgent: spec.userAgent,
          userAgentMetadata: toUserAgentMetadata(spec.clientHints),
        })
        .then(() => undefined),
    );
  }

  if (spec.timezoneId !== null) {
    await applyOrIgnore('timezoneId', true, () =>
      client
        .sendPage('Emulation.setTimezoneOverride', { timezoneId: spec.timezoneId })
        .then(() => undefined),
    );
  }

  if (spec.locale !== null) {
    await applyOrIgnore('locale', true, () =>
      client.sendPage('Emulation.setLocaleOverride', { locale: spec.locale }).then(() => undefined),
    );
  }

  if (spec.permissions.length > 0) {
    await applyOrIgnore('permissions', false, () =>
      client
        .sendBrowser('Browser.grantPermissions', { permissions: spec.permissions })
        .then(() => undefined),
    );
  }

  if (spec.geolocation !== null) {
    await applyOrIgnore('geolocation', true, () =>
      client
        .sendPage('Emulation.setGeolocationOverride', { ...spec.geolocation })
        .then(() => undefined),
    );
  }

  const colorSchemeChanged = spec.colorScheme !== DEFAULT_BROWSER_SPEC.colorScheme;
  const reducedMotionChanged = spec.reducedMotion !== DEFAULT_BROWSER_SPEC.reducedMotion;
  if (colorSchemeChanged || reducedMotionChanged) {
    if (!hasPageSession) {
      if (colorSchemeChanged)
        recordIgnored(
          'colorScheme',
          'colorScheme needs a page target to apply to, and the remote browser reported none',
        );
      if (reducedMotionChanged)
        recordIgnored(
          'reducedMotion',
          'reducedMotion needs a page target to apply to, and the remote browser reported none',
        );
    } else {
      try {
        await client.sendPage('Emulation.setEmulatedMedia', {
          features: [
            { name: 'prefers-color-scheme', value: spec.colorScheme },
            { name: 'prefers-reduced-motion', value: spec.reducedMotion },
          ],
        });
        if (colorSchemeChanged) appliedFields.push('colorScheme');
        if (reducedMotionChanged) appliedFields.push('reducedMotion');
      } catch (err) {
        const detail = `applying colorScheme/reducedMotion via CDP failed: ${err instanceof Error ? err.message : String(err)}`;
        if (colorSchemeChanged) recordIgnored('colorScheme', detail);
        if (reducedMotionChanged) recordIgnored('reducedMotion', detail);
      }
    }
  }

  return { incidents, appliedFields };
}
