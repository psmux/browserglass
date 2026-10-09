/**
 * Fails the build if `src/protocol/schema/wire-messages.schema.json` (the
 * committed, generated artifact) ever disagrees with what
 * `scripts/generate-wire-schema.mjs` would produce right now from
 * `packages/protocol/src`. This is the mechanism that makes "GENERATE it
 * from the TypeScript types... and wire the generation into a script so it
 * cannot drift" actually true rather than aspirational: without this test,
 * nothing stops someone from editing a message type in `protocol/src` and
 * never re-running `pnpm generate:schema`, at which point the committed
 * schema quietly starts describing a shape the protocol no longer has.
 *
 * Regenerates the schema in memory, using the exact same
 * `ts-json-schema-generator` configuration the script uses (duplicated
 * here rather than imported, since the script is a standalone Node
 * executable, not a module this test can import a function from without
 * restructuring it away from a plain top-level script), and asserts deep
 * equality against the committed file, parsed. A failure here means: run
 * `pnpm --filter @browserglass/conformance generate:schema` and commit the
 * result.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createGenerator } from 'ts-json-schema-generator';
import { describe, expect, it } from 'vitest';

const packageRoot = fileURLToPath(new URL('../../', import.meta.url));
const protocolRoot = fileURLToPath(new URL('../../../protocol', import.meta.url));

function regenerate(): {
  $schema: string;
  $id: string;
  title: string;
  description: string;
  definitions: Record<string, unknown>;
} {
  const baseConfig = {
    tsconfig: `${protocolRoot}/tsconfig.json`,
    skipTypeCheck: true,
    expose: 'export' as const,
    jsDoc: 'extended' as const,
    sortProps: false,
  };
  const messagesSchema = createGenerator({
    ...baseConfig,
    path: `${protocolRoot}/src/wire/messages/index.ts`,
    type: '*',
  }).createSchema('*');
  const errorSchema = createGenerator({
    ...baseConfig,
    path: `${protocolRoot}/src/wire/errors.ts`,
    type: 'ErrorMsg',
  }).createSchema('ErrorMsg');
  const definitions = { ...messagesSchema.definitions, ...errorSchema.definitions } as Record<
    string,
    unknown
  >;
  return {
    $schema: 'http://json-schema.org/draft-07/schema#',
    $id: 'https://browserglass.dev/schema/wire-messages.schema.json',
    title: 'bgls.v1 wire message catalogue',
    description:
      "Generated from packages/protocol/src/wire/messages/** and packages/protocol/src/wire/errors.ts's ErrorMsg, by packages/conformance/scripts/generate-wire-schema.mjs. Do not hand edit: run `pnpm --filter @browserglass/conformance generate:schema` after any change to the protocol package's message types, and commit the regenerated file. packages/conformance/test/protocol/schema-drift.test.ts fails the build if this file and the source it was generated from ever disagree.",
    definitions,
  };
}

describe('generated schema has not drifted from packages/protocol/src', () => {
  it('re-running the generator reproduces the exact committed wire-messages.schema.json', () => {
    const committedPath = `${packageRoot}/src/protocol/schema/wire-messages.schema.json`;
    const committed = JSON.parse(readFileSync(committedPath, 'utf8')) as unknown;
    const fresh = regenerate();
    // Deep equality, not a string/byte comparison: this test cares about
    // the SCHEMA content, not incidental key-order or whitespace
    // differences a future refactor of the generator script's own
    // JSON.stringify call might introduce.
    expect(committed).toEqual(fresh);
  });
});
