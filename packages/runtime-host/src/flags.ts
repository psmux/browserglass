/**
 * Chrome launch flag composition: the base set, the headless mode, and the
 * ephemeral profile footprint flags.
 * The three backgrounding flags are composed as one inseparable set: drop
 * any one of them and an unfocused browser stops producing screencast
 * frames after about 30 seconds, which silently kills the demo.
 *
 * ---
 *
 * RECONCILIATION AGAINST A TYPICAL PATCHRIGHT LAUNCHER'S COMMAND LINE
 *
 * A typical patchright based automation script, of the kind that would
 * move onto this runtime, passes 21 flags between its launchers.
 * Every one was checked against this file and against `ARG_DENY`/`ARG_ALLOW`,
 * and the outcome is recorded here so the next person does not have to
 * redo it. Four outcomes were possible: already set here, added to the
 * base set, widen `ARG_ALLOW`, or not needed.
 *
 * ALREADY SET, unconditionally, before any of this work:
 *   `--no-first-run`, `--no-default-browser-check`,
 *   `--disable-blink-features=AutomationControlled`.
 *
 * ALREADY SET, from a `BrowserSpec` field rather than from `extraArgs`,
 * which is the right door for each:
 *   `--user-data-dir` (from the materialised profile),
 *   `--remote-debugging-port` (always `=0`, real port read back from
 *   `DevToolsActivePort`), `--headless=new` (from `spec.headless`),
 *   `--window-size` (from `spec.window`/`spec.viewport`). The first three
 *   are on `ARG_DENY` precisely so an app cannot set them a second way.
 *
 * ADDED to the base set by this work, see {@link UNATTENDED_DIALOG_FLAGS}
 * and {@link DISABLED_FEATURES}:
 *   `--noerrdialogs`, `--hide-crash-restore-bubble`,
 *   `--disable-session-crashed-bubble`,
 *   `--disable-search-engine-choice-screen`, `--disable-sync`, and the
 *   `InfiniteSessionRestore` and `PasswordManagerOnboarding` feature
 *   disables folded into the single `--disable-features=` value.
 *
 * `ARG_ALLOW` WIDENED: none, and that is deliberate. `arg-lists.ts` says
 *   operators may extend the allow list and apps may not. Every flag above
 *   is a property of how this runtime launches Chrome, not a choice an app
 *   should get to make, so it belongs in the base set where the whole
 *   command line stays reviewable in one file.
 *
 * NOT NEEDED, with the reason:
 *   `--profile-directory=Default` is Chrome's own default.
 *   `--password-store=basic` is a Linux keyring switch and is already
 *     added on linux; on Windows the credential store is DPAPI and the
 *     switch does nothing.
 *   `--use-mock-keychain` is a macOS Keychain switch and is already added
 *     on darwin, which is the only platform where the OSCrypt key
 *     agreement it buys can matter. A launcher that omitted it there would
 *     use a different key, fail to decrypt a single cookie, and Chrome
 *     would answer by deleting all of them.
 *   `--disable-save-password-bubble` is superseded by
 *     `profile-heal.ts` writing `credentials_enable_service: false` and
 *     `password_manager.saving_enabled: false` into the profile, which
 *     works on Chrome builds where the flag has been removed.
 *   `--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`,
 *     `--deny-permission-prompts`, `--disable-notifications`: permissions
 *     are a `BrowserSpec.permissions` question, applied through CDP
 *     (`Browser.grantPermissions`), not a launch flag question. Nothing in
 *     the apply path asks for a camera or a microphone.
 *   `--disable-popup-blocking`: such scripts often pass it, patchright
 *     strips it, and this runtime now strips it too. See
 *     {@link UNCONDITIONAL_BASE_FLAGS} for the argument, which is that a
 *     real dispatched click carries a user activation and a popup opened
 *     from one is never blocked.
 *   `--disable-features=IsolateOrigins,site-per-process`: on `ARG_DENY`,
 *     and widely documented as an automation tell.
 */

import { isArgAllowed } from '@browserglass/protocol';
import type { BrowserSpec, HeadlessMode } from '@browserglass/protocol';

/**
 * The three flags that, together, keep an unfocused or occluded window
 * producing frames. Never pass a subset.
 */
export const BACKGROUNDING_FLAGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
] as const;

/**
 * The features `--disable-features` turns off, as ONE list.
 *
 * One occurrence, never two. Chrome keeps only the LAST
 * `--disable-features=` on a command line and silently discards every
 * earlier one, so a second occurrence added elsewhere does not extend this
 * list, it replaces it. That is a real defect in the wild: a launcher that
 * adds a second `--disable-features=` beside the one it already passes
 * loses the first without any warning. Add to this
 * array; never push another `--disable-features=` anywhere in this file.
 *
 *  * `CalculateNativeWinOcclusion`: stops the occlusion heuristic
 *    from mistaking an unfocused or off-screen window for occluded and
 *    throttling it, the same family of problem the three backgrounding
 *    flags fix.
 *  * `InfiniteSessionRestore`: the machinery behind Chrome reopening the
 *    tabs from a session it thinks crashed. See
 *    {@link UNATTENDED_DIALOG_FLAGS} for why an unattended run must never
 *    meet that, and `profile-heal.ts` for the repair that removes the
 *    reason it would fire.
 *  * `PasswordManagerOnboarding`: the one-time "Chrome can save your
 *    passwords" interstitial, which lands over the page on a profile that
 *    has just been signed into somewhere.
 */
const DISABLED_FEATURES = [
  'CalculateNativeWinOcclusion',
  'InfiniteSessionRestore',
  'PasswordManagerOnboarding',
] as const;

/**
 * The flags that keep an unattended browser from stopping in front of a
 * dialog nobody is there to dismiss.
 *
 * These live in the runtime's unconditional set rather than on
 * `ARG_ALLOW`, and the distinction is the whole point. `arg-lists.ts` says
 * operators may extend the allow list in node config and apps may not;
 * putting these on it would let any app pass them, and "should this
 * browser show a crash restore bubble" is not an app's decision. It is a
 * property of how THIS runtime launches Chrome, unattended, with nobody at
 * the keyboard. So it is set unconditionally and stays reviewable in one
 * file.
 *
 * Why they became necessary. Under an ephemeral profile the question never
 * came up: the profile is a fresh clone of a cleanly closed seed and it is
 * deleted before a second launch can read it. A PERSISTENT profile is
 * relaunched, and on Windows this runtime's terminate ladder collapses
 * `'graceful'` to `taskkill /T /F` (`terminate.ts`, there being no softer
 * signal for a GUI process tree), which leaves `exit_type: "Crashed"` in
 * `Default/Preferences`. The next launch reads that and puts up "Restore
 * pages?" over whatever the automation was about to do.
 *
 * `profile-heal.ts` removes the CAUSE, by rewriting `exit_type` before
 * every launch. These are the second line, for the crash this process did
 * not see and could not heal. Long running automation setups commonly pass
 * the first three for the same reason, having lost runs to exactly this
 * bubble.
 */
const UNATTENDED_DIALOG_FLAGS = [
  '--noerrdialogs',
  '--hide-crash-restore-bubble',
  '--disable-session-crashed-bubble',
  // patchright passes both of these too (its own `chromiumSwitches`), so
  // neither is a divergence from the driver this runtime is matching.
  '--disable-search-engine-choice-screen',
  '--disable-sync',
] as const;

/**
 * Everything in the base set that does not depend on `BrowserSpec` fields.
 *
 * FIVE FLAGS WERE REMOVED FROM THIS LIST, and the reasoning is recorded
 * here rather than in a commit message because the next person will ask.
 * All five were inherited from Playwright's `chromiumSwitches`, and
 * patchright deliberately strips all five from that list. None of the five
 * is load bearing for anything BrowserGlass does; every one was noise
 * reduction.
 *
 *  * `--disable-popup-blocking`. REMOVED, and it is the one with a
 *    plausible read: a page can call `window.open()` from a timer, with no
 *    user gesture, and see whether it gets a window back. With popup
 *    blocking off it does. That is a one line automation check. Nothing
 *    here needs the flag: this runtime's clicks are real
 *    `Input.dispatchMouseEvent` pairs, which carry a user activation, and
 *    a popup opened from a real click is allowed by the blocker anyway.
 *  * `--disable-client-side-phishing-detection`. REMOVED. Browser internal
 *    Safe Browsing plumbing; nothing in this repo depends on it, and
 *    keeping a flag because Playwright once set it is not a reason.
 *  * `--metrics-recording-only`. REMOVED. Same: it changes what Chrome
 *    does with its own metrics, which no BrowserGlass surface reads.
 *  * `--disable-ipc-flooding-protection`. REMOVED. It was worth checking
 *    whether the streaming and input paths need it, and they do not: the
 *    throttle it disables applies to RENDERER to browser IPC (the classic
 *    `history.replaceState` in a loop), while this runtime's own traffic
 *    runs the other way, browser to renderer, plus a screencast that is
 *    not IPC at all. Meanwhile a page can measure the throttle on itself,
 *    which makes the flag a liability with no compensating benefit.
 *  * `--disable-component-update`. REMOVED. Not page observable, and the
 *    honest argument for keeping it (an unattended run should not have
 *    Chrome fetching components mid session) is real but small; parity
 *    with patchright's set on a flag nothing here reads is worth more. If
 *    a component download ever disrupts a long run, put it back HERE with
 *    the measurement, not on `ARG_ALLOW`.
 *
 * Kept from the same family, deliberately: `--disable-hang-monitor`,
 * `--disable-prompt-on-repost`, `--disable-domain-reliability`,
 * `--disable-breakpad`, `--force-color-profile=srgb`, `--mute-audio`.
 * patchright keeps all of these too, so removing them would be a
 * divergence in the other direction.
 */
const UNCONDITIONAL_BASE_FLAGS = [
  '--remote-debugging-address=127.0.0.1',
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled',
  '--disable-dev-shm-usage',
  ...BACKGROUNDING_FLAGS,
  `--disable-features=${DISABLED_FEATURES.join(',')}`,
  ...UNATTENDED_DIALOG_FLAGS,
  '--disable-hang-monitor',
  '--disable-prompt-on-repost',
  '--disable-domain-reliability',
  '--disable-breakpad',
  '--force-color-profile=srgb',
  '--mute-audio',
] as const;

/** Ephemeral profile footprint flags. */
const EPHEMERAL_FOOTPRINT_FLAGS = [
  '--disk-cache-size=67108864',
  '--media-cache-size=33554432',
  '--disable-background-networking',
] as const;

function headlessFlag(mode: HeadlessMode): string | null {
  // 'xvfb-headful' and 'off' are both a real headful window; the only
  // difference is whether a virtual display owns DISPLAY, which is set on
  // the child process environment, not via a launch flag. Only 'new' adds
  // a flag here, and it is always the modern spelling, never bare
  // `--headless`.
  return mode === 'new' ? '--headless=new' : null;
}

function platformSpecificFlags(): string[] {
  const flags: string[] = [];
  if (process.platform === 'win32') flags.push('--no-service-autorun');
  if (process.platform === 'linux') flags.push('--password-store=basic');
  if (process.platform === 'darwin') flags.push('--use-mock-keychain');
  return flags;
}

/** Options `buildLaunchArgs` needs beyond the resolved `BrowserSpec`. */
export interface BuildLaunchArgsOptions {
  spec: BrowserSpec;
  /** Absolute path to the materialised profile directory (`--user-data-dir`). */
  profilePath: string;
  /** `MaterialisedProfile.mode`; `'ephemeral'` adds the smaller-footprint flags. */
  profileMode: 'ephemeral' | 'persistent' | 'template';
  /** Node config `runtimes.host.allowNoSandbox`, resolved with the `BGLS_UNSAFE_NO_SANDBOX` env fallback already applied. */
  allowNoSandbox: boolean;
  /** Remembered per node after a GPU init failure; never the default, and deliberately not in the base set. */
  disableGpu?: boolean;
  /** Set once Xvfb is up and `DISPLAY` is resolved, for `xvfb-headful`. */
  displayName?: string | null;
  /**
   * The candidate launch args a resolved `StealthProfile.launchArgs(spec)`
   * produced for this launch (`stealth.ts`'s `resolveRequiredStealthProfile`
   * resolves which profile, `HostRuntime.doLaunch` calls `launchArgs` and
   * passes the result here). Screened through the SAME `ARG_DENY`/`ARG_ALLOW`
   * pass as `spec.extraArgs`, immediately below it in the composed command
   * line: `StealthProfile.launchArgs`'s own doc comment says "No exemption",
   * and this is that exemption not existing.
   */
  stealthArgs?: readonly string[];
}

/** One denied `extraArgs` entry, reported so the caller can build `E_ARG_DENIED`. */
export interface DeniedArg {
  arg: string;
}

/** The result of composing a Chrome command line. */
export interface BuiltLaunchArgs {
  args: readonly string[];
  /** Chrome environment overrides (currently only `DISPLAY` for `xvfb-headful`). */
  env: Readonly<Record<string, string>>;
  deniedExtraArgs: readonly DeniedArg[];
  /**
   * `stealthArgs` entries `isArgAllowed` rejected. A well behaved profile
   * leaves this empty; a non-empty result is a profile configuration
   * defect, not untrusted app input, and `HostRuntime.doLaunch` fails the
   * launch on it (`stealthArgDeniedError`) rather than dropping it the way
   * `deniedExtraArgs` is dropped.
   */
  deniedStealthArgs: readonly DeniedArg[];
}

/**
 * Composes the full Chrome command line for one launch: the unconditional
 * base set, the backgrounding triad, headless/window/locale flags derived
 * from `spec`, ephemeral footprint flags when applicable, `opts.stealthArgs`
 * (a resolved `StealthProfile`'s own launch args, see `BuildLaunchArgsOptions.stealthArgs`),
 * and every `spec.extraArgs` entry, with both `stealthArgs` and `extraArgs`
 * surviving the identical `ARG_DENY`/`ARG_ALLOW` screening (deny wins,
 * anything on neither list is rejected). `--user-data-dir` and
 * `--remote-debugging-port=0` are always explicit, never left to a
 * default.
 */
export function buildLaunchArgs(opts: BuildLaunchArgsOptions): BuiltLaunchArgs {
  const { spec, profilePath, profileMode, allowNoSandbox, disableGpu, displayName, stealthArgs } =
    opts;
  const args: string[] = [
    `--user-data-dir=${profilePath}`,
    '--remote-debugging-port=0',
    ...UNCONDITIONAL_BASE_FLAGS,
    ...platformSpecificFlags(),
  ];

  const headless = headlessFlag(spec.headless);
  if (headless) args.push(headless);

  if (spec.headless !== 'new') {
    // Headful (real window or Xvfb-backed window) only.
    args.push(
      `--window-size=${spec.window?.width ?? spec.viewport.width},${spec.window?.height ?? spec.viewport.height}`,
    );
    if (
      spec.window?.x !== null &&
      spec.window?.x !== undefined &&
      spec.window?.y !== null &&
      spec.window?.y !== undefined
    ) {
      args.push(`--window-position=${spec.window.x},${spec.window.y}`);
    }
  }

  if (spec.locale) args.push(`--lang=${spec.locale}`);

  // `BrowserSpec.proxy` names the upstream proxy this Chrome process routes
  // through. Launch flags only: `server` becomes `--proxy-server`, and a
  // non-empty `bypass` becomes `--proxy-bypass-list` (semicolon separated,
  // the one multi-value flag in this file that is not comma separated;
  // that is Chrome's own format for it, not a choice made here).
  //
  // `username`/`password` are NOT handled by this function, and never will
  // be from here: Chrome has no launch flag for proxy credentials, only the
  // CDP `Fetch.enable` / `handleAuthRequests` / `Auth.continueWithAuth`
  // dance, which needs a live CDP session this package never holds, the
  // same reason `initScripts` below is not handled here either. That is
  // `proxyAuthPerInstance`'s job, in a later pass through
  // `packages/core`'s CDP layer; see `capabilities()`.
  if (spec.proxy) {
    args.push(`--proxy-server=${spec.proxy.server}`);
    if (spec.proxy.bypass.length > 0)
      args.push(`--proxy-bypass-list=${spec.proxy.bypass.join(';')}`);
  }

  // `BrowserSpec.userAgent` was accepted, stored (`store-sqlite`'s
  // `specMapping.ts`), read back (`mappers.ts`), and compared for reuse
  // (`reuse.ts`'s share-significant fields) and then silently dropped
  // here: this runtime emitted no user agent flag at all, so every host
  // launched browser ran Chrome's own default no matter what the spec
  // asked for. `runtime-remote` applied it (`spec-apply.ts`), which is
  // what made the gap easy to miss, since the field demonstrably worked
  // on one runtime.
  //
  // Set at LAUNCH rather than through a later
  // `Emulation.setUserAgentOverride`, deliberately. A CDP override is
  // per CDP SESSION, and a cross origin navigation drops the session's
  // domain state (`packages/core/src/session/session.ts`, the same seam
  // diagnostics has to rebind across), so an override silently reverts
  // mid run. The flag cannot revert, and it is already in place before
  // the first request leaves the browser rather than a round trip after
  // it. That ordering is the part that matters for a bot check: a
  // clearance cookie is only honoured alongside the user agent it was
  // issued to, so a browser whose first request goes out under the
  // default agent has already lost the exchange.
  //
  // This does NOT cover client hints. `navigator.userAgentData` is built
  // from Chrome's own brand list, not parsed back out of this string, so
  // a spec carrying `clientHints` needs a gateway sent
  // `Emulation.setUserAgentOverride` with `userAgentMetadata` as well. This
  // package has no live CDP session to send that on (see the `initScripts`
  // paragraph below, same reasoning), so it is the gateway's job:
  // `packages/server/src/session/factory.ts`'s `resolveClientHintsHook`
  // sends it once per attached page/iframe target, composed into the same
  // `StealthProfileHooks.onTargetAttached` slot that file's
  // `resolveStealthHooks` already fills. See `docs/cdp-and-interception.md`.
  if (spec.userAgent) args.push(`--user-agent=${spec.userAgent}`);

  // This also does NOT cover `spec.initScripts`, and never will from this
  // function: unlike `userAgent`, there is no Chrome launch flag for
  // "evaluate this JavaScript before every page's own script runs" at all,
  // not even an imprecise one. The only CDP primitive that does it,
  // `Page.addScriptToEvaluateOnNewDocument`, is scoped to a live CDP
  // session, and this runtime never holds one beyond the single, one-shot
  // `Browser.close` call `cdp-close.ts` makes on a clean terminate. Real
  // application happens in `packages/core/src/cdp/target-registry.ts`,
  // the layer that actually owns a session per target and re-installs the
  // scripts on every new one, including the fresh session a cross origin
  // navigation forces (see that file's `installInitScripts`). A caller
  // wiring a launched `HostRuntime` browser up to a `TargetRegistry` is
  // the one who has to thread `spec.initScripts` through to
  // `createTargetRegistry`; this function has nothing to add to that
  // command line either way.

  // `BrowserSpec.extensions` was accepted, stored, read back, and then
  // dropped here, the same gap `userAgent` had above (see that comment):
  // this runtime emitted no extension flags at all. `--load-extension`
  // takes a comma separated list of UNPACKED extension directories, and it
  // is the only one of the three `ExtensionRef.kind` values Chrome's
  // command line actually supports. There is no launch flag that installs
  // a packed `.crx` or a Web Store `storeId` without a user gesture or an
  // enterprise policy, so entries of those two kinds are accepted by the
  // type, deliberately not attempted here, and `capabilities()` says so
  // (`crx: false`). In practice this is not a live restriction today:
  // both store mappers (`store-sqlite`'s and `store-postgres`'s
  // `storedSpecToBrowserSpec`) only ever produce `kind: 'path'`.
  //
  // `--disable-extensions-except` rides alongside `--load-extension`, over
  // the identical path list: without it, a PERSISTENT profile that has
  // picked up other extensions across its lifetime keeps loading those
  // too, which is not what a spec naming a specific extension set means.
  //
  // Chrome's `headless=new` has real, documented limits on extension
  // loading (no browser action UI, and MV2 extensions do not run at all),
  // so passing these flags under `headless: 'new'` is not a promise the
  // extension behaves as it would headful; see `capabilities()`'s
  // `withHeadlessNew: false`.
  const unpackedExtensionPaths = spec.extensions
    .filter((ext) => ext.kind === 'path')
    .map((ext) => ext.value);
  if (unpackedExtensionPaths.length > 0) {
    args.push(`--load-extension=${unpackedExtensionPaths.join(',')}`);
    args.push(`--disable-extensions-except=${unpackedExtensionPaths.join(',')}`);
  }

  // Never the default; only ever passed once a GPU init failure has been
  // observed and remembered for this node.
  if (disableGpu) args.push('--disable-gpu');

  if (profileMode === 'ephemeral') args.push(...EPHEMERAL_FOOTPRINT_FLAGS);

  if (allowNoSandbox) {
    // The one and only place `--no-sandbox` may be added: gated on the
    // resolved config/env switch, never on an app-supplied spec field
    // (one switch, two spellings). ARG_DENY still applies to everything the app supplies.
    args.push('--no-sandbox');
  }

  // Stealth args land BEFORE `spec.extraArgs`: a `StealthProfile` is
  // operator/vendor configuration, the same trust level as the base flags
  // above it, while `extraArgs` is the one place an app's own request
  // reaches the command line. Putting the trusted set first means an
  // app's `extraArgs` entry is the one that would win a last-flag-wins
  // collision with a stealth flag, never the reverse. Both go through the
  // identical `isArgAllowed` screening; a `StealthProfile` gets no
  // exemption from it (`StealthProfile.launchArgs`'s own doc comment).
  const deniedStealthArgs: DeniedArg[] = [];
  for (const arg of stealthArgs ?? []) {
    if (isArgAllowed(arg)) {
      args.push(arg);
    } else {
      deniedStealthArgs.push({ arg });
    }
  }

  const deniedExtraArgs: DeniedArg[] = [];
  for (const arg of spec.extraArgs) {
    if (isArgAllowed(arg)) {
      args.push(arg);
    } else {
      deniedExtraArgs.push({ arg });
    }
  }

  const env: Record<string, string> = {};
  if (displayName) env['DISPLAY'] = displayName;
  // Host runtime can only set a per-browser timezone via the environment
  // at spawn (see the `timezonePerInstance` capability), never a flag.
  if (spec.timezoneId) env['TZ'] = spec.timezoneId;

  return { args, env, deniedExtraArgs, deniedStealthArgs };
}
