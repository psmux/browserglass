#!/usr/bin/env node
/**
 * Layer gate and Node builtin gate for the BrowserGlass monorepo.
 *
 * Walks the BUILT output (dist/*.mjs, dist/*.cjs) of every package under
 * packages/*, not the source, and fails the build on:
 *
 *   1. Any import edge from one BrowserGlass package to another that is not
 *      in the explicit allowed edge list below. This is
 *      the layer gate; it also runs against the declared package.json
 *      dependencies so a violation is caught even before a build exists.
 *   2. Any `node:` builtin, `Buffer`, `process`, or `EventEmitter` reference
 *      in `protocol`, `client`, or `react`.
 *   3. Any runtime dependency at all declared on `protocol`.
 *
 * Usage: node scripts/check-deps.mjs
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PACKAGES_DIR = join(ROOT, 'packages');

/**
 * The exact allowed internal edge list. `cli` is allowed to depend on every
 * other BrowserGlass package by design ("cli depends on everything").
 */
const ALLOWED_INTERNAL_DEPS = {
  protocol: [],
  'store-sqlite': ['protocol'],
  'store-postgres': ['protocol'],
  core: ['protocol'],
  client: ['protocol'],
  router: ['protocol'],
  'runtime-host': ['protocol', 'core'],
  'runtime-remote': ['protocol', 'core'],
  'runtime-docker': ['protocol', 'core'],
  'runtime-k8s': ['protocol', 'core'],
  react: ['protocol', 'client'],
  automation: ['protocol', 'client'],
  embed: ['protocol', 'client'],
  server: ['protocol', 'core', 'router'],
  conformance: ['protocol', 'client'],
  'plugin-api': [],
  cli: null, // null = allowed to depend on all other BrowserGlass packages
};

const BROWSER_ONLY = ['protocol', 'client', 'react'];

/** Node builtin names without the `node:` prefix, for bare-specifier scanning. */
const BUILTIN_NAMES = builtinModules.filter((m) => !m.startsWith('_'));

function shortName(scopedName) {
  return scopedName.replace(/^@browserglass\//, '');
}

function readPackageDirs() {
  return readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

/**
 * Extracts `@browserglass/<name>` specifiers referenced by a built JS file.
 *
 * Matches only real module specifiers: the string argument of a `from`,
 * `import(...)` or `require(...)`. A bare regex over the whole file also hits
 * every TSDoc block that names a sibling package in prose, which is not an
 * import edge and must not fail the build.
 */
function scanInternalEdges(code) {
  const found = new Set();
  const re = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']@browserglass\/([a-z0-9-]+)["']/g;
  for (const match of code.matchAll(re)) found.add(match[1]);
  return found;
}

function scanNodeBuiltins(code) {
  const hits = new Set();
  for (const b of BUILTIN_NAMES) {
    const nodePrefixed = new RegExp(`["']node:${b}["']`);
    const bare = new RegExp(`(?:from|require\\()\\s*["']${b}["']`);
    if (nodePrefixed.test(code) || bare.test(code)) hits.add(`node:${b}`);
  }
  if (/\bBuffer\b/.test(code)) hits.add('Buffer');
  if (/\bprocess\s*\./.test(code) || /\bprocess\s*\[/.test(code)) hits.add('process');
  if (/\bEventEmitter\b/.test(code)) hits.add('EventEmitter');
  return hits;
}

function distFiles(pkgDir) {
  const dist = join(PACKAGES_DIR, pkgDir, 'dist');
  if (!existsSync(dist)) return [];
  return readdirSync(dist)
    .filter((f) => f.endsWith('.mjs') || f.endsWith('.cjs') || f.endsWith('.js'))
    .map((f) => join(dist, f));
}

function main() {
  const failures = [];
  const warnings = [];
  const pkgDirs = readPackageDirs();

  for (const dir of pkgDirs) {
    const pkgJsonPath = join(PACKAGES_DIR, dir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = readJson(pkgJsonPath);
    const name = shortName(pkg.name);
    const allowed = ALLOWED_INTERNAL_DEPS[name];

    // A package absent from the edge table is a gap in the table, not a pass.
    // Reported rather than thrown, so one missing entry does not hide every
    // other violation behind a stack trace.
    if (allowed === undefined) {
      failures.push(
        `@browserglass/${name} has no entry in ALLOWED_INTERNAL_DEPS; add its allowed edges to scripts/check-deps.mjs`,
      );
      continue;
    }

    // Rule 3: protocol has zero runtime dependencies.
    const declaredDeps = Object.keys(pkg.dependencies ?? {});
    if (name === 'protocol' && declaredDeps.length > 0) {
      failures.push(
        `@browserglass/protocol declares runtime dependencies, which is forbidden: ${declaredDeps.join(', ')}`,
      );
    }

    // Rule 1a: declared package.json dependencies against the allowed edge list.
    for (const dep of declaredDeps) {
      if (!dep.startsWith('@browserglass/')) continue;
      const depName = shortName(dep);
      if (allowed !== null && !allowed.includes(depName)) {
        failures.push(
          `layer violation (declared dependency): @browserglass/${name} -/-> @browserglass/${depName}`,
        );
      }
    }

    // Rule 1b: built output import edges against the allowed edge list, plus
    // the Node builtin gate for browser-only packages.
    const files = distFiles(dir);
    if (files.length === 0) {
      warnings.push(
        `packages/${dir}: no dist output found, skipping built-output scan (run "pnpm -r build" first)`,
      );
      continue;
    }
    for (const file of files) {
      const code = readFileSync(file, 'utf8');
      const edges = scanInternalEdges(code);
      edges.delete(name); // self-references (re-exports) are not edges
      for (const depName of edges) {
        if (allowed !== null && !allowed.includes(depName)) {
          failures.push(
            `layer violation (built output ${file.replace(ROOT, '')}): @browserglass/${name} -/-> @browserglass/${depName}`,
          );
        }
      }
      if (BROWSER_ONLY.includes(name)) {
        const hits = scanNodeBuiltins(code);
        for (const hit of hits) {
          failures.push(
            `@browserglass/${name} bundle (${file.replace(ROOT, '')}) references forbidden Node API: ${hit}`,
          );
        }
      }
    }
  }

  if (warnings.length) {
    console.warn(warnings.map((w) => `warning: ${w}`).join('\n'));
  }

  if (failures.length) {
    console.error(`Dependency policy violations:\n  ${failures.join('\n  ')}`);
    process.exit(1);
  }

  console.log(`check:deps passed (${pkgDirs.length} packages checked)`);
}

main();
