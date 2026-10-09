#!/usr/bin/env node
/**
 * Export surface gate for the BrowserGlass monorepo.
 *
 * For every package under packages/*, after a build:
 *
 *   1. Runs `publint` against the packed tarball, catching a bad `exports`
 *      map, a `main`/`module` pointing nowhere, a missing `files` entry,
 *      and similar packaging mistakes.
 *   2. Runs `@arethetypeswrong/cli` against the packed tarball, catching
 *      types resolving to the wrong file under a consumer's module
 *      resolution setting.
 *   3. Scans the package's rolled-up `dist/index.d.ts` for a top-level
 *      exported symbol with no immediately preceding TSDoc block
 *      (`/** ... *\/`), per the universal rule that every exported symbol
 *      carries a TSDoc block. An undocumented export fails the build.
 *
 * Usage: node scripts/check-exports.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PACKAGES_DIR = join(ROOT, 'packages');

// Only actual declaration sites need a TSDoc block. A bare `export { X };`
// aggregator line (what tsup's dts rollup emits at the bottom of the file)
// is not a declaration; the symbol it names was already checked at its
// `declare const|function|...` site above.
const EXPORT_DECL_RE =
  /^export\s+(?:declare\s+)?(?:default\s+)?(const|function|class|interface|type|enum|namespace|abstract class)\s+([A-Za-z_$][\w$]*)/;

/** Returns true if the non-blank lines immediately above `idx` close a `/** ... *\/` block. */
function precededByTsDoc(lines, idx) {
  let i = idx - 1;
  while (i >= 0 && lines[i].trim() === '') i--;
  if (i < 0) return false;
  return lines[i].trim().endsWith('*/');
}

function checkTsDoc(pkgName, dtsPath) {
  const failures = [];
  if (!existsSync(dtsPath)) return failures;
  const lines = readFileSync(dtsPath, 'utf8').split(/\r?\n/);
  lines.forEach((line, idx) => {
    const trimmed = line.trim();
    const m = trimmed.match(EXPORT_DECL_RE);
    if (m) {
      const symbol = m[2];
      if (!precededByTsDoc(lines, idx)) {
        failures.push(
          `@browserglass/${pkgName}: exported symbol '${symbol}' in dist/index.d.ts has no TSDoc block`,
        );
      }
    }
  });
  return failures;
}

function runTool(cmd, args, cwd) {
  try {
    const out = execFileSync(cmd, args, { cwd, encoding: 'utf8', shell: true, stdio: 'pipe' });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, out: (err.stdout ?? '') + (err.stderr ?? '') || String(err.message) };
  }
}

function main() {
  const failures = [];
  const warnings = [];
  const pkgDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  for (const dir of pkgDirs) {
    const pkgDir = join(PACKAGES_DIR, dir);
    const pkgJsonPath = join(pkgDir, 'package.json');
    if (!existsSync(pkgJsonPath)) continue;
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'));
    const name = pkg.name.replace(/^@browserglass\//, '');
    const distDir = join(pkgDir, 'dist');

    if (!existsSync(distDir)) {
      warnings.push(
        `packages/${dir}: no dist output found, skipping export checks (run "pnpm -r build" first)`,
      );
      continue;
    }

    // 1. publint against the packed tarball.
    const publint = runTool('pnpm', ['exec', 'publint', pkgDir], ROOT);
    if (!publint.ok) {
      failures.push(`publint failed for @browserglass/${name}:\n${publint.out.trim()}`);
    }

    // 2. @arethetypeswrong/cli against the packed tarball.
    const isDual = Boolean(pkg.exports?.['.']?.require);
    const ignoreRules = isDual
      ? // `false-esm` is ignored: tsup's dts rollup emits the same ESM
        // `export {}` syntax for both index.d.ts and index.d.cts, which attw
        // flags as "masquerading as ESM" on every tsup dual-format package
        // regardless of content (a known tsup/rollup-plugin-dts limitation,
        // not a resolution bug); the actual CJS runtime output (index.cjs) is
        // genuine CommonJS with the `__esModule` interop marker, verified
        // separately by the runtime require() resolution row.
        ['false-esm']
      : // ESM-only packages (client, react, cli, conformance) do not
        // support require(); a require()
        // call resolving to the ESM file (and failing at runtime with
        // ERR_REQUIRE_ESM) is the correct, honest outcome for a package that
        // deliberately does not ship a CJS entry point, same as chalk,
        // execa, and most modern ESM-only packages.
        ['cjs-resolves-to-esm'];
    if (name === 'react') {
      // `@browserglass/react` ships a `./ui` subpath and a `./ui/styles.css`
      // asset export. `NoResolution` fires on both, and neither is a real
      // resolution bug for a consumer of this package. `./ui` fails only
      // under attw's node10 (pre-Node12, no `exports` field support)
      // emulation, which this monorepo has already deliberately opted out
      // of: `typesVersions` is not used and types resolve through `exports` only, so there is no legacy
      // fallback path to provide. `./ui/styles.css` fails under every
      // resolver because attw only knows how to resolve JS/type exports;
      // a bundler-only CSS asset export has no type declarations to check
      // by definition, and every other resolver row for the package's real
      // JS entry points is green.
      ignoreRules.push('no-resolution');
    }
    const attw = runTool(
      'pnpm',
      ['exec', 'attw', '--pack', pkgDir, '--ignore-rules', ...ignoreRules],
      ROOT,
    );
    if (!attw.ok) {
      failures.push(`attw failed for @browserglass/${name}:\n${attw.out.trim()}`);
    }

    // 3. TSDoc-on-every-export gate.
    failures.push(...checkTsDoc(name, join(distDir, 'index.d.ts')));
  }

  if (warnings.length) {
    console.warn(warnings.map((w) => `warning: ${w}`).join('\n'));
  }

  if (failures.length) {
    console.error(`Export surface violations:\n\n${failures.join('\n\n')}`);
    process.exit(1);
  }

  console.log(`check:exports passed (${pkgDirs.length} packages checked)`);
}

main();
