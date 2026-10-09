/**
 * `runStealthSelfTest`: the wiring `StealthProfile.selfTest` (`@browserglass/protocol`,
 * `runtime.ts`) needed and never had. Before this file, `selfTest` was
 * declared on the interface, implemented by `basic.ts`, and called by
 * NOTHING anywhere in this repo (grep it): a dead contract, same shape
 * as `BrowserSpec.stealth` before `stealth.ts` and `Instance.lifetime`
 * before their own fixes. `validatedChromeMajors` on a `StealthProfile`
 * is meaningless without some way to actually run `selfTest` against a
 * real Chrome and read the result; this is that way.
 *
 * WHERE THIS RUNS, AND WHY NOT AT LAUNCH. Three options were on the
 * table: wire `selfTest` into every `HostRuntime.doLaunch` behind a
 * config flag, expose it only on demand, or both. This file picks ON
 * DEMAND ONLY, for three reasons:
 *
 *   1. `selfTest`'s own doc comment describes it as running "against
 *      `about:blank` plus a bundled local fixture page", i.e. a
 *      diagnostic against a KNOWN page, not the app's actual first
 *      navigation. Running it on every real launch would mean either
 *      spending an extra target + a handful of `Runtime.evaluate` round
 *      trips on every launch for a check whose answer does not change
 *      launch to launch on the same Chrome build (validation is a
 *      property of {profile version, Chrome major}, not of one launch),
 *      or running it against the app's real first page, which is not
 *      what `selfTest` is documented to assume.
 *   2. Wiring it into `doLaunch` means widening `HostRuntimeConfig`
 *      (`config.ts`) and `runtime.ts`'s launch path, both files this
 *      task does not own the way it owns `stealth*`/`stealth-profiles/**`.
 *      A diagnostic feature is not worth a shared-file collision with
 *      concurrent work on this branch.
 *   3. An operator's actual question is "does this profile still do what
 *      it claims on the Chrome build I just installed", asked rarely (on
 *      upgrade, in CI, before flipping `enabledStealthLevels` on for the
 *      first time), never per launch. A callable function an operator's
 *      own script or CI job invokes matches that cadence; a per-launch
 *      flag would not.
 *
 * WHAT THIS DOES NOT REUSE, AND WHY. `@browserglass/core`'s
 * `TargetRegistry` is the production path that installs `initScripts`
 * and calls `onTargetAttached` for real (`target-registry.ts`'s
 * `installInitScripts`/`runStealthOnTargetAttached`), but it never calls
 * `selfTest` either (that is the same missing wire this file exists to
 * add) and its auto-attach machinery is built around a whole
 * `HostRuntime`-launched Instance lifecycle, not a standalone "attach,
 * run three profile methods, detach" diagnostic. This file instead uses
 * `@browserglass/core`'s lower level `createCdpBridge` directly (already
 * a `runtime-host` package dependency; unlike `identity-probe.ts`'s
 * local copy of `probeCdpIdentity`, this is a normal published-package
 * import of `@browserglass/core`'s own barrel, not a reach into its
 * `src/`, so the `tsup`/`dts` problem that comment describes does not
 * apply here) to open one target, attach one session, and drive the
 * three `StealthProfile` methods by hand:
 *
 *   - `initScripts(spec)` sources are evaluated directly via
 *     `Runtime.evaluate` rather than installed through
 *     `Page.addScriptToEvaluateOnNewDocument` plus a navigation.
 *     `selfTest` only needs the END STATE an init script produces (a
 *     property redefinition already lands the moment the script runs);
 *     the guarantee that matters for PRODUCTION correctness, that the
 *     script runs before any page script including the very first one
 *     Chrome loads, is `target-registry.ts`'s job and is exercised by
 *     that package's own tests, not this diagnostic's.
 *   - `onTargetAttached(ctx)` and `selfTest(ctx)` are called exactly as
 *     their interface promises, against a `StealthTargetContext` built
 *     from the bridge session the same way
 *     `target-registry.ts`'s own `runStealthOnTargetAttached` builds one
 *     (`evaluate` via a plain `Runtime.evaluate`, `send` via the bridge's
 *     `send` on this session).
 */

import { createCdpBridge } from '@browserglass/core';
import type { CdpBridge } from '@browserglass/core';
import type {
  BrowserSpec,
  StealthCheckResult,
  StealthProfile,
  StealthTargetContext,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';

/** Options for {@link runStealthSelfTest}. */
export interface RunStealthSelfTestOptions {
  /** The profile under test. Its `initScripts`/`onTargetAttached`/`selfTest` all run for real against the browser at `cdpUrl`. */
  profile: StealthProfile;
  /**
   * The `BrowserSpec` `initScripts(spec)`/`launchArgs(spec)` are resolved
   * against. `launchArgs` is not applied by this function (there is no
   * running browser left to relaunch with them; the caller is expected to
   * have already started Chrome under the profile's own `launchArgs`
   * output, the same way `HostRuntime.doLaunch` does), but `initScripts`
   * is spec-dependent and this keeps the self test faithful to the spec a
   * real launch would use.
   */
  spec: BrowserSpec;
  /**
   * Either the browser-level CDP websocket URL directly (`ws://...`), or
   * the HTTP origin CDP's `/json/version` answers on (for example
   * `http://127.0.0.1:9222`, `discoverCdpEndpoint`'s own `cdpUrl` shape),
   * in which case this function resolves the websocket URL itself via one
   * `GET /json/version`.
   */
  cdpUrl: string;
  /** The page this self test attaches to and runs against. Default `about:blank`, matching `selfTest`'s own doc comment. */
  navigateUrl?: string;
  /** Injectable for tests; defaults to the real global `fetch`. */
  fetchImpl?: typeof fetch;
}

/** One `runStealthSelfTest` run's full, structured result: enough for an operator to decide whether to add this Chrome major to `validatedChromeMajors` honestly. */
export interface StealthSelfTestReport {
  profile: { name: string; level: string; version: string };
  /** From CDP `Browser.getVersion`'s own `product` field, e.g. `"Chrome/152.0.7977.64"`. */
  chromeProduct: string;
  /** Parsed major version number, the same granularity `validatedChromeMajors` records. */
  chromeMajor: number;
  results: readonly StealthCheckResult[];
  /** Every `results[i].ok`, so a caller does not have to re-derive pass/fail. */
  allOk: boolean;
  ranAt: string;
}

async function resolveWebSocketUrl(cdpUrl: string, fetchImpl: typeof fetch): Promise<string> {
  if (cdpUrl.startsWith('ws://') || cdpUrl.startsWith('wss://')) return cdpUrl;
  const res = await fetchImpl(`${cdpUrl.replace(/\/+$/, '')}/json/version`);
  if (!res.ok) {
    throw new Error(`runStealthSelfTest: GET ${cdpUrl}/json/version returned HTTP ${res.status}`);
  }
  const body = (await res.json()) as { webSocketDebuggerUrl?: unknown };
  if (typeof body.webSocketDebuggerUrl !== 'string') {
    throw new Error(`runStealthSelfTest: ${cdpUrl}/json/version had no webSocketDebuggerUrl`);
  }
  return body.webSocketDebuggerUrl;
}

/**
 * `StealthTargetContext.evaluate`'s implementation for this runner,
 * intentionally identical in shape to `target-registry.ts`'s own
 * `evaluateForStealth` (same CDP params, same exception handling): a
 * `StealthProfile`'s own trusted code is calling this, matching that
 * method's own doc comment reasoning for why it stays simpler than
 * `evaluate.ts`'s `evaluateInSession`.
 */
async function evaluateForSelfTest(
  bridge: CdpBridge,
  sessionId: Parameters<CdpBridge['send']>[2],
  expression: string,
): Promise<unknown> {
  const response = (await bridge.send(
    'Runtime.evaluate',
    { expression, returnByValue: true, awaitPromise: true },
    sessionId,
  )) as {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string };
  };
  if (response.exceptionDetails) {
    throw new Error(response.exceptionDetails.text ?? 'Runtime.evaluate threw');
  }
  return response.result?.value;
}

/**
 * Connects to a live Chrome, opens one fresh target, runs `profile.initScripts`,
 * `onTargetAttached`, then `selfTest` against it in that order (the same
 * order `target-registry.ts` runs the first two in for a real launch),
 * and returns the structured report. Always closes the target and the
 * bridge connection before returning or throwing, so a failed self test
 * does not leak a tab or a socket on the Chrome instance under test.
 */
export async function runStealthSelfTest(
  opts: RunStealthSelfTestOptions,
): Promise<StealthSelfTestReport> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const wsUrl = await resolveWebSocketUrl(opts.cdpUrl, fetchImpl);

  const bridge = createCdpBridge(newId('inst'));
  const version = await bridge.connect({ url: wsUrl });

  let targetId: string | null = null;
  try {
    const created = (await bridge.send('Target.createTarget', {
      url: opts.navigateUrl ?? 'about:blank',
    })) as { targetId: string };
    targetId = created.targetId;

    const handle = await bridge.sessionFor(targetId);
    const sessionId = handle.id;

    const ctx: StealthTargetContext = {
      cdpSessionId: sessionId,
      targetId,
      evaluate: (expression) => evaluateForSelfTest(bridge, sessionId, expression),
      send: (method, params) => bridge.send(method, params, sessionId),
    };

    // `initScripts(spec)`, evaluated directly rather than installed via
    // `Page.addScriptToEvaluateOnNewDocument` plus a reload. See this
    // module's header for why that is faithful enough for a self test.
    for (const script of opts.profile.initScripts(opts.spec)) {
      try {
        await ctx.evaluate(script.source);
      } catch (err) {
        throw new Error(
          `runStealthSelfTest: init script '${script.name}' threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    await opts.profile.onTargetAttached(ctx);
    const results = await opts.profile.selfTest(ctx);

    return {
      profile: {
        name: opts.profile.name,
        level: opts.profile.level,
        version: opts.profile.version,
      },
      chromeProduct: version.full || version.product,
      chromeMajor: version.major,
      results,
      allOk: results.every((r) => r.ok),
      ranAt: new Date().toISOString(),
    };
  } finally {
    if (targetId) {
      await bridge.send('Target.closeTarget', { targetId }).catch(() => {
        // Best effort: the target may already be gone if selfTest itself
        // navigated it away or crashed it. Not this function's problem to
        // solve, only not to hide.
      });
    }
    await bridge.close('stealth self test complete').catch(() => {
      // Already closed, or never fully opened; nothing left to release.
    });
  }
}
