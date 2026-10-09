/**
 * The protocol golden vectors this package's own module doc
 * (`packages/conformance/src/index.ts`) and the root `README.md`'s package
 * table have promised since the first build pass. Three pieces, matching
 * `docs/protocol/wire-spec.md`'s own structure:
 *
 *   - `binary-vectors.ts`: byte-level fixtures for the 20-byte binary frame
 *     header codec (`@browserglass/protocol`'s `wire/binary.ts`), including
 *     malformed buffers a decoder must reject and the `UPLOAD_CHUNK`
 *     payload split.
 *   - `message-vectors.ts`: one canonical example envelope per JSON control
 *     message in the `bgls.v1` catalogue, plus which of them this build's
 *     `@browserglass/server` actually sends or handles today.
 *   - `schema/wire-messages.schema.json`: JSON Schema for the same message
 *     catalogue, generated (never hand written) from
 *     `packages/protocol/src` by `scripts/generate-wire-schema.mjs`.
 *
 * A foreign, non-TypeScript implementation is meant to consume these three
 * things directly rather than reverse-engineer `packages/protocol/src`:
 * the vectors as literal test fixtures, the schema as a validator input.
 * `test/protocol/golden-vectors.test.ts` and `test/protocol/schema-drift.test.ts`
 * are what keep all three honest against this codebase's own encoder,
 * decoder, and type definitions as the protocol evolves.
 */
export {
  BINARY_FRAME_VECTORS,
  MALFORMED_BINARY_FRAME_VECTORS,
  UPLOAD_CHUNK_PAYLOAD_VECTORS,
  type BinaryFrameVector,
  type MalformedBinaryFrameVector,
  type UploadChunkPayloadVector,
} from './binary-vectors.js';
export { MESSAGE_VECTORS, type MessageVector } from './message-vectors.js';
