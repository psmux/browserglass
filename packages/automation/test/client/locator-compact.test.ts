import { MAX_EVALUATE_SOURCE_BYTES } from '@browserglass/protocol';
import { transformSync } from 'esbuild';
import { describe, expect, it } from 'vitest';
import { compactPageScript } from '../../src/locator/compact.js';
import * as scripts from '../../src/locator/script.js';

/**
 * The page scripts have to fit under the gateway's evaluate ceiling, and the
 * fake gateway the rest of this suite talks to does not enforce it. That is
 * how `WAIT_SCRIPT` reached 34582 bytes and broke every waiting verb against
 * a real gateway without one test going red. This file is the guard.
 */

/** Every exported page script, found by name so a new export is covered without editing this list. */
const PAGE_SCRIPTS = Object.entries(scripts).filter(
  (entry): entry is [string, string] =>
    entry[0].endsWith('_SCRIPT') && typeof entry[1] === 'string',
);

/** At least 20 percent of the ceiling has to stay free, so ordinary growth does not walk straight back into the wall. */
const BUDGET_BYTES = Math.floor(MAX_EVALUATE_SOURCE_BYTES * 0.8);

/** Prints the program with comments and layout gone, so two texts that differ only in those print the same. */
function canonical(source: string): string {
  return transformSync(`(${source});`, {
    minifyWhitespace: true,
    legalComments: 'none',
    loader: 'js',
  }).code;
}

describe('page script size', () => {
  it('finds the scripts it is meant to guard', () => {
    expect(PAGE_SCRIPTS.map(([name]) => name).sort()).toEqual([
      'CLEAR_SCRIPT',
      'DISPATCH_CLICK_SCRIPT',
      'FIND_IN_PAGE_SCRIPT',
      'READ_SCRIPT',
      'RESOLVE_SCRIPT',
      'SELECT_SCRIPT',
      'WAIT_SCRIPT',
    ]);
  });

  it.each(PAGE_SCRIPTS)(
    '%s leaves at least 20 percent of MAX_EVALUATE_SOURCE_BYTES free',
    (_name, source) => {
      expect(Buffer.byteLength(source, 'utf8')).toBeLessThanOrEqual(BUDGET_BYTES);
    },
  );
});

describe('compactPageScript', () => {
  it('drops comment lines, blank lines and indentation and keeps line breaks between code', () => {
    const source = [
      '(spec) => {',
      '  // a line comment',
      '',
      '  /**',
      '   * a block comment',
      '   */',
      '  /* one line block */',
      "  var url = 'http://xy';",
      '  return url; // trailing comment stays',
      '}',
    ].join('\n');
    expect(compactPageScript(source)).toBe(
      ['(spec) => {', "var url = 'http://xy';", 'return url; // trailing comment stays', '}'].join(
        '\n',
      ),
    );
  });

  it('never touches text inside a line, so // in a string or a regex survives', () => {
    const source = "  var a = 'http://example.com';\n  var r = /\\/\\/+/g;";
    expect(compactPageScript(source)).toBe("var a = 'http://example.com';\nvar r = /\\/\\/+/g;");
  });

  it('refuses a template literal, which could span lines', () => {
    expect(() => compactPageScript('var a = `x`;')).toThrow(/backtick/);
  });

  it('refuses a string continued across lines with a backslash', () => {
    expect(() => compactPageScript("var a = 'x\\\n  y';")).toThrow(/backslash/);
  });

  it('refuses a block comment marker it cannot account for', () => {
    expect(() => compactPageScript("var a = '/*';")).toThrow(/block comment/);
    expect(() => compactPageScript('/* a */ var a = 1;')).toThrow(/block comment/);
    expect(() => compactPageScript('/* a\n b */ var a = 1;')).toThrow(/block comment/);
    expect(() => compactPageScript('/* never closed')).toThrow(/block comment/);
  });

  /**
   * The independent check. esbuild parses both texts and prints them with
   * all comments and layout removed; if compaction changed anything a
   * parser can see, the two prints differ. script.ts only exports the
   * compacted text, so the originals are rebuilt from the file itself.
   */
  it.each(PAGE_SCRIPTS)(
    '%s parses to the same program before and after compaction',
    async (name, compacted) => {
      const original = await readOriginal(name);
      expect(compactPageScript(original)).toBe(compacted);
      expect(canonical(compacted)).toBe(canonical(original));
    },
  );
});

/**
 * Rebuilds one export's uncompacted text by evaluating script.ts with
 * `compactPageScript` swapped for the identity function. The file is plain
 * TypeScript with no type syntax inside the template literals, so esbuild
 * can strip the types and the result runs as a module.
 */
async function readOriginal(name: string): Promise<string> {
  originals ??= loadOriginals();
  const all = await originals;
  const text = all[name];
  if (typeof text !== 'string') throw new Error(`no original text for ${name}`);
  return text;
}

let originals: Promise<Record<string, unknown>> | undefined;

async function loadOriginals(): Promise<Record<string, unknown>> {
  const { readFile } = await import('node:fs/promises');
  const { fileURLToPath } = await import('node:url');
  const path = fileURLToPath(new URL('../../src/locator/script.ts', import.meta.url));
  const ts = await readFile(path, 'utf8');
  const withoutImport = ts.replace(
    /^import \{ compactPageScript \} from '\.\/compact\.js';$/m,
    'const compactPageScript = (s) => s;',
  );
  if (withoutImport === ts)
    throw new Error('script.ts no longer imports compactPageScript the way this test expects');
  const js = transformSync(withoutImport, { loader: 'ts', format: 'cjs' }).code;
  const module = { exports: {} as Record<string, unknown> };
  new Function('module', 'exports', js)(module, module.exports);
  return module.exports;
}
