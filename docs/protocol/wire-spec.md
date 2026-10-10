# The `bgls.v1` wire protocol

This document is for someone who has never seen this repository and wants to write a BrowserGlass client in a language that is not TypeScript, without reading `packages/protocol/src`. Everything here was read directly out of that package's source and out of `packages/server/src`'s actual runtime behaviour, not guessed. Where a claim depends on this build's current implementation rather than on the protocol as such, it says so, because a stale claim is worse than a short document.

Two companion artifacts live beside this one:

* `packages/conformance/src/protocol/` has the golden vectors: byte level fixtures for the binary frame header, and one canonical example JSON envelope per message type. Assert your own encoder and decoder against these, not just against this prose.
* `packages/conformance/src/protocol/schema/wire-messages.schema.json` is JSON Schema for the JSON message catalogue, generated from the TypeScript source (see that file's own `description` field for how, and `packages/conformance/scripts/generate-wire-schema.mjs` for the generator). Validate messages you send and receive against it while you build.

## Two things you will get wrong if you only skim this

1. **A correlated reply is sent before any broadcast the same request triggers.** If your `nav.goto` also causes the server to broadcast `nav.state` to every viewer of that session, the reply carrying `re` equal to your request's `id` arrives first, and the broadcast (which carries no `re`) follows. Do not assume the first `nav.state` you see after sending `nav.goto` is the broadcast; check `re` before you decide what a message answers. `packages/server/src/ws/connection.ts`'s `doSubscribe()` states this ordering explicitly in its own comment: "Strictly after the reply... never ahead of the correlated reply to the request that caused it."
2. **You must send `ack` for every binary frame you receive, on that frame's `streamId`, or the server stops sending you frames on that stream.** The server will not close your connection or send an error: it silently stops once `maxBacklog` (3, `DEFAULT_LIMITS.maxBacklog` in `packages/protocol/src/wire/limits.ts`) frames are outstanding unacked on a stream, and nothing but an `ack` drains that backlog. A client that decodes frames but forgets to ack them will see three frames arrive and then nothing, forever, on that one stream, with no diagnostic of any kind. See the "Binary frames" section below for the exact rule.

## Transport and handshake

Connect a WebSocket to the server's configured path, default `/browserglass/socket` under the server's `basePath` (default `/browserglass`; both are configurable). Offer the subprotocol `bgls.v1` in `Sec-WebSocket-Protocol`. Two things can fail the HTTP upgrade itself, before any WebSocket exists:

* The request's `Origin` header names a different host than the one the connection was actually dialed on, AND it is not in the server's configured allow list: `403 Forbidden`, naming the offending origin and the config key to set. Skipped entirely for a request with no `Origin` header at all (every non-browser client: the CLI, MCP, the Python client, any server-to-server automation client), for one whose `Origin` matches the request's own `Host` (a page served by this same gateway, connecting to its own origin, needs no configuration), and for every origin when `allowedOrigins` is the literal `*`. `security.allowedOrigins` defaults to nothing allowed, so a genuinely cross origin browser page has to be added explicitly (`packages/server/src/ws/origin-check.ts`).
* `bgls.v1` is not among the offered subprotocols: `400 Bad Request`.

Everything else, including every kind of bad credential, completes the WebSocket handshake and then fails inside the `bgls.v1` message loop with an `error` message followed by a close, never an HTTP level failure. This is deliberate (`packages/server/src/index.ts`'s `handleUpgrade` calls it out in its own comment), so a client should always expect to reach an open socket and should not treat a successful upgrade as proof of a valid credential.

Once the socket is open, the client sends `hello` first, always. The server accepts nothing else as the first message; anything other than `hello`, or a `hello` that never arrives within 5 seconds, closes the socket with `4202 MissingParams`. The server answers a valid `hello` with `welcome`, and `welcome` is never sent at any other time (a reauth `hello`, described below, gets a second `welcome`, but a reauth is still a `hello`). The client may send further messages immediately after `hello`, without waiting for `welcome`; the server buffers up to `4 * maxControlMsgBytes` of them and replays that buffer once the handshake resolves, dropping anything past that cap silently rather than closing the socket for it.

## Authentication

A client presents credentials on exactly one of four carriers, checked in this precedence: an `Authorization: Bearer <token>` HTTP header, a `bgls.token.<jwt>` entry in the offered `Sec-WebSocket-Protocol` list, a `?ticket=<opaque>` query parameter on the connection URL, or `hello.auth.token` (`{ scheme: 'bearer', token: '<jwt>' }`) inside the `hello` message itself. Presenting a ticket together with any of the three JWT carriers is a conflict; presenting two different JWT carriers with different literal values is also a conflict. Either conflict, or presenting nothing at all, closes with `4200 InvalidAuth` after the socket is already open, carrying an `error` message first (`bgls.error.auth.conflicting_credentials` or `bgls.error.auth.no_credential`) and then `goodbye`.

A ticket is short lived, single use, and origin bound: format `tkt_<ULID>.<base64url random>`, minted by the server's own token issuing surface, not a JWT. A bearer token is a JWT with header `typ: bgls+jwt` (never plain `JWT`; that header value is itself part of what verification checks) and the claim set `packages/protocol/src/wire/auth.ts`'s `BglsClaims` documents: `aid` (issuing App), `tid` (tenant), `sub` (the acting party, opaque to BrowserGlass), `caps` (1 to 19 entries from the capability enum below, sorted, no duplicates), `scope` (what the token may attach to: tenant, pool, instance, or stream), `exp` (at most 900 seconds after `iat`, regardless of what was requested), and `jti` (replay detection).

A `hello` with `reauth: true` on an already live connection re-runs credential resolution against a fresh token and answers with a new `welcome`; this is the only way to refresh a token over an open socket (there is no separate `auth.refresh` message). If the new token's capability set is a strict subset of the old one, the server also broadcasts `capabilities.updated` and applies whatever revocations the shrink implies (see the message catalogue below).

## Envelope and correlation

Every JSON message, both directions, is one flat object:

```json
{
  "v": 1,
  "t": "target.list",
  "id": "req_0001",
  "re": "req_0001",
  "sid": "sess_...",
  "vid": "vwr_...",
  "sq": 42,
  "ts": 1732104000000
}
```

`v` is always `1` in this build. `t` is the message type, lowercase, dot separated, group first (`stream.subscribe`, not `subscribeStream`). `id` is a client generated, opaque correlation id, at most 64 characters, set on a request the client wants a matching reply for. `re` echoes that `id` back on the direct reply; a broadcast triggered by the same request never carries `re`, only the correlated reply does. `sid` and `vid` are set by the server on messages describing a specific session or viewer; a client never needs to set them. `sq` is server to client only: every single envelope the server sends through its normal send path (`Connection.sendEnvelope` in `packages/server/src/ws/connection.ts`) gets the connection's next sequence number, monotonic from 1, gapless, starting with `welcome` itself at `sq: 1`; not just the messages that document an `sq` field. A client must never set `sq`; the server ignores it if present. `ts` is the sender's wall clock at send time in Unix milliseconds, advisory only (`welcome.serverTime` is what you use for clock skew estimation, never message ordering). Every payload field beyond these eight is spread directly at the top level of the same object, never nested under a `payload` key, and a payload field name must never collide with `v`, `t`, `id`, `re`, `sid`, `vid`, `sq`, or `ts`.

A client must silently ignore any envelope whose `t` it does not recognise, rather than erroring or closing the connection; the server does the same for a `t` it does not recognise from the client, replying with a non-fatal `bgls.error.protocol.unknown_type` rather than closing. New message types can appear in future protocol versions or app specific extensions without breaking an older client, as long as both sides honour this rule.

## Binary frames

Screencast frames, and a small number of other binary payload kinds, travel as raw WebSocket binary messages, never base64 inside JSON, unless the client declared `hello.capabilities.binaryFrames: false` (which forces a JSON fallback path this document does not otherwise cover). Every binary message starts with a fixed 20 byte header, all multi-byte fields little endian:

| Offset | Bytes | Field | Notes |
|---|---|---|---|
| 0 | 1 | magic byte 0 | always `0x42` (`'B'`) |
| 1 | 1 | magic byte 1 | always `0x47` (`'G'`) |
| 2 | 1 | version | `1` in this build |
| 3 | 1 | msgType | see table below |
| 4 | 2 | streamId | `u16`; `0` means session scoped, otherwise the numeric handle `stream.subscribed.streamId` assigned |
| 6 | 4 | seq | `u32`; per stream, starts at 1, wraps at 2^32 |
| 10 | 4 | tsDeltaMs | `u32`; milliseconds since this stream's `sidEpoch` base |
| 14 | 1 | payloadCodec | see table below |
| 15 | 1 | flags | bitfield, see table below |
| 16 | 2 | gen16 | `u16`; low 16 bits of the target generation this payload was produced against |
| 18 | 2 | reserved | always `0x0000` on send; a receiver ignores it on receipt, never rejects a nonzero value here |

Payload bytes, if any, follow immediately at offset 20.

`msgType` values: `0x01` FRAME (an encoded image or video frame, server to client), `0x02` AUDIO (reserved for a future version; a v1 receiver must ignore it if seen), `0x03` UPLOAD_CHUNK (client to server; `streamId` is `0`, `seq` is the zero based chunk index, payload is a 16 byte raw upload id followed by the chunk bytes), `0x04` DOWNLOAD_CHUNK (reserved for a future in band small file delivery path), `0x05` CURSOR_BITMAP (server to client, a custom cursor image from the remote page). `0x06` through `0x7F` are reserved for future protocol use; `0x80` through `0xFF` are reserved for a host application's own private binary message kinds. A receiver must decode an unrecognised `msgType` without throwing and without closing the socket, the binary path's equivalent of the JSON `t` tolerance rule above; `packages/conformance/src/protocol/binary-vectors.ts`'s `reserved-msgtype-unknown-but-valid` and `app-private-msgtype-unknown-but-valid` vectors are exactly this case.

`payloadCodec` values: `0x00` NONE (meaning depends on `msgType`; this is what `UPLOAD_CHUNK` uses), `0x01` JPEG (the floor codec, this build's default), `0x02` WEBP, `0x03` AVIF (an optional server build flag), `0x04` PNG, `0x10` H264, `0x11` VP9, `0x12` AV1 (roadmap; H264, VP9, and AV1 are typed but this build's screencast pipeline only actually emits JPEG).

`flags` bits: `0x01` KEYFRAME (self contained; always set for an image codec, marks an IDR for a video codec), `0x02` THUMBNAIL (a reduced size preview for an unfocused target, tab strip use only), `0x04` PARTIAL (a fragment; more fragments follow carrying the same `seq`), `0x08` FINAL (the last fragment of this `seq`; an unfragmented frame has this set and `PARTIAL` clear), `0x10` SYNTHETIC (produced by an explicit `target.capture` rather than the live screencast), `0x20` DPR_SCALED (the encoder downscaled below the target's device pixel size), `0x40` ALPHA (the payload carries an alpha channel; WebP or PNG only), `0x80` EXT (the payload begins with a 2 byte little endian extension length, then that many bytes of extension data, then the codec payload; no message this build ships actually sets this bit, so there is no worked example to point at beyond the bit's own definition).

The very first frame delivered on a fresh `stream.subscribe`, and the first frame after an explicit `keyframe.request`, and the first frame after a `stream.quality` reconfiguration (which also re-emits `stream.subscribed` with a bumped `sidEpoch`), always carries `KEYFRAME`. A client can rely on this to start decoding without first requesting a keyframe itself.

**The ack rule, stated precisely.** For every binary frame your client receives, send `{ "t": "ack", "streamId": <that frame's streamId>, "seq": <that frame's seq> }`. `seq` on an `ack` is cumulative: send the highest contiguous `seq` you have fully processed, not one ack per frame necessarily, though one per frame is always correct and simplest. The server's per attachment backpressure gate (`Attachment.maxBacklog`, `packages/core/src/stream/attachment.ts`, default 3) stops sending new frames on a stream once 3 frames are outstanding unacked on it; only a subsequent `ack` drains that backlog and lets frames resume. This is not a rate limit warning, not an error message, not a close: the stream simply goes quiet. A production incident in this repository's own history (`packages/conformance/test/e2e/parallel-live-streams.test.ts`'s regression, and `packages/server/src/wire/rate-limit.ts`'s own long comment on `ackRate`) was exactly this: a viewer driving three simultaneous live streams sent acks fast enough in aggregate to look healthy, but the ack rate limit (`ackRate`, `welcome.limits` does not carry this one; it is `DEFAULT_LIMITS.ackRate`, 200 per second with a burst of 400 in `packages/protocol/src/wire/limits.ts`) was scoped per connection at the time, so three streams at roughly 100 fps each produced roughly 300 acks per second against a 200 per second refill, and whichever stream's acks happened to get refused first starved permanently, because the only thing that could unstick its backlog was an ack the rate limiter had just rejected. `ackRate` is now scoped per stream, not per connection, specifically so this cannot happen again; but a native client still needs to send an ack for every frame on every stream it holds, promptly, or it will eventually reproduce some version of this.

`UPLOAD_CHUNK` payload layout: the first 16 bytes are the upload id as raw bytes (not its text form), followed immediately by the chunk's bytes; `packages/conformance/src/protocol/binary-vectors.ts`'s `UPLOAD_CHUNK_PAYLOAD_VECTORS` has a worked example. Note the JSON `upload.*` control messages that would negotiate an upload (`upload.begin`, `upload.accepted`, and so on) are typed by `@browserglass/protocol` but not wired in this build; see the message catalogue below.

## Message catalogue

Every message type this build's `@browserglass/protocol` defines lives in `packages/protocol/src/wire/messages/*.ts`, one file per feature group, plus `error` in `packages/protocol/src/wire/errors.ts`. `packages/conformance/src/protocol/message-vectors.ts` has one fully populated, type checked example envelope for every single one, 94 in total, each tagged with:

* `direction`: `c2s` (client sends it), `s2c` (server sends it), or `both`.
* `wired`: whether THIS BUILD's `@browserglass/server` actually sends or handles the message today, confirmed by reading `packages/server/src/ws/connection.ts`'s inbound dispatch table and by grepping `packages/server/src` for every outbound construction site, not by trusting the protocol package's own doc comments (one of which, on `target.reorder`, turned out to be stale; see below). Values: `wired`, `typed-only` (the type exists, nothing in `packages/server/src` sends or handles it), `accepted-noop` (a handler exists and returns success, but does nothing).
* `note`: anything worth knowing before you rely on the message.

Rather than duplicate 93 rows here, read that file; every entry doubles as a literal JSON example. What follows is the set of findings from building that table that are worth reading even if you never open the vectors file:

* **`target.reorder` is wired, despite its own doc comment.** `packages/protocol/src/wire/messages/targets.ts` still says "Typed only in this pass, not wired" on `TargetReorder`. It has a real handler in `packages/server/src/ws/connection.ts`, whose own comment explains the history: "it had no handler at all, so `tabs.reorder()` was a shipped API that silently did nothing." Trust the vectors file's `wired` field over a doc comment; this is exactly the kind of drift a golden vector file existing at all is meant to catch.
* **The standalone `resume` message is not wired; only `hello.resume` is.** `packages/protocol/src/wire/messages/session.ts`'s `Resume` type documents a message a client can send on its own to resume a session. `packages/server/src/ws/connection.ts` has no dispatch handler for it. Resume only works by setting `hello.resume` on the initial `hello` of a new connection.
* **`presence.cursor` is sent by the reference client but never handled by the server.** `packages/client/src/client/BrowserGlassClient.ts` sends `presence.cursor` whenever the local cursor moves over a controlled target, and the type's own doc comment calls it "both directions." But `packages/server/src/ws/connection.ts`'s inbound handler table has no `presence.cursor` entry; only its rate limit bucket lookup (`bucketFor`) even mentions the string. The result: every `presence.cursor` a client sends is rate limited normally, then falls through to the unknown type branch and gets back a non-fatal `bgls.error.protocol.unknown_type`. The server never relays one viewer's cursor to any other viewer in this build. A native client can skip sending this message entirely without losing anything a real client currently provides.
* **`dialog.opened` and `dialog.closed` have no emission site**, even though `dialog.answer` (the client's reply to an open dialog) is fully wired. A viewer can technically answer a dialog the server never told it was open, because the server side of "tell viewers a JS dialog opened" was never built. Do not depend on ever receiving `dialog.opened`.
* **The standalone `instance.state` push, and `instance.released`, are never emitted**, though `instance.recovering`, `instance.recovered`, and `instance.restart` all are. `welcome.instance` carries the same shape of information inline at connect time and is always populated; only the standalone push messages are missing.
* **`stream.degraded` is typed but never emitted.** The adaptive quality controller it would come from has not shipped in this build.
* **`control.contention` is the explicit co-driving signal, broadcast alongside `control.state` rather than instead of it.** `LeaseState.holders` (carried on every `control.state`) already has the complete, recipient-independent roster of who is driving a target, so a client that diffs consecutive `holders` arrays for a length crossing two could already notice two-or-more drivers on its own. `control.contention` is that noticing done once, by the server: it fires exactly when a target's holder count crosses from one holder to two or more (`contended: true`) and exactly when it drops back to at most one (`contended: false`), never on every `control.state` broadcast in between. It never fires under `mode: 'exclusive'`, where `holders` is 0 or 1 by construction. Unlike `LeaseState.holders`, each entry under `control.contention.holders` carries `kind` (`'human' | 'agent'`) and `priority` directly, so an autonomous agent can decide "a human just started driving my tab, I should stand down" from this one message, without a second round trip to join against `presence.state`. It reports CONTENTION for a resource in the ordinary sense (several parties driving one target at once), not a conflict or an error: shared mode's permissiveness is completely unchanged, and every holder named in it keeps driving exactly as it was.
* **`stream.pause` and `stream.resume` are accepted but are no-ops.** Both have a real handler in `packages/server/src/ws/connection.ts`, and both handlers are literally `() => undefined`. Sending either gets no error, but frame delivery is not actually paused or resumed by it.
* **`clipboard.*`, `upload.*`/`filechooser.*`/`download.*`, `input.drag`, `devtools.*`, `presence.viewport`, `session.busy`, and `instance.relocate`** are all typed and, in most cases, documented in their own source with "Typed only in this pass, not wired." None has a handler or an emission site in `packages/server/src`.

## Close codes

Every close code is a plain WebSocket close code below 3000, or one of six 100 wide bands `packages/protocol/src/wire/close-codes.ts` defines and freezes as the single source of truth: `4000` to `4099` session lifecycle (idle timeout, kicked, instance released, and so on), `4100` to `4199` policy (rate limited, quota exceeded, incompatible version), `4200` to `4299` auth, `4300` to `4399` connection replacement, `4400` to `4499` routing, and `4900` to `4999` reserved for a host application's own codes. No numeric value is ever reused across two different meanings. A client that receives a code it does not specifically recognise can still make a correct decision from the band alone.

Where possible, the server sends `goodbye` (naming the same numeric `code`, plus a machine readable `reason` and a human readable `message`) immediately before closing with a `4xxx` code, and an `error` message before that if the close followed a specific failure. The reference reconnect policy, `packages/protocol/src/wire/close-codes.ts`'s `reconnectPolicy()`: normal WebSocket closure (`1000`) and every code below `3000` otherwise, reconnect with the same credential. `4003 Kicked` and `4006 InstanceReleased` never reconnect. Every other `4000` to `4099` code reconnects with the same credential. `4101 RateLimited` reconnects, honouring `retryAfterMs` if present. `4103 SlowConsumer` and `4105 MessageTooLarge` reconnect with a slower backoff and a hint to proactively degrade quality. Every other `4100` to `4199` code (policy) does not reconnect. `4201 TokenExpired` reconnects immediately with a fresh credential. Every other `4200` to `4299` code (auth) does not reconnect. `4301 ResumeRejected` reconnects immediately, dropping the resume token but keeping the same underlying credential. Every other `4300` to `4399` code (replacement) does not reconnect. `4403 Relocate` reconnects immediately, following `goodbye.redirect.url` rather than the client's own URL, and without reusing the old credential. Every other `4400` to `4499` code (routing) reconnects normally. `4900` to `4999` (host) never reconnects. Anything outside every named range reconnects with the normal backoff, since the cost of wrongly giving up is worse than the cost of an unnecessary retry.

## Capabilities

Eighteen capability strings, deny by default, no hierarchy, no wildcard, no inheritance: `admin` does not imply `view`; `control` does not imply `view`; `probe` does not imply `view`. The full list, from `packages/protocol/src/wire/capabilities.ts`: `view`, `control`, `navigate`, `tabs.manage`, `capture`, `probe`, `clipboard.read`, `clipboard.write`, `upload`, `download`, `devtools`, `automation`, `instance.create`, `instance.restart`, `instance.destroy`, `profile.read`, `profile.write`, `admin`. `welcome.granted` reports what this connection actually has; treat it as a UI hint only, never as the security boundary, since the server independently checks every single inbound message against the capability it requires regardless of what `granted` said at connect time.

The base capability each message type requires, from `packages/server/src/wire/capability-check.ts`'s `REQUIRED_CAPABILITY` table (a `t` absent from this table either needs no capability, or, if it is not a client to server message type at all, is simply never looked up here):

| Requires `view` | Requires `control` | Requires `navigate` | Requires `tabs.manage` | Other |
|---|---|---|---|---|
| `target.list`, `target.activate`, `stream.subscribe`, `stream.unsubscribe`, `stream.pause`, `stream.resume`, `stream.quality`, `keyframe.request`, `target.probe` | `input.mouse`, `input.key`, `input.text`, `input.touch`, `input.composition`, `control.request`, `control.renew`, `control.release`, `dialog.answer` | `nav.goto`, `nav.back`, `nav.forward`, `nav.reload`, `nav.stop` | `target.new`, `target.close`, `target.reorder` | `target.capture` needs `capture`; `clipboard.read`/`clipboard.write` need the matching `clipboard.read`/`clipboard.write`; `diagnostics.subscribe`/`diagnostics.unsubscribe` need `devtools` (not `view`); `instance.restart` needs `instance.restart`; `control.revoke` needs `admin` |

`hello`, `resume`, `ping`, and `ack` need no capability. Three requirements are parameter dependent, layered on top of the base requirement above only when the named field is present: `target.probe` additionally needs `probe` when `detail: 'full'` (plain `'hover'` needs only `view`); `control.request` additionally needs `admin` when `force: true`; `instance.restart` additionally needs `profile.write` when `preserveProfile: false`.

## Rate limits

The whole JSON envelope is parsed first (`JSON.parse` on the raw message), but the server checks the relevant rate limit bucket for `t` before running that message's handler or doing any other work with the payload; a message that fails its bucket check never reaches capability checking or its handler at all. Defaults, from `packages/protocol/src/wire/limits.ts`'s `DEFAULT_LIMITS` (`welcome.limits` on the `Welcome` message carries the subset a client needs at connect time; some of the buckets below, like `ackRate`, are not in `welcome.limits` and are simply this build's fixed defaults):

| Bucket | Default | Scope |
|---|---|---|
| input (`input.*`) | 300 per second | per `(viewer, targetId)` |
| control (`control.*`) | 60 per second, burst 120 | per `(viewer, targetId)` |
| nav (`nav.*`) | 4 per second, burst 8 | per target |
| cursor (`presence.cursor`, `presence.viewport`, `target.probe` with `detail: 'hover'`) | 20 per second, burst 40 | per connection |
| probe full (`target.probe` with `detail: 'full'`) | 2 per second, burst 4 | per target |
| capture (`target.capture`, `page.pdf.get`, `recording.start`) | 5 per second, burst 10 (operator configurable) | per target |
| ack (`ack`) | 200 per second, burst 400 | per stream |
| console / pageError / network (outbound `console.entry` / `page.error` / `network.request` and `network.summary`) | 20/s burst 40, 5/s burst 10, 30/s burst 60 respectively | per target |

`input` and `control` are scoped per `(viewer, targetId)`, not once for the whole connection, specifically so driving several targets at once (this build's whole point) does not have one target's input traffic starve another's. `probe full` and `ack` are scoped even more narrowly, per target and per stream respectively, for the same reason, found the same way: a connection wide `ack` budget of 200 per second cannot keep up with three simultaneous live streams at roughly 100 fps each, and once one stream's acks start being refused its frame backlog can never drain (see the binary frames section above). `capture` and `nav` are per target too, so a script screenshotting four tabs gets four budgets. A rate limited message gets back a non-fatal `error` (`bgls.error.limit.rate`, with `retryAfterMs`), never a close. `retryAfterMs` is the time until that bucket holds a token again, so a client that waits exactly that long and resends will get through. The Node and Python automation clients do this once for `screenshot()` (and `pdf()` in Node) before giving up.

There is also a raw per socket inbound byte budget, 8 MiB per minute by default, checked ahead of every named bucket above; a message that exceeds it never reaches type dispatch at all.

## Building a native client: the minimum viable path

1. Connect with the `bgls.v1` subprotocol; handle `403`/`400` before the socket opens, everything else after.
2. Send `hello` first, with `versions: [1]`, `minVersion: 1`, real `client`/`capabilities`/`viewport` fields (see `packages/conformance/src/protocol/message-vectors.ts`'s `hello` vector), and your credential on exactly one of the four carriers above.
3. Wait for `welcome`; read `granted`, `limits`, and `targets` off it.
4. Correlate every reply you care about by `re === your id`, never by assuming order or by assuming the next matching `t` is your answer.
5. For every binary frame you decode, send `ack` on that `streamId` with that `seq`, promptly, always.
6. Validate outbound and inbound JSON envelopes against `wire-messages.schema.json` while you build; treat a schema failure as a bug in your client, not the server, until proven otherwise.
7. Before depending on any message type, check its `wired` value in `message-vectors.ts`: this build ships several messages that are typed but never sent or handled.
