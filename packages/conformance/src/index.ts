/**
 * `@browserglass/conformance`: the protocol golden vectors, the generic
 * `Store` contract suite, and the end to end assertions the gateway
 * is expected to satisfy.
 *
 * This package's own published surface depends only on
 * `@browserglass/protocol` and `@browserglass/client`, so it speaks
 * the wire protocol against a real endpoint and never imports server
 * internals. `vitest` is a peer dependency: a consumer supplies the
 * runner and calls {@link runStoreContractSuite} (or any other exported
 * helper) from their own `.test.ts` file.
 *
 * The suite's own tests, which additionally need a real gateway
 * (`@browserglass/server`, `@browserglass/router`,
 * `@browserglass/runtime-host`, `@browserglass/store-sqlite`) and real
 * Chrome to verify this package's own "Done when" criteria, live under
 * `test/**`, depending on those packages only as devDependencies. None
 * of that is part of this barrel or this package's built `dist` output.
 */
export { runStoreContractSuite, type StoreContractSuiteOptions } from './store/contract-suite.js';

/**
 * The protocol golden vectors: binary frame header fixtures and one
 * canonical envelope per `bgls.v1` message type. See `src/protocol/index.ts`
 * for what each export covers, and `docs/protocol/wire-spec.md` for the
 * prose specification these vectors accompany. The generated JSON Schema
 * (`src/protocol/schema/wire-messages.schema.json`) is data, not a TS
 * export; read it directly or via `docs/protocol/wire-spec.md`'s pointer to
 * it.
 */
export {
  BINARY_FRAME_VECTORS,
  MALFORMED_BINARY_FRAME_VECTORS,
  MESSAGE_VECTORS,
  UPLOAD_CHUNK_PAYLOAD_VECTORS,
  type BinaryFrameVector,
  type MalformedBinaryFrameVector,
  type MessageVector,
  type UploadChunkPayloadVector,
} from './protocol/index.js';

/** Package identity constant, kept for anything that still probes for it. */
export const PACKAGE_NAME = '@browserglass/conformance';
