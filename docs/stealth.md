# Stealth: what happens by default

BrowserGlass does specific, measured things to reduce automation signals. This page is what, how it was verified, and what it deliberately does not do.

## What happens at every launch

Every browser launched by BrowserGlass gets these, regardless of stealth setting.

**`--disable-blink-features=AutomationControlled`.** This is Blink's own automation suppression flag, passed at every level. It stops the browser from emitting certain signals that a page can read; most notably, the value of `navigator.webdriver` becomes `false` (on real, non-automated Chrome it is `false` too). See `packages/runtime-host/src/flags.ts:205`.

**Evaluate runs in isolated worlds.** Every `Page.createIsolatedWorld` call that the evaluation surface makes means code runs in a separate context from the page's own scripts. The page cannot eavesdrop on what is being evaluated or patch the globals we see. See `packages/automation/src/client/AutomationClient.ts` for the evaluation surface.

**`Runtime.enable` is sent from one place.** The only module that sends `Runtime.enable` is `packages/core/src/diagnostics/target-diagnostics.ts:399`, verified by grepping the entire build. That call is conditional: it happens only when a viewer subscribes to console or error diagnostics. This is load-bearing for the stealth story below.

---

## The tradeoff: console diagnostics make you visible

This is the one honest, measured decision every operator needs to know about.

**Console and error diagnostics cost liveness.** Subscribing to `diagnostics.subscribe` with `console: true` or `errors: true` causes the module above to send `Runtime.enable` to the browser. That call makes `Runtime` domain active, which produces `executionContextCreated` events and broadcasts every `console.log` the page makes as a `consoleAPICalled` event. A page can detect that activity: Chrome's debug protocol emits these as observable state changes, and a page that listens for them learns that a remote driver is present.

**Measured.** Against Chrome 152 (Windows, the machine the measurements were taken on):

- Five `Runtime.evaluate` calls with `Runtime` never enabled: zero `executionContextCreated` events, zero `consoleAPICalled` events.
- One `Runtime.enable` call: produces at least one `executionContextCreated` event.
- After that, 25 `console.log` calls: 25 observable `consoleAPICalled` events (one per call).

This is from `examples/nextjs-demo/diagnostics-fingerprint-probe.mjs`, run against the live gateway.

**Network diagnostics never touch `Runtime`.** You can debug network traffic, watch requests and responses, and stay inaudible. `fetchNetworking()` in `packages/core/src/diagnostics/target-diagnostics.ts` never sends `Runtime.enable`. It turns on the browser's own network instrumentation independently. This was already true in the earlier `applyFeeds` call; the probe above confirms it at the wire level.

**The caller can check before subscribing.** `diagnostics.status.get()` reports `fingerprintActive: true` or `false`, telling you whether this target is already known to be carrying the automation fingerprint. Every `diagnostics.subscribed` reply echoes the current state too. Call this before you subscribe to console, and you can decide whether to accept the visibility cost or skip the console logs.

**Per-request acknowledgement.** A stealth instance refuses console diagnostics with `E_DIAGNOSTICS_STEALTH_CONFLICT` unless the request carries `acknowledgeStealthRisk: true`. This is per request, not global: a second viewer needs to acknowledge the risk independently. It is not a warning, it is a brake: the server refuses the call unless you opt in, so you cannot accidentally enable it.

---

## The MEASURED_STEALTH_PROFILE

**What it is.** A `StealthProfile` registered at level `'full'` whose every claim was checked against a real, locally installed Chrome before being written. Measured on Chrome 152.0.7977.64 (Windows, via `binary-discovery.ts`).

**How to use it.** Register it when you create the host runtime:

```typescript
import { createHostRuntime, MEASURED_STEALTH_PROFILE } from '@browserglass/runtime-host';

const { runtime } = await createHostRuntime({
  nodeId: 'node-1',
  stealthProfiles: [MEASURED_STEALTH_PROFILE],
  enabledStealthLevels: ['off', 'full'],
  // ... stateDir, profileRoot, and the rest of HostRuntimeConfig
});
```

The `validatedChromeMajors` field records that this profile was verified against Chrome 152. If your Chrome updates to 153, the measurements may shift.

**The measurement method.** Three sources were compared against each other:

1. Real, non-automated Chrome: an everyday Chrome window a person already has open, read through page-JS evaluation that does not add any CDP or automation flags.
2. Stock automated: Chrome launched with nothing but basic flags (`--user-data-dir`, `--remote-debugging-port`, `--no-first-run`, `--no-default-browser-check`) and no automation-suppressing flags.
3. This runtime's own launch: Chrome with the exact flag set `flags.ts`'s `UNCONDITIONAL_BASE_FLAGS` produces, headful and headless, matching what `HostRuntime.doLaunch` actually runs.

Every check below cites which source found what. The measurements are from `packages/runtime-host/src/stealth-profiles/measured.ts`, the source of truth for this page.

---

## What it closes

**`navigator.webdriver` value.** Closed via `--disable-blink-features=AutomationControlled` (applied at launch to every browser, regardless of stealth level). A real Chrome's getter returns `false`. Stock automated Chrome's getter returns `true` (it now treats "remote debugging port open at all" as automation). This runtime's browsers return `false`, matching real Chrome.

**`navigator.userAgent` under headless.** Closed via `Emulation.setUserAgentOverride`. Measured on the Windows test machine:

- Headless stock automated: `Mozilla/5.0 ... HeadlessChrome/152.0.0.0 ...`
- Real Chrome (non-automated): `Mozilla/5.0 ... Chrome/152.0.0.0 ...`
- This runtime headless: `Mozilla/5.0 ... Chrome/152.0.0.0 ...` (the `HeadlessChrome` marker is removed)

The string `HeadlessChrome` in a User-Agent is one of the single most commonly checked automation signals. Leaving it would contradict shipping a stealth profile at all.

**`navigator.userAgentData` is not wiped.** When `setUserAgentOverride` is called with only `userAgent` set and no `userAgentMetadata`, Chrome silently wipes `navigator.userAgentData` to an empty object. This profile reads `userAgentData` BEFORE overriding the UA string and hands the metadata back in the same call, so nothing is lost. Measured: the values are already identical between headless and headful Chrome on the Windows test machine (brands, platform, mobile flags do not mention headless mode).

A gap here: on insecure origins (non-HTTPS, non-localhost), `navigator.userAgentData` is `undefined` (the Client Hints JS API's own secure-context gate). This profile has nothing to read back and sends no metadata in that case. Low-entropy headers may still reflect the absence on such pages.

---

## What it does not close, and why

**`navigator.plugins` and `navigator.mimeTypes`.** Measured identical across all three sources (5 plugins, 2 mime types) on this Chrome, headless and headful alike. Nothing to patch.

**`window.chrome`.** Measured identical across all three sources (`{app, csi, loadTimes}`). Nothing to patch.

**WebGL vendor and renderer strings.** Measured identical between headless and headful on the Windows test machine because it has a real GPU. On a GPU-less host (typical Linux CI), headless Chrome legitimately reports a software renderer (SwiftShader), whether or not it is automated. Spoofing a vendor string there would MANUFACTURE a fingerprint no real browser on that host produces. A patch must make the browser look MORE LIKE an unpatched Chrome, never merely different. Not implemented on principle.

**`outerWidth` equals `innerWidth` in headless.** Measured, and this is exactly what real, non-automated headless Chrome does too. There is no OS window frame in headless, so there is no difference to report. Not a tell; not touched.

**`Notification.permission`.** Measured `'denied'` across all three sources, including real Chrome on a fresh profile. Not automation-correlated on this Chrome.

**`navigator.plugins` revealing the automation flag itself.** Plugins and WebGL vendor strings are identical whether or not the flag is set, measured on this Chrome. Nothing is hidden inside them.

---

## What not to believe

**Undetectability.** This profile closes specific, named automation signals on a specific Chrome version. It does not defeat commercial bot-detection services. It does not make detection impossible. The tells that are NOT closed above are still visible to any code that looks for them.

**Universal coverage.** Chrome updates frequently. Every measurement above is from 152. Chrome 153, 154, and later may behave differently. If you are running this profile against a newer Chrome, rerun `runStealthSelfTest` (in `packages/runtime-host/src/stealth-self-test.ts`) to learn what changed. This is the honest way to keep `validatedChromeMajors` current.

**Protection against sophisticated detection.** A sufficiently motivated detector can watch the network stack, check for anomalous TLS/HTTP/2 fingerprints, correlate cookies and localStorage across visits, or instrument the user's OS. None of that is on this page because this profile does not touch any of it.

---

## The lesson

A patch must make the browser look MORE LIKE an unpatched Chrome, never merely different.

`BASIC_STEALTH_PROFILE` (kept in the tree as a reference implementation, not a recommended profile) patches `navigator.webdriver`'s getter in JavaScript to return `undefined`. The value is correct. The mechanism is wrong: a real browser's getter reads `"function get webdriver() { [native code] }"`, but after this profile's patch, it reads `"() => undefined"`. That is a strictly worse, newly-introduced tell that no real browser shows, measured directly on Chrome 152 after the patch runs.

`basic.ts`'s own justification (that `--disable-blink-features=AutomationControlled` removes the property entirely) was measured to be wrong on this Chrome. The property is present with a native getter in every source tested, including genuinely non-automated Chrome. The flag changes only the value the getter returns, not whether the property exists.

`MEASURED_STEALTH_PROFILE` does not patch the webdriver property at all. The flag produces the correct value via the native getter. Adding a JS patch on top would make it worse, not better.

Assert on shape, not value. When you write a stealth patch, check that the getter, the descriptor, and the prototype shape all match the real thing. A test that only checks the value cannot tell "correct" from "correct value, wrong mechanism".

---

## Stealth self-test

`runStealthSelfTest` in `packages/runtime-host/src/stealth-self-test.ts` validates a profile against a live Chrome. This is how `validatedChromeMajors` gets populated honestly.

Run it after a Chrome update:

```bash
cd packages/runtime-host
npx tsx src/stealth-self-test.ts
```

It launches a browser under the profile and checks every claim this page makes, reporting which Chrome version it tested and whether all checks passed. Add the major version to `validatedChromeMajors` in the profile itself if all checks pass.

See `examples/nextjs-demo/stealth-selftest-probe.mjs` for a probe that exercises this against the live gateway.

---

## Reading this if you are building a profile

Copy `MEASURED_STEALTH_PROFILE`'s shape, not `BASIC_STEALTH_PROFILE`'s. Implement `launchArgs`, `initScripts`, `onTargetAttached`, and `selfTest`. Test every patch against a real Chrome build before shipping. Record the major versions in `validatedChromeMajors`. When Chrome updates, rerun the self-test. Keep a changelog of what broke between Chrome versions so later operators understand why a patch was dropped or revised.

The tradeoff between console diagnostics and invisibility (the first section above) is baked into the core, not the profile. An operator configures whether to acknowledge the risk. A profile has no say in that.
