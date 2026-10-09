# `@browserglass/cli`

`bgls`: run a BrowserGlass gateway, and drive the browsers it opens, from
any language that can shell out and parse JSON. `bgls serve` starts the
gateway; `bgls instances *` and `bgls swarm run` open, navigate, click,
type into, screenshot, and read the console/network of the browsers it
manages, over `@browserglass/automation`'s `AutomationClient`, the same
Viewer connection a human's `@browserglass/client` uses. There is no
separate "automation API": every driving command here is a CLI wrapper
around a real `bgls.v1` session.

## The `--json` contract

Every command accepts `--json`. In `--json` mode:

- Stdout carries exactly one JSON object per invocation (or, for the two
  streaming commands, `instances console --follow` and `instances network
  --follow`, one JSON object per line: JSON Lines, not a JSON array).
- Every human-readable line (progress, diagnostics, success/info
  messages) is suppressed entirely, not merely redirected.
- An error is still printed, but always to stderr, never stdout, so a
  failed call never hands a caller malformed JSON to parse.

This means `bgls <command> --json` is safe to pipe straight into `jq`, or
into any language's own JSON parser via a subprocess call, without ever
scraping human-formatted text.

## Exit codes

`bgls` exits with one of seven documented codes (`src/util/exit.ts`), so a
script can branch on more than "it failed somehow":

| Code | Name               | Meaning                                                                 |
| ---- | ------------------ | ------------------------------------------------------------------------ |
| 0    | `ok`                | Success.                                                                |
| 1    | `operationalFailure`| Something failed that doesn't fit a more specific code below.          |
| 2    | `usageError`        | Bad flags, missing required arguments, or no gateway could be resolved.|
| 3    | `preconditionFailed`| A precondition wasn't met, e.g. `instances create` never reached `ready` within its poll window. |
| 4    | `notFound`          | The instance or target named on the command line doesn't exist.        |
| 5    | `policyDenied`      | The token minted for this call was narrowed below what the action needs, or another viewer holds the lease. |
| 6    | `timeout`           | Connecting to the instance, or the action itself, never got a reply in time. |

## Getting a token: `bgls token`

The REST examples in the root README and in `docs/quickstart.md` send
`authorization: Bearer $ADMIN_TOKEN`. This is where that value comes
from. Start a gateway, then ask the same directory for a token:

```sh
pnpm bgls serve --listen 127.0.0.1:7799 &
export ADMIN_TOKEN=$(pnpm bgls token)

curl -X POST http://127.0.0.1:7799/browserglass/v1/instances \
  -H "authorization: Bearer $ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"requestId":"demo-1","browser":{"headless":"new"}}'
```

Plain output is the bare token on stdout and nothing else, so command
substitution captures the token and only the token. The endpoint it
resolved against and the expiry go to stderr, where they cannot corrupt a
pipe. `--quiet` drops that note.

`--json` gives a script the URL along with the token:

```sh
pnpm bgls token --json
{"token":"eyJhbGciOi...","endpoint":"http://127.0.0.1:7799",
 "basePath":"/browserglass","wsUrl":"ws://127.0.0.1:7799/browserglass/socket",
 "expiresAt":1788009542}
```

`expiresAt` is epoch seconds, read from the token's own `exp` claim. It is
`null` when you supplied the token yourself with `--token`, since an
operator supplied token need not be a JWT.

The token resolves exactly the way every other command's does:
`--endpoint`/`--token` and their `BGLS_*` env vars win, and otherwise the
`dev-session.json` that `bgls serve` wrote in this directory supplies the
endpoint and the dev signing key, and the token is minted locally from it
with no network round trip. No dev session and no `--endpoint` is a usage
error, exit `2`.

The default lifetime is 600 seconds. `--ttl` changes it, up to the 900
second cap the gateway enforces; anything larger is rejected rather than
quietly clamped. Do not go below 300: the gateway replay checks any token
whose own lifetime is 300 seconds or less, so a shorter token is good for
exactly one request and the second answers `E_TOKEN_REPLAYED`. The command
warns on stderr when you ask for one.

## Quick start: open 3 browsers, drive them all, read their consoles, close them

This is a real, runnable shell script, not aspirational: every line below
was executed against a real `bgls serve` and real headless Chrome while
writing this file. Run it from the repository root, using `pnpm bgls`:
a bare `bgls` is only on PATH once something in the workspace depends on
`@browserglass/cli`, which is what the root `package.json` now does (see
[`docs/quickstart.md`](../../docs/quickstart.md)). On Windows, also run it
from a short path (Chrome's `--user-data-dir` has a real length limit);
`cd /c/bgls-demo` or similar works well.

```sh
# 1. Start the gateway in the background. It writes ./bgls-data/dev-session.json,
#    which every bgls command below auto-discovers, so no --endpoint/--token
#    flags are needed as long as you run from this same directory.
pnpm bgls serve --json > serve.log 2>&1 &
SERVE_PID=$!

# Wait for it to actually accept connections rather than a fixed sleep:
# opening the store, discovering Chrome, and registering the default pool
# is a cold start and its timing varies by machine.
for i in $(seq 1 40); do
  pnpm bgls instances list --json > /dev/null 2>&1 && break
  sleep 0.5
done

# 2. Open 3 browsers at once. Each is a separate bgls process; backgrounding
#    them with & and waiting on their specific PIDs (not a bare "wait",
#    which would also wait on the gateway process above) is what makes
#    this concurrent, not bgls itself doing anything special here (that's
#    what "bgls swarm run" is for, see below, if you want one command to
#    do the fan-out).
pnpm bgls instances create --json --headless > c1.json & p1=$!
pnpm bgls instances create --json --headless > c2.json & p2=$!
pnpm bgls instances create --json --headless > c3.json & p3=$!
wait $p1 $p2 $p3

# Pull instanceId out of each result. Any language's JSON parser works
# here; this uses "node -e" since Node is already a hard dependency of
# this project, but "jq -r .instanceId c1.json" is the equivalent one-liner
# if you have jq installed.
I1=$(node -e "console.log(JSON.parse(require('fs').readFileSync('c1.json','utf8')).instanceId)")
I2=$(node -e "console.log(JSON.parse(require('fs').readFileSync('c2.json','utf8')).instanceId)")
I3=$(node -e "console.log(JSON.parse(require('fs').readFileSync('c3.json','utf8')).instanceId)")

# 3. Navigate all 3 at once.
pnpm bgls instances navigate "$I1" --url https://example.com/ --json > n1.json & p1=$!
pnpm bgls instances navigate "$I2" --url https://example.org/ --json > n2.json & p2=$!
pnpm bgls instances navigate "$I3" --url https://example.net/ --json > n3.json & p3=$!
wait $p1 $p2 $p3

# 4. Read each one's console (collects for 2s, or use --follow to stream
#    JSON Lines indefinitely).
pnpm bgls instances console "$I1" --json
pnpm bgls instances console "$I2" --json
pnpm bgls instances console "$I3" --json

# 5. Close all 3.
pnpm bgls instances release "$I1" --json
pnpm bgls instances release "$I2" --json
pnpm bgls instances release "$I3" --json

kill "$SERVE_PID" 2>/dev/null # stop the gateway
```

`bgls instances navigate` prints a `StatusResult`:

```json
{"targetId":"tgt_01M0...","url":"https://example.com/","title":"Example Domain","loading":true,"canGoBack":true,"canGoForward":false,"leaseHolderViewerId":"vwr_01M0...","leaseHolderLabel":null}
```

`bgls instances console` (no `--follow`) prints whatever it collected in
its 2s window:

```json
{"instanceId":"inst_01M0...","targetId":"tgt_01M0...","entries":[{"type":"console","entry":{"targetId":"tgt_01M0...","level":"error","text":"..."}}]}
```

### The same thing in one command: `bgls swarm run`

If you don't need per-instance control, `swarm run` opens N instances,
runs one action across all of them concurrently, and releases them
afterward (unless `--keep`), in a single invocation:

```sh
pnpm bgls swarm run --size 3 --action navigate --value https://example.com/ --headless --json
```

```json
{"size":3,"action":"navigate","results":[{"index":0,"instanceId":"inst_...","targetId":"tgt_...","ok":true,"value":{"url":"https://example.com/", "...": "..."}},{"index":1,"...":"..."},{"index":2,"...":"..."}]}
```

`--action` is one of `navigate` (needs `--value <url>`), `click` (needs
`--x`/`--y`), `type` (needs `--value <text>`), `screenshot` (optionally
`--out-dir` to save each member's PNG instead of inlining base64
`data`), or `status`.

## Reusing your browsers instead of launching new ones

Every command above launches a new browser. Run the `swarm run` example
twice and you have opened six Chromes, not three. That is the default, and
it is deliberate: two unrelated runs of a script must not fight over one
set of browsers.

`--sticky-subject` is how you ask for the other behaviour. Give it a value
naming the OWNER of the browsers, a user id, a tenant, a job name, and the
next run reattaches to what that owner already has, launching only what is
missing:

```sh
# First run launches a browser. Every later run gets the same one back.
pnpm bgls instances create --sticky-subject user:42 --sticky-within-ms 900000

# What does that owner already have running?
pnpm bgls instances list --subject user:42

# Five browsers that survive between runs of this script, not five more each time.
pnpm bgls swarm run --size 5 --sticky-subject nightly-crawler   --action navigate --value https://example.com/
```

Two details worth knowing before you rely on it:

* Each swarm member acquires under its own slot subject
  (`nightly-crawler#0` through `nightly-crawler#4`), because the router
  resolves one subject to at most one browser and five requests sharing a
  subject would collapse onto it. The CLI derives those for you.
* `--sticky-subject` flips `swarm run`'s teardown default. Without it,
  every acquired instance is released at the end. With it, they are kept,
  since releasing browsers you just claimed ownership of would make the
  next run relaunch them. Pass `--no-keep` to release anyway.

`bgls instances release` reports which of three things happened
(`terminated`, `detached` because other viewers remain, or
`already_released`) and takes `--force` to end a shared browser regardless.

The full model, and what this same concept looks like over REST, MCP, and
the embed widget, is in [`docs/ownership.md`](../../docs/ownership.md).

## Driving the Chrome you already have open: `bgls attach`

BrowserGlass's whole premise is driving the Chrome a human already has
open, with their logins and sessions already in it, not a fresh browser
this tool launched. `bgls attach` finds one and attaches to it, composing
`@browserglass/runtime-host`'s local discovery
(`discoverLocalBrowser()`) with a real `HostRuntime.attach()` call.

`--list` scans every candidate profile this platform knows about (the
default profile for Chrome, Chrome Canary/Beta/Dev, Chromium, Edge and its
channels, and Brave) and reports each one's status without attaching to
anything, because "nothing found" is a far worse answer than "Chrome is
running on your Default profile but remote debugging is off." Real output
from this exact command, this machine, no Chrome running with remote
debugging on at the time:

```
$ pnpm bgls attach --list
ℹ   [NOT-RUNNING] chrome  C:\Users\...\Local\Google\Chrome\User Data
ℹ          no chrome process is using C:\Users\...\Local\Google\Chrome\User Data
...
ℹ 10 candidate profiles checked, 0 live.
```

Without `--list`, `bgls attach` attaches to the first live candidate it
finds (CDP identity confirmed, a real pid resolved) and then immediately
detaches again, since this command is a one-shot probe, not a supervisor:
it leaves the human's browser exactly as it found it, whether the attach
succeeded or failed. Every discovery outcome (`live`,
`permission-blocked`, `remote-debugging-disabled`, `stale-port-file`,
`not-running`) reaches you with the specific, actionable detail text
discovery wrote for it, not a generic connection error.

A browser this process did not launch gives you no control over channel,
headless mode, launch args, profile, extensions, or proxy: those were
whatever the human already had running, and every attached result says so
in plain text. Opening `chrome://inspect` or clicking Chrome's own "Allow
remote debugging" popup for the human is out of scope; `bgls attach`
detects and reports what is already enabled, it does not perform that
choreography.

## Command surface

Real (drive a browser or a gateway; every mutating one supports
`--dry-run`):

- `bgls serve` / `bgls doctor` / `bgls inspect` / `bgls config show` / `bgls token`
- `bgls attach [--list]`
- `bgls instances list [--subject]` / `describe` / `create [--sticky-subject]` / `release [--force]` / `targets` /
  `open-target` / `close-target` / `navigate` / `click` / `type` /
  `screenshot` / `console [--follow]` / `network [--follow]`
- `bgls swarm run [--sticky-subject]`
- `bgls record start <instanceId> [--target] [--mode live|thumbnail]` /
  `stop <instanceId> <recordingId>` / `list [--dir]` / `export [--dir] [--out]`

`bgls record start` and `stop` talk to a running gateway and need a token
carrying both the capture and download capabilities. `bgls record list`
and `export` read a finished recording back off disk
(`packages/cli/src/commands/record.ts`). See
[`docs/recording.md`](../../docs/recording.md) for the full picture, including why `bgls record replay` is deliberately left
a stub rather than a half-built video player.

Stub (registered, discoverable via `--help`, exits `1` with a clear
message naming what's missing): everything else, including `bgls
instances kill`, whose own documented promise ("skip graceful shutdown")
isn't something the one REST release route this build exposes can
actually deliver (see that command's own `--help` for why), and `bgls
record replay`. The documented `bgls token mint|verify|decode|revoke`
group is not among them: `bgls token` is a real leaf command instead,
because `citty` reads the first non-flag argument as a sub-command name,
and a group would make `bgls token --ttl 900` fail with ``Unknown command
`900` ``.

## Why some commands go over REST and others over the `bgls.v1` socket

`bgls instances list/describe/create/release` call the gateway's real
REST routes (`packages/server/src/rest/router.ts`'s `LIVE` table). Target
lifecycle and coordinate-level driving (`targets`, `open-target`,
`close-target`, `navigate`, `click`, `type`, `screenshot`, `console`,
`network`) have no REST route yet in this build (`STUB_PATHS`), so those
commands connect an `AutomationClient` instead: a bearer token minted
through the one working, separate auth path (`POST /v1/tokens`), then the
same `bgls.v1` Viewer connection a human's browser tab uses. Nothing here
is a back door; see `@browserglass/automation`'s own README and
`PARALLELISM.md` for the wire-level contract underneath these commands.

## Development

```sh
pnpm --filter @browserglass/cli build
pnpm --filter @browserglass/cli typecheck
pnpm --filter @browserglass/cli test
```
