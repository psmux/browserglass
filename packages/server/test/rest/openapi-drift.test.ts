/**
 * Proves `packages/server/openapi.json` does not silently drift from
 * `rest/router.ts`'s own route table: every `LIVE` and `STUB_PATHS` entry
 * there has a matching operation here, tagged the way that table says it
 * should be (`x-capability` for a live route, `x-status: 'stub'` for a
 * stub), and the document names no path/method the route table does not
 * also have. There is no code generator for this file (see its own
 * `info.description`): this test is what stands in for one, by comparing
 * both sources of truth on every run rather than trusting a human to keep
 * them in sync by hand.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { LIVE, STUB_PATHS } from '../../src/rest/router.js';

const openapiPath = fileURLToPath(new URL('../../openapi.json', import.meta.url));

interface OpenApiOperation {
  readonly 'x-capability'?: string | null;
  readonly 'x-status'?: string;
}
interface OpenApiDoc {
  readonly paths: Readonly<Record<string, Readonly<Record<string, OpenApiOperation>>>>;
}

/** `:param` (the route table's own syntax) to `{param}` (OpenAPI's), matching `path.ts`'s param names one-for-one. */
function toOpenApiPath(path: string): string {
  return path.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

describe('openapi.json matches rest/router.ts (no silent drift)', () => {
  const doc = JSON.parse(readFileSync(openapiPath, 'utf8')) as OpenApiDoc;

  it('every LIVE route has a matching, correctly capability-tagged openapi operation', () => {
    for (const route of LIVE) {
      const pathKey = toOpenApiPath(route.path);
      const methodKey = route.method.toLowerCase();
      const pathItem = doc.paths[pathKey];
      expect(pathItem, `openapi.json is missing path "${pathKey}"`).toBeDefined();
      const operation = pathItem?.[methodKey];
      expect(operation, `openapi.json is missing ${route.method} ${pathKey}`).toBeDefined();
      expect(operation?.['x-status']).not.toBe('stub');
      expect(operation?.['x-capability']).toBe(route.capability);
    }
  });

  it('every STUB_PATHS route has a matching operation tagged x-status: stub', () => {
    for (const stub of STUB_PATHS) {
      const pathKey = toOpenApiPath(stub.path);
      const methodKey = stub.method.toLowerCase();
      const pathItem = doc.paths[pathKey];
      expect(pathItem, `openapi.json is missing path "${pathKey}"`).toBeDefined();
      const operation = pathItem?.[methodKey];
      expect(operation, `openapi.json is missing ${stub.method} ${pathKey}`).toBeDefined();
      expect(operation?.['x-status']).toBe('stub');
    }
  });

  it('openapi.json names no path/method the route table does not also have (no stale entries)', () => {
    const known = new Set<string>(
      [...LIVE.map((r) => ({ method: r.method, path: r.path })), ...STUB_PATHS].map(
        (r) => `${r.method.toUpperCase()} ${toOpenApiPath(r.path)}`,
      ),
    );
    const documented: string[] = [];
    for (const [pathKey, methods] of Object.entries(doc.paths)) {
      for (const method of Object.keys(methods)) {
        documented.push(`${method.toUpperCase()} ${pathKey}`);
      }
    }
    for (const entry of documented) {
      expect(
        known.has(entry),
        `openapi.json documents "${entry}", which is not in router.ts's route table`,
      ).toBe(true);
    }
    // Same count both ways confirms this is a two-way match, not merely
    // "documented is a subset": LIVE.length + STUB_PATHS.length is exactly
    // the number of operations router.ts registers.
    expect(documented.length).toBe(LIVE.length + STUB_PATHS.length);
  });
});
