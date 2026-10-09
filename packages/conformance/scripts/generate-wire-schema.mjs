#!/usr/bin/env node
/**
 * Generates JSON Schema for the `bgls.v1` wire message catalogue directly
 * from `@browserglass/protocol`'s own TypeScript source, so the schema can
 * never drift from the types the server and client actually compile
 * against. This is a generator, not a hand-maintained document: nobody
 * should ever hand edit `../src/protocol/schema/wire-messages.schema.json`,
 * only run `pnpm --filter @browserglass/conformance generate:schema` again
 * after a protocol change and commit the result.
 *
 * Uses `ts-json-schema-generator` (https://github.com/vega/ts-json-schema-generator),
 * chosen over `zod-to-json-schema` (already present in this workspace's
 * lockfile as a transitive dependency, but useless here since `packages/protocol`
 * has no zod dependency and is documented as zero runtime dependencies:
 * adding one just to describe the wire shape would be a bigger change than
 * a schema generator justifies) and over `typescript-json-schema` (unmaintained since
 * 2022, per its own repository). `ts-json-schema-generator` reads the
 * TypeScript compiler's own AST, so it needs no runtime schema library in
 * `protocol` at all, and it carries every JSDoc comment on a field straight
 * into the schema's `description`, which is why the message catalogue's
 * existing doc comments (see `packages/protocol/src/wire/messages/*.ts`)
 * show up unchanged in the generated output.
 *
 * The entry point is `packages/protocol/src/wire/messages/index.ts`, the
 * barrel this repository's own `packages/protocol/src/wire/index.ts` already
 * treats as the message catalogue (its own doc comment calls it "the full
 * bgls.v1 message catalogue"). `type: '*'` walks every type exported,
 * directly or transitively, from that barrel: every message interface
 * (`Hello`, `Welcome`, `Ack`, and so on) plus every helper type a message
 * embeds (`TargetSummary`, `TouchPoint`, `HelloCapabilities`...). Each
 * message interface extends `Envelope`
 * (`packages/protocol/src/wire/envelope.ts`), and the generator resolves
 * that `extends` by flattening `Envelope`'s own fields (`v`, `t`, `id`,
 * `re`, `sid`, `vid`, `sq`, `ts`) into every message schema, with `t`
 * narrowed to that message's own literal string via `const`. `Envelope`'s
 * index signature (`[k: string]: unknown`, "payload fields, spread at the
 * top level, never nested") becomes `additionalProperties: true`-shaped
 * rather than `false`, which is the correct, honest schema for an envelope
 * whose payload fields are not closed.
 *
 * `error` lives outside that barrel, in `packages/protocol/src/wire/errors.ts`,
 * per that file's own doc comment ("`error` itself lives in `../errors.js`,
 * alongside the `ErrorCategory` and registry it shares a namespace with"),
 * so it needs a second generator run against that file for its one message
 * type, `ErrorMsg`, merged into the same definitions map below. Every other
 * type in `wire/**` outside `wire/messages/**` and `wire/errors.ts`'s
 * `ErrorMsg` (ids, close codes, capabilities, auth, version negotiation) is
 * deliberately out of scope for this script, which only produces JSON
 * Schema for the wire messages. Those other files
 * are documented, not schema'd, in `docs/protocol/wire-spec.md`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';

const here = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(here, '..');
const protocolRoot = resolve(packageRoot, '../protocol');

const tsconfig = resolve(protocolRoot, 'tsconfig.json');

// Base options shared by both generator runs below.
const baseConfig = {
  tsconfig,
  // The generator only reads types; it does not execute anything from
  // `protocol/src`, so a full `tsc` type-check ahead of schema generation
  // is unnecessary work here. `pnpm typecheck` at the workspace root still
  // covers `protocol/src` on its own.
  skipTypeCheck: true,
  expose: 'export',
  // Carries doc comments (including `@link`-style references to other
  // types) into `description` fields on the generated schema, rather than
  // dropping them, so a schema consumer gets the same context a TypeScript
  // reader of `protocol/src` would.
  jsDoc: 'extended',
  sortProps: false,
};

const outPath = resolve(packageRoot, 'src/protocol/schema/wire-messages.schema.json');

/** Runs one generator over `path`, asking for `type` (a name, or `'*'` for every exported type). */
function generate(path, type) {
  const config = { ...baseConfig, path, type };
  const generator = createGenerator(config);
  return generator.createSchema(type);
}

function main() {
  // Every exported type from the messages barrel, not one named root type:
  // there is no single "WireMessage" union in `@browserglass/protocol`
  // (messages are just individually exported interfaces), so `'*'` is the
  // only way to reach all of them in one generator run.
  const messagesSchema = generate(resolve(protocolRoot, 'src/wire/messages/index.ts'), '*');
  // `error`'s one type, from its own file (see the module doc above for why
  // it is not part of the messages barrel).
  const errorSchema = generate(resolve(protocolRoot, 'src/wire/errors.ts'), 'ErrorMsg');

  // Both runs share `Envelope` as a base type but resolve it independently
  // (`ts-json-schema-generator` inlines `extends` rather than emitting a
  // reusable `Envelope` definition), so there is no name collision to
  // reconcile: merging the two `definitions` maps is enough. A named-type
  // request (`'ErrorMsg'`, unlike the messages run's `'*'`) comes back as
  // `{ $ref: '#/definitions/ErrorMsg', definitions: { ErrorMsg: {...}, ... } }`
  // rather than the type inlined at the top level, so `ErrorMsg` itself is
  // already present in `errorSchema.definitions` and needs no separate copy.
  const definitions = { ...messagesSchema.definitions, ...errorSchema.definitions };

  const stamped = {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://browserglass.dev/schema/wire-messages.schema.json',
    title: 'bgls.v1 wire message catalogue',
    description:
      "Generated from packages/protocol/src/wire/messages/** and packages/protocol/src/wire/errors.ts's ErrorMsg, by packages/conformance/scripts/generate-wire-schema.mjs. Do not hand edit: run `pnpm --filter @browserglass/conformance generate:schema` after any change to the protocol package's message types, and commit the regenerated file. packages/conformance/test/protocol/schema-drift.test.ts fails the build if this file and the source it was generated from ever disagree.",
    definitions,
  };

  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(stamped, null, 2)}\n`, 'utf8');
  process.stdout.write(`Wrote ${Object.keys(definitions).length} type definitions to ${outPath}\n`);
}

main();
