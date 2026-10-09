# Session recording

This is the reference for one question: **can I get a durable video of a
session, and how far does that reach today?**

The answer changed while this page existed, which is worth noting because
this page predicted it would. It used to say the gateway could record but
nothing above the wire could start one, with no client method, no MCP tool,
and `bgls record` printing "not implemented". All of that is now false.
`AutomationClient.startRecording`, `stopRecording` and `listRecordings`
exist, the `bg_recording` MCP tool exposes the same three actions,
`bgls record start` and `stop` drive a running gateway through that same
client, and `bgls record list` and `export` read the on disk layout
directly. Only `bgls record replay` is still a deliberate stub, because
painting a frame timeline needs a viewer a terminal does not have.

A video is now reachable too, through an optional plugin rather than a
dependency in the default install. `bgls record export --video` asks the
plugin registry for a frame encoder. See `docs/plugins.md`.

Everything below is read from the source in this repository; the file and
symbol behind each claim is named so it can be re-derived when a later
change makes it stale, which is exactly what happened here.

## What is actually built

`recording.start`, `recording.stop`, and `recording.list`
(`packages/protocol/src/wire/messages/recording.ts`) are real, handled
wire messages (`packages/server/src/ws/connection.ts`), backed by
`FrameRecorder` (`packages/core/src/recording/frame-recorder.ts`) and
`DiskRecordingSink` (`packages/server/src/recording/disk-recording-sink.ts`).
Sent over a `bgls.v1` socket directly, they work today:

```jsonc
// C to S
{ "v": 1, "t": "recording.start", "id": "req_1", "ts": 0, "targetId": "tgt_abc123" }
// S to C
{ "t": "recording.started", "recordingId": "rec_...", "targetId": "tgt_abc123", "mode": "live", "startedAtMs": 1234 }
```

`recording.stop` (idempotent: a second stop for an already-stopped id
returns the same summary rather than erroring) reports `framesWritten` and
`failed`; `recording.list`, optionally scoped to one `targetId`, reports
every recording on the session as a `RecordingSummary`. A recording writes
to `<recordings.dir>/<recordingId>/` on the machine driving Chrome:
`meta.json` once, `index.jsonl` (one `RecordedFrameEntry` per line,
append-only), one `frames/<n>.bin` file per frame, and `complete.json`
once, at stop (`DiskRecordingSink`'s own module doc). `recordings.dir`
resolves to a per-process directory under the system temp dir when an
operator sets nothing (`packages/server/src/config/resolve.ts`), the same
default `downloads.dir` uses, so a stock `bgls serve` can record with no
extra configuration; only a token that already carries the two
capabilities below can reach it.

## Why it needs `capture` AND `download` together

Neither capability alone is honest about what this grants
(`recording.ts`'s own module doc, `packages/server/src/wire
/capability-check.ts`'s `recording.*` entries). `target.capture` and
`page.pdf.get` are gated on `capture` alone because they hand back a
MOMENTARY render, gone once the reply is sent, nothing left on disk.
`recording.start` produces the opposite thing: a file that outlives the
socket, the viewer, and the session itself, and that is exactly the
authority `download` already gates, extracting bytes that leave the live
session as a retrievable artifact. So every `recording.*` message requires
`capture` (the render-visibility half) and `download` (the
durable-artifact half) together, checked as a base capability plus a
second, handler-level check in `connection.ts`, because the shared
parameter-dependent-capability mechanism selects rules by base capability
rather than by message name and a `capture`-keyed rule would also have
reached `target.capture`/`page.pdf.get`, which must not gain a `download`
requirement they never had.

A recorder is registered as a synthetic, `agent`-kind viewer
(`recorder:<recordingId>`) on the target's own `Session.subscribe()` path,
which is what keeps the target's CDP screencast alive for the life of the
recording even with zero human viewers watching. "A recording that stops
the moment the last human closes their tab is not a recording"
(`frame-recorder.ts`'s own module doc). Every meta object is redacted
twice before it reaches disk: once by `FrameRecorder`, once more by
`DiskRecordingSink` immediately before serialising, belt and braces over
what the first pass already did, because a recording of a logged-in
browser is a far more dangerous artifact than a live stream nobody stores
(`packages/core/src/recording/redact.ts`'s own module doc makes the
identical argument).

## No video muxing in the gateway

On disk a recording is frames plus a sidecar index, never a `.mp4` or a
`.webm`. `packages/core` has no `ffmpeg` dependency anywhere, on purpose.
Turning frames into a video happens after the fact, on the machine running
`bgls`, through `bgls record export --video` and an installed frame
encoder plugin (below). `RecordedFrameEntry.intent` is reserved on the wire
for a future action-sampled sidecar (browser-harness's own recorder anchors
each frame to the driving call that produced it) but nothing populates it
yet.

## Starting and stopping one

From code, with a token that carries `capture` and `download`:

```ts
const rec = await client.startRecording();          // { recordingId, targetId, mode, startedAtMs }
// ... drive the page ...
const done = await client.stopRecording(rec.recordingId); // { framesWritten, failed, ... }
const live = await client.listRecordings();          // what this socket knows about
```

(`AutomationClient.startRecording`, `stopRecording`, `listRecordings` in
`packages/automation/src/client/AutomationClient.ts`.) Over MCP the same
three calls are `bg_recording` with `action: 'start' | 'stop' | 'list'`.

From a terminal, against a gateway `bgls serve` started from the same
directory (or with `--endpoint`/`--token`):

```
bgls record start <instanceId> [--target <targetId>] [--mode live|thumbnail]
bgls record stop <instanceId> <recordingId>
```

(`recordStartCommand`/`recordStopCommand`, `packages/cli/src/commands
/record.ts`.) None of these return the frames. They are written to the
gateway's own disk, under its recordings directory, and read back with
`bgls record list`/`export`.

## Reading a finished recording back: `bgls record`

`bgls record list` and `bgls record export` (`packages/cli/src/commands
/record.ts`) are real, and read the on-disk layout above directly rather
than asking a live socket: `recording.list` only knows what one session's
socket is still aware of, an in-memory view that forgets everything the
moment the socket closes, and the whole point of `complete.json`'s
presence or absence is answering "did this recording finish cleanly"
after the session that made it is long gone, which no live socket can
answer either. Real output from this exact command, this machine, no
recordings made yet:

```
$ pnpm bgls record list --json
{"root":"...\\bgls-data\\recordings","recordings":[]}
```

`--dir` (or `BGLS_RECORDING_DIR`, the same environment variable the server
itself reads) must point at the same directory a `bgls serve
--recordings-dir` used; the command has no way to guess a gateway's
private, per-process default, so start the gateway with
`--recordings-dir` (for example `<data-dir>/recordings`) when you want to
read recordings back after it exits.

`bgls record export <recordingId> --out <dir>` writes each frame as a real
`.jpg` or `.png` file plus a `manifest.json` timing sidecar
(`seq`/`gen`/`sidEpoch`/`tsDeltaMs` per frame). The recorder stores every
frame with its 20 byte `bgls.v1` binary header still in front of the image;
export strips that header (`imageBytesOf`) and then picks the extension
from the image's own magic number. Older builds skipped the strip and
wrote `.bin` files that no image viewer or ffmpeg would open, so a
recording exported before that fix is worth exporting again.

`bgls record export --video <file.mp4>` goes one step further and hands
those image files to an installed `frame-encoder` plugin, the reference one
being `plugins/plugin-video-export`, which drives a system ffmpeg. Without
a plugin it says so and still leaves the exported frames behind. See
`docs/plugins.md` for installing one.

`bgls record replay` is deliberately left as an honest stub rather than a
half-built one: playing frames back on a timeline needs a decoding,
painting viewer, which a terminal tool does not have, and its own error
points at `export` as the real answer.

## What is still not built

**`bgls record replay`.** A stub, for the reason above.

**Reading a recording back over the wire.** No message returns a
recording's frames to a client. `listRecordings()` and `bg_recording`'s
`list` report only what the current socket knows about, and forget it when
the socket closes. Getting the frames means `bgls record export` on a
machine that can read the gateway's recordings directory.

**Video inside the default install.** Encoding needs the optional plugin
and a system ffmpeg; nothing in the published packages produces a video
on its own.
