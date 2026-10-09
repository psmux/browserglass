# Protocol documentation

Everything a client written in a language other than TypeScript needs to talk to a BrowserGlass gateway over `bgls.v1`, without reading `packages/protocol/src`.

* `wire-spec.md`: the handshake, auth, the JSON envelope, the message catalogue (including which messages this build actually sends and handles versus which are typed but unwired), the binary frame header byte by byte, close codes, capabilities, and rate limits.
* `packages/conformance/src/protocol/binary-vectors.ts`: byte level fixtures for the binary frame header codec, including malformed buffers a decoder must reject.
* `packages/conformance/src/protocol/message-vectors.ts`: one canonical, fully populated example envelope per JSON message type, checked against the real TypeScript types at compile time.
* `packages/conformance/src/protocol/schema/wire-messages.schema.json`: JSON Schema for the same message catalogue, generated (never hand edited) from `packages/protocol/src` by `packages/conformance/scripts/generate-wire-schema.mjs`. Regenerate it with `pnpm --filter @browserglass/conformance generate:schema` after any protocol change; `packages/conformance/test/protocol/schema-drift.test.ts` fails the build if the committed file and a fresh regeneration ever disagree.

All four are exercised by `packages/conformance/test/protocol/golden-vectors.test.ts` against this codebase's own encoder, decoder, and generated schema, which is what keeps them honest as the protocol evolves rather than a one time snapshot.
