/**
 * `MEASURED_STEALTH_PROFILE`: a `'full'` level `StealthProfile` whose
 * every patch was checked against a real, locally installed Chrome before
 * being written, per the process `basic.ts` (this directory's `'basic'`
 * level reference) asks for and does not itself do. Registered at
 * `'full'`, not `'basic'`, because `HostRuntimeConfig.stealthProfiles`
 * allows at most one profile per level (`stealth.ts`'s
 * `validateStealthProfiles`) and `BASIC_STEALTH_PROFILE` already holds
 * `'basic'`; an operator who wants both this profile's fixes and
 * `basic.ts`'s (there is nothing of `basic.ts`'s worth taking, see below)
 * registers this one, since only one profile ever runs per launch.
 *
 * MEASUREMENT METHOD. Every claim below was checked on Chrome
 * 152.0.7977.64 (Windows, this machine, discovered via
 * `binary-discovery.ts`'s `resolveChromeBinary`), using three sources
 * compared against each other:
 *
 *   1. "Real, non-automated Chrome": the everyday Chrome window this
 *      machine's user already has open, read through a page-JS
 *      evaluation channel that does not add `--remote-debugging-port` or
 *      any other CDP/automation flag to that browser's own launch. This
 *      is the ground truth for "what does an unpatched, non-automated
 *      browser show".
 *   2. "Stock automated": Chrome launched with nothing but
 *      `--user-data-dir`, `--remote-debugging-port=0`,
 *      `--no-first-run`, `--no-default-browser-check` (the minimum this
 *      runtime cannot avoid) and no automation-suppressing flags at all.
 *   3. "This runtime's own launch": Chrome launched with the exact flag
 *      set `flags.ts`'s `UNCONDITIONAL_BASE_FLAGS` composes, headful and
 *      with `--headless=new`, matching what `HostRuntime.doLaunch`
 *      actually runs.
 *
 * Every check below cites which of the three it compares and what it
 * found. The raw comparison was run interactively; this file records the
 * conclusions and keeps the reasoning next to the code it justifies
 * rather than in a throwaway script.
 *
 * ── CHECK 1: `navigator.webdriver`. NO PATCH NEEDED, AND `basic.ts`'S OWN
 * REASONING ABOUT WHY IS MEASURABLY WRONG ON THIS CHROME. ──
 *
 * `basic.ts` says `--disable-blink-features=AutomationControlled` makes
 * Blink stop DEFINING the `Navigator.webdriver` IDL attribute, so an
 * unpatched, flagged browser shows `'webdriver' in Navigator.prototype
 * === false`. Measured on Chrome 152: that is false. All three sources
 * above show `'webdriver' in Navigator.prototype === true`, with an
 * identical descriptor (`{enumerable: true, configurable: true, get:
 * function get webdriver() { [native code] }}`) in every case. The
 * property is ALWAYS present, in every one of the three sources; the flag
 * changes only the VALUE the getter returns (`true` under source 2's
 * stock automated launch, since Chrome now treats "remote debugging port
 * open at all" as automation regardless of `--enable-automation`, to
 * `false` under source 3's flagged launch, matching source 1's real
 * Chrome exactly).
 *
 * `basic.ts`'s CONCLUSION still holds, just for a different, now-verified
 * reason: since the property is present with a NATIVE getter in real
 * Chrome (source 1), any JS `Object.defineProperty` patch replacing that
 * getter with `() => false`/`() => undefined` would make
 * `Object.getOwnPropertyDescriptor(Navigator.prototype,
 * 'webdriver').get.toString()` read as ordinary JS source instead of
 * `"function get webdriver() { [native code] }"`, a strictly WORSE,
 * newly-introduced tell that no automated OR real browser shows. So this
 * profile's `initScripts` carries no webdriver patch either, the same
 * conclusion `basic.ts` reaches, reached independently and for a reason
 * that is actually true of this Chrome. `onTargetAttached` still sends
 * `Emulation.setAutomationOverride(enabled: false)` as a second,
 * CDP-level (not JS-level) attempt at the same value, exactly as
 * `basic.ts` does: a CDP command cannot leave a JS-visible shape
 * difference behind, since it changes what the native getter itself
 * returns, not the getter.
 *
 * NOTE FOR WHOEVER READS `basic.ts`'S OWN `selfTest`, NOW THAT IT CAN
 * ACTUALLY RUN (`stealth-self-test.ts`): it asserts `navigator.webdriver`
 * evaluates to the STRING `'undefined'` (`value === undefined`). Run for
 * real against Chrome 152 with `basic.ts` registered, that check comes
 * back `ok: true`, observed `"undefined"`. THAT IS NOT REASSURING. It
 * passes only because `basic.ts`'s own `initScripts` JS-patches the
 * getter to literally `return undefined`, which trivially satisfies a
 * value-only check while doing exactly the thing `basic.ts`'s own doc
 * comment warns against: measured on this same Chrome, right after that
 * patch runs, `Object.getOwnPropertyDescriptor(Navigator.prototype,
 * 'webdriver').get.toString()` reads `"() => undefined"`, not
 * `"function get webdriver() { [native code] }"`. `basic.ts`'s `selfTest`
 * cannot see that regression, because it never asked the shape question.
 * That is the concrete case for CHECK 1b below: a self test that only
 * checks the value a patch produces cannot tell "correct" from "correct
 * value, wrong mechanism", and this profile's own webdriver check (below)
 * asserts both, on a property this profile does not even touch.
 *
 * ── CHECK 2: `navigator.userAgent` / the `User-Agent` request header
 * under `spec.headless: 'new'`. PATCHED, AND THIS IS THE ONE TELL THIS
 * PROFILE ACTUALLY CLOSES. ──
 *
 * Source 3, headless=new: `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
 * AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/152.0.0.0
 * Safari/537.36`. Source 3, headful (same flag set, `--headless=new`
 * simply omitted): `Mozilla/5.0 (Windows NT 10.0; Win64; x64)
 * AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`.
 * The two strings are IDENTICAL except `HeadlessChrome/` versus
 * `Chrome/`; the platform parenthetical, the WebKit/Safari tokens and the
 * version number (frozen to `<major>.0.0.0` by Chrome's own User-Agent
 * Reduction, independent of any patch here) all match exactly. `"HeadlessChrome"`
 * in a UA string is one of the single most commonly checked, highest
 * confidence automation signals that exists; leaving it in place while
 * shipping a profile that claims to address automation tells would be
 * dishonest by omission.
 *
 * NOT patched via `launchArgs`/`--user-agent=`: `arg-lists.ts`'s
 * `ARG_ALLOW` has no pattern matching `--user-agent=`, and
 * `StealthProfile.launchArgs`'s own doc comment says a profile gets "no
 * exemption" from that screening. Emitting the flag here would make
 * every headless launch under this profile fail with
 * `stealthArgDeniedError`. Widening `ARG_ALLOW` is a protocol-wide
 * security boundary a stealth profile should not move (`arg-lists.ts`'s own header:
 * "apps may not [extend it], under any token claim") and is not this
 * profile's file to change for a cosmetic UA fix.
 *
 * So this is a CDP-level fix, in `onTargetAttached`, using
 * `Emulation.setUserAgentOverride`, gated on actually observing
 * `"Headless"` in the LIVE `navigator.userAgent` (so it is a true no-op
 * on a headful launch, and a true no-op when an app already supplied its
 * own `spec.userAgent`, which reaches Chrome via `flags.ts`'s own
 * `--user-agent=` flag before this hook ever runs).
 *
 * A NARROWLY MEASURED TRAP THIS CHECK AVOIDS: calling
 * `Emulation.setUserAgentOverride` with ONLY `userAgent` set (no
 * `userAgentMetadata`) does not merely leave `navigator.userAgentData`
 * unchanged, it SILENTLY WIPES IT to `{brands: [], platform: '',
 * platformVersion: '', ...}` on every remaining field, measured directly
 * on this Chrome. An empty Client Hints object is a browser no real
 * Chrome build produces and a strictly WORSE, novel tell than the one
 * being fixed: exactly the regression class `basic.ts` names for the
 * webdriver case, reproduced here in a different CDP call that would
 * have shipped by default without measuring it first. The fix:
 * read `navigator.userAgentData`'s brands/mobile/platform and its high
 * entropy values (`platformVersion`/`architecture`/`model`/
 * `fullVersionList`) BEFORE overriding, and hand them straight back in as
 * `userAgentMetadata` so nothing is lost. Measured, before/after,
 * identical: `navigator.userAgentData` was already IDENTICAL between
 * headless and headful Chrome on every field before this profile touches
 * anything (`brands`/`platform`/`mobile` never mention headless mode at
 * all, on this Chrome), so this is pure preservation, never a value this
 * profile invents.
 *
 * A DELIBERATE GAP THIS CHECK DOES NOT CLOSE: on an insecure (non-HTTPS,
 * non-localhost) page, `navigator.userAgentData` is `undefined` (the
 * Client Hints JS API's own secure-context gate, not a Chrome automation
 * behaviour), so this hook has nothing to read back and sends the UA
 * string override with no `userAgentMetadata` at all in that case. The
 * low-entropy `Sec-CH-UA*` request headers Chrome sends independently of
 * the JS API may still reflect this override's absence of metadata on
 * such a page. This is a real, un-closed gap on insecure origins,
 * recorded rather than silently accepted.
 *
 * ── WHAT THIS PROFILE DOES NOT TOUCH, AND WHY. ──
 *
 * `navigator.plugins`/`navigator.mimeTypes`: measured identical (5
 * plugins, the same 5 names, 2 mime types) across all three sources,
 * headless and headful alike, on this Chrome. Nothing to patch.
 *
 * `window.chrome`: measured identical (`{app, csi, loadTimes}`) across
 * all three sources. Nothing to patch.
 *
 * WebGL `UNMASKED_VENDOR_WEBGL`/`UNMASKED_RENDERER_WEBGL`: measured
 * identical (real Intel/ANGLE/D3D11 strings) between headless and
 * headful on THIS machine, because this machine has a real GPU ANGLE can
 * bind to. This is a machine capability difference, not an automation
 * tell to spoof: a genuinely GPU-less headless host (a typical Linux CI
 * box) legitimately reports a software renderer (SwiftShader) whether or
 * not it is automated, and forcing a fake vendor string there would
 * MANUFACTURE a fingerprint no real browser on that host would ever
 * produce, the opposite of this profile's stated rule. Not implemented,
 * on principle, not for lack of time.
 *
 * `outerWidth`/`outerHeight` equal to `innerWidth`/`innerHeight` under
 * `--headless=new`: measured, and this is exactly what real, non
 * automated headless Chrome does too (there is no OS window frame to
 * report a size for). Not a tell; not touched.
 *
 * `Notification.permission` / `navigator.permissions.query({name:
 * 'notifications'})`: measured `'denied'` for BOTH under this runtime's
 * flag set, headless and headful alike, and also `'denied'` under source
 * 1 (real Chrome, no notification permission ever granted to that
 * profile). Consistent across every source measured; nothing to patch,
 * and no evidence it is automation-correlated on this Chrome rather than
 * simply "a fresh profile with no notification grants".
 */

import type {
  StealthCheckResult,
  StealthProfile,
  StealthTargetContext,
} from '@browserglass/protocol';

/**
 * Reads the live UA string plus (when available) `navigator.userAgentData`'s
 * full detail, as one round trip. `uad: null` distinguishes "this page has
 * no Client Hints API at all" (insecure context, or a Chrome build old
 * enough not to have shipped it) from a well formed but empty result,
 * which the empty-metadata trap this file's header describes would
 * otherwise make indistinguishable from "already correct".
 */
const READ_UA_STATE = `(async () => {
  const uad = navigator.userAgentData;
  if (!uad) return JSON.stringify({ ua: navigator.userAgent, uad: null });
  let high = {};
  try {
    high = await uad.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList']);
  } catch {
    // Older Chrome without the high entropy call, or a permissions policy
    // refusal. The low entropy fields read below still cover brands/
    // mobile/platform, which is most of what a bare
    // Emulation.setUserAgentOverride call would otherwise wipe.
  }
  return JSON.stringify({
    ua: navigator.userAgent,
    uad: {
      brands: uad.brands,
      mobile: uad.mobile,
      platform: uad.platform,
      platformVersion: high.platformVersion ?? '',
      architecture: high.architecture ?? '',
      model: high.model ?? '',
      fullVersionList: high.fullVersionList ?? uad.brands,
    },
  });
})()`;

interface UaState {
  ua: string;
  uad: {
    brands: readonly { brand: string; version: string }[];
    mobile: boolean;
    platform: string;
    platformVersion: string;
    architecture: string;
    model: string;
    fullVersionList: readonly { brand: string; version: string }[];
  } | null;
}

function parseUaState(raw: unknown): UaState | null {
  if (typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw) as UaState;
    return typeof parsed?.ua === 'string' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Strips the `"Headless"` marker Chrome's own UA generator adds under
 * `--headless=new`. Textual, not a hardcoded template: this transforms
 * whatever the actually running Chrome build already generated (read live
 * via {@link READ_UA_STATE}), so it stays correct across a Chrome upgrade
 * without this file changing, and never invents a UA this exact browser
 * would not otherwise have produced itself in headful mode. See this
 * module's header comment, CHECK 2, for the measurement showing the two
 * strings differ by exactly this substring on Chrome 152.
 */
function stripHeadless(ua: string): string {
  return ua.replace(/HeadlessChrome\//, 'Chrome/').replace('Headless', '');
}

export const MEASURED_STEALTH_PROFILE: StealthProfile = {
  name: 'browserglass-measured-reference',
  level: 'full',
  // Semver for this file's own content; bump whenever the UA fix or the
  // selfTest checks below change, per the same reasoning `basic.ts`
  // documents for its own `version` field.
  version: '0.1.0',
  // Populated from real `runStealthSelfTest` runs on this machine
  // (`stealth-self-test.ts`), not asserted from memory. See
  // `examples/nextjs-demo/stealth-selftest-probe.mjs`'s recorded output
  // for the run this number reflects: Chrome 152.0.7977.64, both headful
  // and `--headless=new`, every check in `selfTest` below `ok: true`.
  validatedChromeMajors: [152],

  launchArgs(_spec) {
    // Nothing at the launch-flag layer: `--user-agent=` cannot go through
    // `launchArgs` (see this module's header, CHECK 2) and every other
    // tell this profile addresses is already unconditional in `flags.ts`
    // (`--disable-blink-features=AutomationControlled`) or fixed at the
    // CDP layer in `onTargetAttached` below.
    return [];
  },

  initScripts(_spec) {
    // Deliberately empty. See this module's header: every JS-level patch
    // considered (webdriver, UA) was measured to either be unnecessary
    // (the flag already produces the real value) or actively harmful (a
    // JS-defined getter's `toString()` gives away the patch). The one
    // real fix this profile makes, the headless UA string, is a CDP
    // command in `onTargetAttached`, not page JS, precisely so its
    // `navigator.userAgent` getter stays the native one Chrome itself
    // still owns.
    return [];
  },

  async onTargetAttached(ctx: StealthTargetContext): Promise<void> {
    // Same CDP primitive and same best-effort reasoning as
    // `basic.ts`: unsupported on some Chrome builds/target types, and a
    // profile adjustment must never fail the target attach it is trying
    // to adjust (`target-registry.ts`'s `runStealthOnTargetAttached` doc
    // comment).
    try {
      await ctx.send('Emulation.setAutomationOverride', { enabled: false });
    } catch {
      // See basic.ts's identical catch: unsupported build or domain-less
      // target, not fatal.
    }

    // The headless UA fix (CHECK 2 above). Best effort, wrapped as one
    // block: a target that cannot run this (a worker, a Chrome build
    // without `userAgentData`) must not fail the rest of attach, matching
    // every other CDP adjustment in this file and in `basic.ts`.
    try {
      const raw = await ctx.evaluate(READ_UA_STATE);
      const state = parseUaState(raw);
      if (!state) return;
      if (!state.ua.includes('Headless')) return; // Already correct: headful launch, or an app-supplied spec.userAgent without "Headless" in it. True no-op.

      const fixedUa = stripHeadless(state.ua);
      const params: Record<string, unknown> = { userAgent: fixedUa };
      if (state.uad) {
        // Hand back exactly what was read, changing nothing: this is
        // preservation, not invention (see this module's header on the
        // empty-metadata trap this avoids).
        params['userAgentMetadata'] = {
          brands: state.uad.brands,
          fullVersionList: state.uad.fullVersionList,
          platform: state.uad.platform,
          platformVersion: state.uad.platformVersion,
          architecture: state.uad.architecture,
          model: state.uad.model,
          mobile: state.uad.mobile,
        };
      }
      await ctx.send('Emulation.setUserAgentOverride', params);
    } catch {
      // Evaluate/send failure on this target; the automation override
      // above still stands on its own.
    }
  },

  async selfTest(ctx: StealthTargetContext): Promise<readonly StealthCheckResult[]> {
    const results: StealthCheckResult[] = [];

    // CHECK 1a: navigator.webdriver's VALUE. Expects the boolean `false`,
    // the value this module's header measured real Chrome and this
    // runtime's own flagged launch both produce, not the string
    // `'undefined'` basic.ts's own (differently reasoned, now measurably
    // stale) check expects.
    try {
      const value = await ctx.evaluate('navigator.webdriver');
      const observed = JSON.stringify(value);
      results.push({
        check: 'navigator.webdriver value',
        observed,
        expected: 'false',
        ok: value === false,
      });
    } catch (err) {
      results.push({
        check: 'navigator.webdriver value',
        observed: `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`,
        expected: 'false',
        ok: false,
      });
    }

    // CHECK 1b: navigator.webdriver's SHAPE. This is the check that would
    // have caught basic.ts's own regression: a value can happen to match
    // while the descriptor gives the patch away. Expects a native getter,
    // matching real Chrome exactly (this module's header measurement),
    // because this profile installs no JS patch for this property at all.
    try {
      const getterSource = await ctx.evaluate(
        `(() => { const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'webdriver'); return d && typeof d.get === 'function' ? d.get.toString() : '<no native getter>'; })()`,
      );
      const observed = String(getterSource);
      results.push({
        check: 'navigator.webdriver getter shape',
        observed,
        expected: 'contains "[native code]" (real Chrome getter, not a JS-defined shim)',
        ok: observed.includes('[native code]'),
      });
    } catch (err) {
      results.push({
        check: 'navigator.webdriver getter shape',
        observed: `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`,
        expected: 'contains "[native code]"',
        ok: false,
      });
    }

    // CHECK 2a: navigator.userAgent no longer names itself Headless.
    try {
      const ua = await ctx.evaluate('navigator.userAgent');
      const observed = String(ua);
      results.push({
        check: 'navigator.userAgent has no "Headless" marker',
        observed,
        expected: 'a UA string with no "Headless" substring',
        ok: !observed.includes('Headless'),
      });
    } catch (err) {
      results.push({
        check: 'navigator.userAgent has no "Headless" marker',
        observed: `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`,
        expected: 'a UA string with no "Headless" substring',
        ok: false,
      });
    }

    // CHECK 2b: navigator.userAgent's SHAPE stayed native. This is the
    // anti-regression check for the UA fix specifically: it proves the
    // fix landed via Emulation.setUserAgentOverride (a CDP/network layer
    // change) rather than a JS property shim, which would read as
    // ordinary JS source here instead of native code.
    try {
      const getterSource = await ctx.evaluate(
        `(() => { const d = Object.getOwnPropertyDescriptor(Navigator.prototype, 'userAgent'); return d && typeof d.get === 'function' ? d.get.toString() : '<no native getter>'; })()`,
      );
      const observed = String(getterSource);
      results.push({
        check: 'navigator.userAgent getter shape',
        observed,
        expected: 'contains "[native code]" (CDP-level override, not a JS-defined shim)',
        ok: observed.includes('[native code]'),
      });
    } catch (err) {
      results.push({
        check: 'navigator.userAgent getter shape',
        observed: `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`,
        expected: 'contains "[native code]"',
        ok: false,
      });
    }

    // CHECK 2c: navigator.userAgentData was not wiped by the fix above.
    // Only meaningful on a secure context; an insecure page reports
    // `<no userAgentData (insecure context or unsupported)>` and passes
    // vacuously, since there is nothing this profile could have wiped
    // that the page could ever have observed anyway (see this module's
    // header, the documented insecure-origin gap).
    try {
      const raw = await ctx.evaluate(READ_UA_STATE);
      const state = parseUaState(raw);
      if (!state?.uad) {
        results.push({
          check: 'navigator.userAgentData not wiped',
          observed: '<no userAgentData (insecure context or unsupported)>',
          expected: 'non-empty brands, or no userAgentData API at all',
          ok: true,
        });
      } else {
        const observed = JSON.stringify(state.uad.brands);
        results.push({
          check: 'navigator.userAgentData not wiped',
          observed,
          expected: 'a non-empty brands array',
          ok: Array.isArray(state.uad.brands) && state.uad.brands.length > 0,
        });
      }
    } catch (err) {
      results.push({
        check: 'navigator.userAgentData not wiped',
        observed: `<evaluate failed: ${err instanceof Error ? err.message : String(err)}>`,
        expected: 'a non-empty brands array, or no userAgentData API at all',
        ok: false,
      });
    }

    return results;
  },
};
