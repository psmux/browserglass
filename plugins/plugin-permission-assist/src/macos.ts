/**
 * The macOS half: clicking Chrome's own "Allow remote debugging?" sheet
 * via `System Events` accessibility traversal, without ever activating
 * Chrome. Ported from browser-harness's `macos.py`, `approve_remote_debugging()`
 * and its `_APPLESCRIPT` constant, which is this file's whole reference.
 *
 * NEVER EXECUTED on the machine that wrote this file. This plugin was
 * built on Windows. Nothing in this
 * module has run against a real Chrome "Allow remote debugging?" sheet, a
 * real macOS Accessibility grant, or a real `osascript` process. What is
 * tested from this machine is argument and script construction only:
 * {@link buildOsascriptArgs}, {@link googleChromeRoot}, and
 * {@link isRemoteDebuggingToggleEnabled} against real fixture files on a
 * real filesystem. The actual `osascript` execution path in
 * {@link runAllowSheetAppleScript}, and every branch of
 * {@link approveRemoteDebugging} that depends on its real output, is
 * exercised in this package's own tests only through an injected fake, and
 * has not run against a real macOS UI tree. This half still needs to be
 * verified on a Mac.
 *
 * Two things are deliberately unlike the video export plugin's own
 * `ffmpeg.ts`. First, this is `platforms: ['darwin']` only in
 * `src/index.ts`'s manifest, and {@link approveRemoteDebugging} itself
 * refuses immediately on any other `process.platform`: a plugin claiming a
 * capability it cannot deliver on a platform is exactly the class of false
 * claim the plugin design refuses to make. Second, nothing here
 * ever runs a shell: `osascript` is invoked through `execFile` with a real
 * `argv` array (see {@link buildOsascriptArgs}), and the script text
 * itself is written to a temp file this process created, never
 * interpolated into a command string.
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/**
 * The exact AppleScript browser-harness's `macos.py` runs, ported
 * unchanged: walks `System Events`' UI element tree for a sheet named
 * exactly "Allow remote debugging?", recurses into its children for an
 * `AXButton` whose description is "Allow", and presses it. Chrome is never
 * told to activate, so this does not steal focus the way opening
 * `chrome://inspect` (the cross platform half, in `packages/cli`) does.
 */
export const ALLOW_SHEET_APPLESCRIPT = `using terms from application "System Events"
    on clickAllow(nodeRef)
        try
            if (role of nodeRef as text) is "AXButton" and ¬
                (description of nodeRef as text) is "Allow" then
                perform action "AXPress" of nodeRef
                return true
            end if
        end try
        try
            repeat with childRef in UI elements of nodeRef
                if my clickAllow(childRef) then return true
            end repeat
        end try
        return false
    end clickAllow
end using terms from

set resultText to "not-found"
tell application "System Events"
    if exists process "Google Chrome" then
        tell process "Google Chrome"
            repeat with w in windows
                try
                    repeat with s in sheets of w
                        if (name of s as text) is "Allow remote debugging?" then
                            if my clickAllow(s) then
                                set resultText to "ready"
                                exit repeat
                            end if
                        end if
                    end repeat
                end try
                if resultText is "ready" then exit repeat
            end repeat
        end tell
    end if
end tell
return resultText
`;

/** Printed verbatim as an {@link AssistResult} detail when `osascript` reports it was not granted Accessibility. Names the fix, not just the symptom, matching browser-harness's own `_ACCESSIBILITY_DETAIL`. */
export const ACCESSIBILITY_DETAIL =
  'grant Accessibility to the process running "bgls" (for example Terminal, iTerm2, or the shell that launched it) in System Settings, Privacy and Security, Accessibility, then retry';

/** The one Chrome install this plugin recognizes, matching `local-browser-discovery.ts`'s own `macProfileTable` entry for the plain "chrome" label. A second Chrome-family browser (Canary, Edge, Brave) is out of scope for this plugin, the same limitation the video export reference plugin states for its own single ffmpeg search. */
export function googleChromeRoot(home: string = homedir()): string {
  return join(home, 'Library', 'Application Support', 'Google', 'Chrome');
}

/**
 * Reads Chrome's own `chrome://inspect` toggle straight from `Local
 * State`, the same field `local-browser-discovery.ts`'s
 * `readRemoteDebuggingToggle` reads on the host side. Re-implemented here,
 * not imported, because a plugin ships as a single, zero-runtime-dependency
 * bundle and does not depend on
 * `@browserglass/runtime-host`.
 *
 * `null` means "unknown" (missing or unparsable `Local State`), distinct
 * from `false` (present, parsed, explicitly off): the same distinction the
 * host side makes, kept here so a caller cannot mistake "cannot tell" for
 * "definitely not".
 */
export function isRemoteDebuggingToggleEnabled(chromeRoot: string): boolean | null {
  const path = join(chromeRoot, 'Local State');
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const devtools = raw['devtools'] as Record<string, unknown> | undefined;
    const remoteDebugging = devtools?.['remote_debugging'] as Record<string, unknown> | undefined;
    const enabled = remoteDebugging?.['user-enabled'];
    return typeof enabled === 'boolean' ? enabled : null;
  } catch {
    return null;
  }
}

/**
 * The real `argv` {@link runAllowSheetAppleScript} hands to `execFile`: no
 * shell, one literal argument (the path to a script file this process
 * wrote itself), nothing built from string concatenation. This is what
 * this package's tests assert directly, without ever spawning
 * `osascript` (see this module's own header).
 */
export function buildOsascriptArgs(scriptPath: string): readonly string[] {
  return [scriptPath];
}

/**
 * Runs {@link ALLOW_SHEET_APPLESCRIPT} through `osascript`, writing it to
 * a throwaway temp file first so the script text is never interpolated
 * into a command string. Aborts via `signal`, the same cooperative
 * cancellation `EncodeRequest`'s `encode()` takes, and a five second
 * built-in timeout, matching browser-harness's own `timeout=5` on this
 * exact call.
 *
 * NEVER EXECUTED on the machine that wrote this file; see this module's
 * header.
 */
export async function runAllowSheetAppleScript(
  signal: AbortSignal,
  execFileImpl: typeof execFileAsync = execFileAsync,
): Promise<{ readonly stdout: string; readonly stderr: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-plugin-permission-assist-'));
  const scriptPath = join(dir, 'allow-sheet.applescript');
  try {
    writeFileSync(scriptPath, ALLOW_SHEET_APPLESCRIPT, 'utf8');
    const args = buildOsascriptArgs(scriptPath);
    const { stdout, stderr } = await execFileImpl('osascript', args as string[], {
      signal,
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    return { stdout: String(stdout), stderr: String(stderr) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** browser-harness's six-outcome vocabulary for this exact choreography (`macos.py`'s own docstring), kept distinct from `@browserglass/plugin-api`'s three-word `AssistOutcome`: `src/index.ts`'s `toAssistResult` is the one place that maps between them. */
export type MacApproveStatus =
  | 'ready'
  | 'not-found'
  | 'setup-required'
  | 'accessibility-required'
  | 'unsupported'
  | 'error';

export interface MacApproveResult {
  readonly status: MacApproveStatus;
  readonly detail: string | null;
}

/** Injectable seams for {@link approveRemoteDebugging}'s tests: a fake `run` never spawns a real `osascript`, and a fake `home` never reads this machine's real `Local State`. */
export interface ApproveRemoteDebuggingDeps {
  readonly home?: string;
  readonly run?: typeof runAllowSheetAppleScript;
}

/**
 * Ported from browser-harness's `approve_remote_debugging()`. Refuses
 * immediately off macOS, refuses before touching `osascript` at all
 * unless the `chrome://inspect` toggle is already ticked for the one
 * Chrome root this plugin knows (`_google_chrome_toggle_enabled()`'s own
 * reasoning: do not attempt AppleScript against a sheet that cannot
 * exist), then runs the script and classifies its outcome, a timeout, or
 * an accessibility refusal into one of six named states.
 *
 * NEVER EXECUTED on the machine that wrote this file; see this module's
 * header. Every branch below is exercised in this package's tests through
 * `deps.run`, an injected fake; none has run against a real sheet.
 */
export async function approveRemoteDebugging(
  signal: AbortSignal,
  deps: ApproveRemoteDebuggingDeps = {},
): Promise<MacApproveResult> {
  if (process.platform !== 'darwin') {
    return {
      status: 'unsupported',
      detail: `AppleScript accessibility traversal to click Chrome's "Allow remote debugging?" sheet is macOS only; this machine is ${process.platform}`,
    };
  }

  const toggle = isRemoteDebuggingToggleEnabled(googleChromeRoot(deps.home ?? homedir()));
  if (toggle !== true) {
    return {
      status: 'setup-required',
      detail:
        'first enable "Allow remote debugging for this browser instance" at chrome://inspect/#remote-debugging, then retry',
    };
  }

  const run = deps.run ?? runAllowSheetAppleScript;
  let stdout: string;
  try {
    const result = await run(signal);
    stdout = result.stdout.trim();
  } catch (err) {
    if (signal.aborted) {
      return { status: 'accessibility-required', detail: ACCESSIBILITY_DETAIL };
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/not authorized|assistive/i.test(message)) {
      return { status: 'accessibility-required', detail: ACCESSIBILITY_DETAIL };
    }
    return { status: 'error', detail: message };
  }

  if (stdout === 'ready') {
    return { status: 'ready', detail: null };
  }
  if (stdout === 'not-found') {
    return {
      status: 'not-found',
      detail:
        'retry the attach command; the "Allow" sheet may not have appeared yet, or it was accepted while this ran',
    };
  }
  return {
    status: 'error',
    detail: `unexpected osascript result: ${stdout.length > 0 ? stdout : '<empty>'}`,
  };
}
