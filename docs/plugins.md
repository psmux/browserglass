# Plugins: optional code you install on purpose

This is the reference for one question: **what is a BrowserGlass plugin,
what can it touch, and how do you install one?** Everything below is read
from the source in this repository; the file and symbol behind each claim
is named so it can be re-derived when a later change makes it stale.

This page covers how to install one, what the two kinds do, and the
honest state of what is built versus what is still planned.

## What a plugin is

A plugin is one bundled JavaScript module with zero runtime dependencies,
fetched once by an explicit `bgls plugins add`, verified against a
recorded hash on every later use, and never fetched again on its own.
`@browserglass/plugin-api` (`packages/plugin-api/src/`) is the whole
contract: `PluginManifest` (`manifest.ts`) is what every plugin exports
regardless of kind, an `id`, a `kind`, a `hostApi` semver range, the
`platforms` it is willing to load on, a one-line `summary`, and a
`probe(): Promise<PluginProbe>` that answers "would I work right now, on
this machine, as configured" and never throws. The package has no
`dependencies` in its own `package.json` and no `node:` import anywhere
under `src/`, checked by hand for this page rather than assumed.

There are exactly two kinds, and they share no verb beyond that manifest,
because a video encoder and a macOS accessibility clicker have nothing in
common:

* **`frame-encoder`** (`packages/plugin-api/src/frame-encoder.ts`): one
  `encode(req: EncodeRequest, signal: AbortSignal): Promise<EncodeResult>`.
  `EncodeRequest` carries an absolute input directory, the frame list
  `bgls record export` already wrote, an absolute output path, and an
  optional `fps`. There is no codec string, no bitrate, no filter graph,
  and no options passthrough of any kind; the plugin chooses its own
  encoder settings.
* **`permission-assist`** (`packages/plugin-api/src/permission-assist.ts`):
  one `assist(s: AssistSituation, signal: AbortSignal): Promise<AssistResult>`.
  `AssistOutcome` is three words, `'resolved'`, `'user-action-required'`,
  `'unavailable'`, and nothing in the shape lets a plugin hand back a
  command, a script, or a path for the host to run.

A third `PluginKind` is a design document, not a pull request:
`PLUGIN_KINDS` (`packages/plugin-api/src/manifest.ts`) is a closed,
two-member array, and `isPluginKind()` checks membership against exactly
that array.

## The security argument, precisely

Every other boundary in this repository, `RequestGate`'s two-word verdict
vocabulary (`packages/core/src/interception/request-gate.ts`),
`sendInputCommand`'s allowlist (`packages/core/src/input/cdp-allowlist.ts`),
`isArgAllowed`'s deny-first launch flag check
(`packages/protocol/src/domain/arg-lists.ts`), sits at a wire seam or an
API seam and is enforced against a caller on the far side of a socket or a
function signature. A plugin is not that kind of caller. Loaded into a
process, it shares that process's heap: a plugin holding a `CdpBridge`
never has to defeat `sendInputCommand`'s allowlist, because it can call
`bridge.send` directly and reach `Fetch.fulfillRequest` or
`Runtime.evaluate` on its own. This repository's whole security posture is
about data crossing a boundary. A plugin is not data crossing a boundary,
it is code inside one, and no amount of narrowing the plugin interface
changes that once such a plugin shares an address space with a bridge.

So the answer this design settles on is not a narrower interface. It is
placement. **The gateway never loads a plugin.** `bgls serve`
(`packages/server`, `packages/core`) gains no loader, no dynamic import, no
plugin registry, and no configuration key of any kind. Plugins load only
inside `packages/cli`, a short lived tool that runs with exactly the
authority of the person who typed its name, once, and exits.

This is not a convention asked to hold by discipline. `scripts/check-deps.mjs`
walks every package's declared dependencies and built output for an import
edge that is not in its explicit allowed list
(`ALLOWED_INTERNAL_DEPS`, `check-deps.mjs:30`). `cli: null` there means
"cli may depend on everything else"; **no other package's row names
`cli`**, transcribed here from the script itself: `protocol: []`,
`core: ['protocol']`, `server: ['protocol', 'core', 'router']`,
`runtime-host: ['protocol', 'core']`, and so on through all sixteen
non-`cli` rows, none of which lists `cli`. An import of the plugin loader
from `core` or `server` therefore fails `pnpm check:deps` today, verified
by running it against this checkout:

```
$ node scripts/check-deps.mjs
check:deps passed (17 packages checked)
```

with the `'plugin-api': []` row already present and nothing added to the
script to make this true. That is a build-time guarantee, not a promise in
a document.

What a plugin is handed is, correspondingly, exhaustive. A `frame-encoder`
gets an input directory, a frame list, an output path, an optional `fps`,
and an `AbortSignal`. A `permission-assist` gets one `AssistSituation`
(a status string, a `userDataDir`, a vendor label, a `cdpUrl` or `null`,
and a `detail` string) and an `AbortSignal`. No parameter of either
interface ever carries a `CdpBridge`, a `Session`, a `ControlLease`, a
target id, or a CDP session id, because the CLI process holds none of
those at plugin load time. The honest asterisk: a plugin is ordinary
Node code with this process's full authority, so nothing stops it opening
its own socket to a gateway on localhost on its own initiative. What the
placement buys is that it gets no shortcut and no credential handed to it,
so a hostile plugin is exactly as privileged as any other program the
operator chose to run, and no more. `bgls plugins add` states this in the
same words on every install (`packages/cli/src/commands/plugins-cmd.ts`,
`PLUGIN_TRUST_NOTE`): "this plugin now runs with your account's full
authority whenever it is invoked (probe, encode, or assist): your files,
your network, your keychain prompts. It is loaded only by `bgls`, never by
`bgls serve`, and it never receives a `CdpBridge` or a CDP connection."

## Installing, listing, and removing a plugin

`bgls plugins add <source>` is the only command in this CLI that ever
fetches anything (`pluginsAddCommand`, `packages/cli/src/commands/plugins-cmd.ts`).
It accepts an npm spec pinned to an exact version, a `git+https://` URL
pinned to a full 40 character commit sha, or a local directory path; a
branch, a tag, a version range, `git+ssh://`, `git://`, and plain `http://`
are all refused before anything is fetched
(`parsePluginSource`, `packages/cli/src/plugins/fetch.ts`). It resolves the
source, fetches the entry file, hashes it with SHA-512
(`hashPluginFile`, `packages/cli/src/plugins/integrity.ts`), imports it once
to read and validate its manifest, refuses if the manifest's declared
`platforms` excludes this machine, and only then writes an entry into
`bgls-plugins.json` and copies the file under the data directory. A
refusal at any step writes nothing.

`bgls-plugins.json` lives in the data directory too:
`<data-dir>/bgls-plugins.json`, where the data directory is `--data-dir`,
then `BGLS_DATA_DIR`, then `./bgls-data`. `bgls plugins add/list/remove`,
`bgls record export --video`, `bgls attach` and `bgls doctor` all resolve
it the same way (`resolvePluginsFileForRead`,
`packages/cli/src/plugins/record.ts`). `--file` on the `plugins`
subcommands overrides the location outright. Older builds wrote it to the
current working directory; when the data directory has no record yet, a
`./bgls-plugins.json` is still read as a fallback, and the next `add` or
`remove` writes the data directory copy, which wins from then on. It is a
per machine file (a `local` source records an absolute path), so it is in
`.gitignore` and should not be committed.

`bgls plugins list` never touches the network. For every entry already
recorded, it runs the same load lifecycle a consumer would: platform gate,
hash comparison against the recorded `integrity`, `import()`, manifest
validation, `probe()` under a 3000ms deadline
(`loadPlugin`, `packages/cli/src/plugins/load.ts`), and prints the result as
one of seven named states rather than a boolean: `ready`, `unusable`,
`not-applicable`, `integrity-mismatch`, `load-failed`,
`unsupported-host-api`, `probe-failed`. `bgls plugins remove <id>` deletes
the record entry and best-effort deletes the stored file.

The hash comparison itself is worth naming precisely, because it is the
whole of what makes "verified against a digest on every load" true.
`digestsMatch()` (`packages/cli/src/plugins/integrity.ts`) compares two
`sha512-<base64>` strings with `node:crypto`'s `timingSafeEqual`, not
`===`: an ordinary string comparison returns on the first mismatched byte,
which leaks, to anyone able to measure response time, how many leading
bytes of a guess were already correct. That channel costs nothing to close
here and the module's own comment says so plainly.

## `bgls record export --video`: the frame-encoder consumer

`bgls record export <id> --out <dir>` writes a recording's frames as
standalone JPEG/PNG files plus a `manifest.json` timing sidecar; that part
is unchanged by plugins and always happens first. Adding `--video <file>`
asks `registry.encoderFor()` (`packages/cli/src/plugins/registry.ts`) for an
installed `frame-encoder`, and the result is one of ten distinguishable
outcomes, never a single collapsed "could not make a video"
(`VideoOutcome`, `packages/cli/src/commands/record.ts`): `encoded`,
`unsupported`, `encode-mismatch`, `absent`, `not-applicable`,
`integrity-mismatch`, `load-failed`, `unsupported-host-api`,
`probe-failed`, `unusable`. On every outcome but `encoded`, the command
still reports the frame export it already completed and names the exact
plugin command that would help, `bgls plugins add <spec>` on `absent`,
`bgls plugins list` on a load failure.

The reference plugin, `@browserglass/plugin-video-export`
(`plugins/plugin-video-export/`), locates a system ffmpeg the same way
`binary-discovery.ts` locates Chrome: `BGLS_FFMPEG_PATH` first, then
`which`/`where`, then fixed per-platform install paths, and it never
trusts a candidate until it can report its own version
(`resolveFfmpeg`, `plugins/plugin-video-export/src/ffmpeg.ts`). It builds an
ffmpeg `concat` demuxer list from the exact frames and `tsDeltaMs` values
`bgls record export` already wrote, then spawns ffmpeg with `execFile`
and a fixed argument array, never a shell string.

**Run end to end against ffmpeg 9.0.1 on this machine**, verified while
writing this page:

```
$ bgls plugins add <path-to-plugin-video-export>
installed "@browserglass/plugin-video-export" (frame-encoder) from local ...

$ bgls doctor --check plugins
plugins
  [PASS] plugins - 1 plugin(s) installed: @browserglass/plugin-video-export (frame-encoder): ready.
```

and, from a real recording, `bgls plugins list` reported `READY` naming
the ffmpeg it found, and `bgls record export --video` produced a 10202
byte h264 file that `ffprobe` reads as 320x240 and that decodes under
`ffmpeg -err_detect explode` without error.

That real run caught two bugs a green test suite did not. The encoder
originally emitted `-vsync vfr`, an option ffmpeg removed outright in
version 9, while its own unit test asserted that exact argument array and
stayed green throughout, because the test checked what the function meant
to emit, not what ffmpeg would accept
(`buildFfmpegArgs`'s own comment, `plugins/plugin-video-export/src/ffmpeg.ts`,
now `-fps_mode vfr`). Separately, the plugin's `package.json` had no
`main` field, so it built, its fifteen tests passed, and it still could
not be installed as a plugin at all; it now declares
`"main": "dist/plugin.mjs"`.

**Open, in the present tense:** the concat list this plugin builds emits
one duplicate frame. ffmpeg's `concat` demuxer drops the duration
attached to the last listed file unless that file is repeated once more
with no duration line after it, which is documented ffmpeg behaviour, not
a guess, and `buildConcatList` (`plugins/plugin-video-export/src/ffmpeg.ts`)
does exactly that to keep the last frame's real on-screen duration. The
side effect, observed on a real export: five input frames came out as six
at 4.08 seconds, and a re-mux warned of non-monotonic dts. The file still
plays. Frame-accurate output needs this fixed, and the fix is not yet
written.

## `bgls attach` and the permission-assist consumer

`bgls attach` (`packages/cli/src/commands/attach.ts`) is the CLI half of
the second consumer, and it is built: when `discoverLocalBrowser()`
reports `permission-blocked` or `remote-debugging-disabled`, the command
asks `assistFor()` whether a `permission-assist` plugin is installed and
ready. With none installed, the default, it behaves exactly as it always
has: the same imperative error, the same exit code. With one ready, it
opens `chrome://inspect/#remote-debugging` itself (rate limited by a
marker file's mtime, `INSPECT_REOPEN_TTL_MS`, never more than once per
180 seconds across separate invocations), calls the plugin's `assist()`
under a 15000ms deadline, and, only if the plugin reports `'resolved'`,
re-probes `discoverLocalBrowser()` before trusting it and retrying the
attach. A plugin saying it clicked Allow is never taken as proof on its
own; the re-probe is.

**What is still open here:** as of this page, `plugins/plugin-permission-assist/`
exists only as a package scaffold (`package.json`, `tsup.config.ts`, empty
`src/` and `test/` directories); it is under active construction by
another line of work as this page is written and is not yet something
`bgls plugins add` can install. The host side integration in `attach.ts`
above is real and already wired to `assistFor()`, but with nothing built
to load, `bgls attach` on a permission-blocked candidate today prints the
same message it always did. The macOS half of this feature, an AppleScript
walking `System Events` to press Chrome's own "Allow remote debugging?"
sheet, is designed to run on a machine that has never run it against a
real Chrome permission prompt, since the machine writing it runs Windows.
Until it has, "resolved" for this plugin kind is an untested code path,
not a demonstrated one.

## `bgls doctor`'s `plugins` check

`bgls doctor` runs a `plugins` check (`checkPlugins`,
`packages/cli/src/doctor/checks.ts`) alongside its existing environment,
browser, store, profiles, packages, network, and invariants groups. It
reads `bgls-plugins.json` and, for every recorded entry, runs the same
load lifecycle `bgls plugins list` does, so `bgls doctor` and `bgls
plugins list` never disagree about whether a given plugin is usable right
now.

No `bgls-plugins.json` at all is the normal, default state and reports
`PASS`: plugins are optional, and nothing is fetched unless an operator
explicitly ran `bgls plugins add`. A record that exists but fails to parse
or fails shape validation is `FAIL`, the same "broken install, a human can
act on it directly" verdict `packages` already gives a version mismatch
across the fixed changesets group. Among installed entries,
`integrity-mismatch` (a plugin's file no longer matches the hash recorded
at install time) and `load-failed` escalate the whole check to `FAIL`;
`unusable`, `probe-failed`, and `unsupported-host-api` report `WARN`,
correctly recorded and verified, just not usable right now; `ready` and
`not-applicable` are never a degradation on their own, a shared
`bgls-plugins.json` naming a plugin for a platform this machine is not is
reported as inapplicable, not hidden and not an error. Verified against a
real install on this machine:

```
$ bgls doctor --check plugins
plugins
  [PASS] plugins - 1 plugin(s) installed: @browserglass/plugin-video-export (frame-encoder): ready.
```

## Gaps

Stated in the present tense, so nobody has to discover them by surprise.

**`bgls plugins verify` does not exist.** Several source comments in
`packages/cli/src/plugins/` describe it as the command that re-hashes
every recorded plugin on demand, and this page's own error messages for a
load failure point an operator at it. It is not implemented yet: today, the only
way to re-verify a plugin is to reinstall it with `bgls plugins add`,
or to let `bgls plugins list` / `bgls doctor` report the mismatch on their
own read-only pass.

**The interactive install confirmation is not built.** `bgls plugins add` prints the source, the hash, the platforms,
and the trust note after it installs, but it does not yet print that block
and pause for a `y/N` before writing anything; `--yes` has nothing to skip.

**The video encoder duplicates one frame on every export.** See above:
`buildConcatList`'s last-frame repeat is deliberate ffmpeg concat-demuxer
behaviour, and its side effect, one extra frame near the end of the
output, is not.

**No `permission-assist` plugin exists to install yet, and none has ever
run against a real Chrome permission prompt.** The host side (`bgls
attach`, `assistFor()`, the re-probe-before-trust rule) is built and
covered by fixture-based tests. `plugins/plugin-permission-assist/` is
present only as a package scaffold as this page is written; the plugin
that would actually press "Allow" on macOS has not landed in this
repository yet.
