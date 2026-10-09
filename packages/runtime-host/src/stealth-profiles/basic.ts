/**
 * `BASIC_STEALTH_PROFILE`: a reference `StealthProfile` implementation at
 * level `'basic'`, shipped as a starting point, not a finished product.
 *
 * SCOPE, STATED PLAINLY: this profile addresses exactly one well known,
 * uncontroversial automation tell, `navigator.webdriver`, through the one
 * JS level patch and the one CDP level primitive Chrome provides for it.
 * It does not attempt to defeat any specific vendor's bot detection
 * service, does not touch canvas/WebGL/audio fingerprinting, does not
 * rotate or spoof TLS/HTTP2 fingerprints, and has not been validated
 * against any real Chrome build as part of this change (see
 * `validatedChromeMajors` below). A deployment that needs more than this
 * is expected to register its own `StealthProfile` in
 * `HostRuntimeConfig.stealthProfiles`, using this one as a template for
 * the shape, not as the destination.
 *
 * DO NOT RUN THIS PROFILE AGAINST A SITE THAT LOOKS FOR AUTOMATION, AND
 * READ THIS PARAGRAPH BEFORE YOU DECIDE OTHERWISE. Its init script is a
 * JavaScript override of `navigator.webdriver`, layered on top of a
 * browser that has ALREADY had the property removed natively by
 * `--disable-blink-features=AutomationControlled` (`flags.ts`'s
 * `UNCONDITIONAL_BASE_FLAGS`, applied to every launch at every stealth
 * level). Those two are not additive. The flag makes Blink stop defining
 * the `Navigator.webdriver` IDL attribute at all, so what a page finds is
 * `'webdriver' in Navigator.prototype === false` and no property
 * descriptor. The init script below puts a descriptor back, with a getter
 * whose `toString()` reads `() => undefined`. A page that walks the
 * prototype instead of reading the value therefore sees MORE evidence of
 * automation after this profile runs than before it.
 *
 * That is not a theoretical objection, it is a measurement. Layering
 * exactly this getter on top of the protocol level fix was observed to
 * make a production site's invisible hCaptcha start challenging again on a
 * browser that had been getting through unchallenged, and the same thing
 * was seen from the launch side. Neither Playwright nor patchright patches
 * `navigator.webdriver` in JavaScript at all: a grep for it over both
 * driver bundles returns zero hits, and the launch flag is the whole
 * mechanism in both.
 *
 * The file is kept because it is the reference implementation of the
 * `StealthProfile` SHAPE, which is what a deployment writing its own
 * profile needs to copy. Copy the shape. Do not copy `initScripts`.
 * `spec.stealth: 'off'`, the default, resolves no profile at all
 * (`stealth.ts`'s `resolveRequiredStealthProfile`), installs no init
 * script, and still gets the flag, which is everything patchright
 * achieves on this axis.
 *
 * Two of the three automation tells this profile was asked to justify
 * from the launch-flag side, `--enable-automation` and the
 * `AutomationControlled` Blink feature, need nothing added here:
 * `runtime-host` never adds `--enable-automation` to any launch (it never
 * shells out through a driver that would), and
 * `--disable-blink-features=AutomationControlled` is already one of
 * `flags.ts`'s `UNCONDITIONAL_BASE_FLAGS`, applied to every launch
 * regardless of `spec.stealth`. `launchArgs` below is `[]` for exactly
 * that reason: there is nothing left at the launch-flag layer for a
 * `'basic'` profile to add without duplicating a flag Chrome already gets.
 */

import type {
  StealthCheckResult,
  StealthProfile,
  StealthTargetContext,
} from '@browserglass/protocol';

/**
 * Redefines `navigator.webdriver`'s getter on the `Navigator` prototype to
 * return `undefined`, the value real, non automated Chrome reports.
 * Installed as an init script (`Page.addScriptToEvaluateOnNewDocument`) so
 * it runs before any page script on every document, including one loaded
 * as the very first thing on a freshly attached target
 * (`target-registry.ts`'s `installInitScripts`).
 */
const NAVIGATOR_WEBDRIVER_PATCH = `(() => {
  try {
    Object.defineProperty(Navigator.prototype, 'webdriver', {
      get: () => undefined,
      configurable: true,
      enumerable: true,
    });
  } catch {
    // Some Chrome builds already define this as non configurable, or the
    // prototype shape differs. Leaving it unpatched is a worse outcome
    // than this profile's launch failing, so this stays a no-op, not a
    // throw: a page that never checks navigator.webdriver never notices
    // either way, and the CDP level override in onTargetAttached below is
    // this profile's second, independent attempt at the same result.
  }
})();`;

export const BASIC_STEALTH_PROFILE: StealthProfile = {
  name: 'browserglass-basic-reference',
  level: 'basic',
  // Semver for this file's own content, not for Chrome or for the
  // techniques it uses. Bump this whenever NAVIGATOR_WEBDRIVER_PATCH or
  // the onTargetAttached/selfTest logic below changes, so
  // `LaunchedBrowser.stealthProfile.version` can tie a detection
  // regression to the exact revision that ran.
  version: '0.1.0',
  // Deliberately empty: this reference profile has not been run against a
  // real Chrome build as part of building this injection slot. A
  // deployment that validates it against its own Chrome channel/version
  // should record the majors it confirmed here, not before.
  validatedChromeMajors: [],

  launchArgs(_spec) {
    // See this module's doc comment: both flag level tells this profile
    // is scoped to cover are already unconditional in `flags.ts`,
    // regardless of stealth level, so there is nothing to add here.
    return [];
  },

  initScripts(_spec) {
    // Read this module's doc comment before enabling this profile. This
    // array is the measured regression: adding this getter on top of
    // `--disable-blink-features=AutomationControlled` made a production
    // site's invisible hCaptcha start challenging a browser it had been
    // letting through.
    //
    // These scripts are no longer inert. Until the fourth argument of
    // `createTargetRegistry` was wired up
    // (`packages/server/src/session/factory.ts`'s `resolveStealthHooks`),
    // a `StealthProfile`'s `initScripts` were resolved by this runtime and
    // then installed on nothing, so registering this profile changed
    // nothing a page could see. It does now.
    return [
      { name: 'browserglass-basic-stealth:navigator-webdriver', source: NAVIGATOR_WEBDRIVER_PATCH },
    ];
  },

  async onTargetAttached(ctx: StealthTargetContext): Promise<void> {
    // `Emulation.setAutomationOverride(enabled: false)`: the CDP primitive
    // Chrome exposes specifically to unset the automation flag it uses
    // internally (the same flag that, among other things, makes
    // `navigator.webdriver` report `true`). Belt and suspenders alongside
    // the JS patch in initScripts: a CDP level override cannot be
    // shadowed by a page script that walks the prototype chain looking
    // for exactly this kind of patch, the way the JS patch in principle
    // could be. Best effort: an older Chrome major without this command
    // must not fail the whole target attach, matching
    // `target-registry.ts`'s own best-effort precedent for per-target CDP
    // calls that are not load-bearing for the rest of attach.
    try {
      await ctx.send('Emulation.setAutomationOverride', { enabled: false });
    } catch {
      // Unsupported on this Chrome build, or the target does not carry an
      // Emulation domain (a worker, for instance). The JS level patch
      // above still stands on its own for `navigator.webdriver`.
    }
  },

  async selfTest(ctx: StealthTargetContext): Promise<readonly StealthCheckResult[]> {
    // Assumes `ctx` already points at a suitable blank page (about:blank
    // per this interface's own doc comment); this profile does not
    // navigate there itself, since `StealthTargetContext` exposes no
    // navigation primitive, only `evaluate`/`send` on whatever target the
    // caller already resolved.
    const results: StealthCheckResult[] = [];

    let webdriverObserved: string;
    try {
      const value = await ctx.evaluate('navigator.webdriver');
      webdriverObserved = value === undefined ? 'undefined' : JSON.stringify(value);
    } catch (err) {
      webdriverObserved = `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`;
    }
    results.push({
      check: 'navigator.webdriver',
      observed: webdriverObserved,
      expected: 'undefined',
      ok: webdriverObserved === 'undefined',
    });

    // No second check today. This profile does not claim to patch
    // anything else, so it does not fabricate a check for it; see this
    // module's doc comment for the full list of what is out of scope.
    return results;
  },
};
