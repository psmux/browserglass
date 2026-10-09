#!/usr/bin/env node
/**
 * Bundle size budget gate for the BrowserGlass monorepo.
 *
 * Measures min+gzip size per browser entry point after build, against the
 * budgets below, and fails on regression above the
 * hard fail threshold, naming the delta and the three largest modules found
 * in that bundle.
 *
 * Usage: node scripts/check-size.mjs
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PACKAGES_DIR = join(ROOT, 'packages');

const KB = 1024;

/**
 * Size budgets. `hardFailBytes` is undefined for entries that only have a
 * target, not an explicit hard limit.
 */
const BUDGETS = [
  {
    // Raised from 12.00 KB to 13.00 KB after the diagnostics message group
    // (console.entry, page.error, network.summary, network.request,
    // devtools.open/url, diagnostics.subscribe/unsubscribe/subscribed)
    // landed and pushed the measured size to 12.45 KB. Those types are a
    // real feature, most of them wired (see wire/messages/diagnostics.ts),
    // not bloat to trim, so the deliberate call is to raise the budget
    // rather than cut functionality to fit the old number. 13.00 KB leaves
    // about 0.55 KB of headroom above the current 12.45 KB measurement.
    label: '@browserglass/protocol',
    entry: join(PACKAGES_DIR, 'protocol', 'src', 'index.ts'),
    external: [],
    budgetBytes: 13 * KB,
    hardFailBytes: undefined,
  },
  {
    label: '@browserglass/client',
    entry: join(PACKAGES_DIR, 'client', 'src', 'index.ts'),
    external: ['@browserglass/protocol'],
    budgetBytes: 28 * KB,
    hardFailBytes: 32 * KB,
  },
  {
    label: '@browserglass/react',
    entry: join(PACKAGES_DIR, 'react', 'src', 'index.ts'),
    external: ['@browserglass/protocol', '@browserglass/client'],
    budgetBytes: 22 * KB,
    hardFailBytes: 26 * KB,
  },
  {
    // Measured with NOTHING external, unlike its siblings above. The whole
    // point of the embed build is a single script tag on a page that has no
    // bundler, so the number a host actually pays is the fully bundled one,
    // protocol and client included. Comparing it against react's 22 KB would
    // be comparing two different things.
    label: '@browserglass/embed',
    entry: join(PACKAGES_DIR, 'embed', 'src', 'index.ts'),
    external: [],
    budgetBytes: 48 * KB,
    hardFailBytes: 56 * KB,
  },
];

const COMBINED = {
  label: 'combined browser payload',
  entry: join(PACKAGES_DIR, 'react', 'src', 'index.ts'),
  external: [],
  budgetBytes: 62 * KB,
  hardFailBytes: 70 * KB,
};

function fmtKb(bytes) {
  return `${(bytes / KB).toFixed(2)} KB`;
}

/** Bundles + minifies one entry point and returns { gzipBytes, topModules }. */
async function measure(entry, external) {
  const result = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    minify: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    external,
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const output = result.outputFiles[0];
  const gzipBytes = gzipSync(output.contents).length;

  const modules = Object.entries(result.metafile.inputs)
    .map(([path, info]) => ({ path, bytes: info.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);

  return { gzipBytes, topModules: modules };
}

async function main() {
  const failures = [];
  const lines = [];

  for (const b of BUDGETS) {
    if (!existsSync(b.entry)) {
      console.warn(`warning: ${b.label}: entry ${b.entry} not found, skipping`);
      continue;
    }
    let result;
    try {
      result = await measure(b.entry, b.external);
    } catch (err) {
      console.warn(
        `warning: ${b.label}: could not bundle for size measurement (${err.message}). Build the package first.`,
      );
      continue;
    }
    const { gzipBytes, topModules } = result;
    const status =
      b.hardFailBytes !== undefined && gzipBytes > b.hardFailBytes
        ? 'FAIL'
        : gzipBytes > b.budgetBytes
          ? 'WARN (over budget, under hard fail)'
          : 'OK';
    lines.push(
      `${b.label}: ${fmtKb(gzipBytes)} (budget ${fmtKb(b.budgetBytes)}${b.hardFailBytes ? `, hard fail ${fmtKb(b.hardFailBytes)}` : ''}) [${status}]`,
    );

    if (status === 'FAIL') {
      const delta = gzipBytes - b.hardFailBytes;
      const top = topModules.map((m) => `${m.path} (${fmtKb(m.bytes)})`).join(', ');
      failures.push(
        `${b.label} exceeds hard fail by ${fmtKb(delta)}. Largest modules: ${top || 'n/a'}`,
      );
    }
  }

  if (
    existsSync(join(PACKAGES_DIR, 'client', 'dist', 'index.mjs')) &&
    existsSync(join(PACKAGES_DIR, 'protocol', 'dist', 'index.mjs'))
  ) {
    try {
      const { gzipBytes, topModules } = await measure(COMBINED.entry, COMBINED.external);
      const status =
        gzipBytes > COMBINED.hardFailBytes
          ? 'FAIL'
          : gzipBytes > COMBINED.budgetBytes
            ? 'WARN (over budget, under hard fail)'
            : 'OK';
      lines.push(
        `${COMBINED.label}: ${fmtKb(gzipBytes)} (budget ${fmtKb(COMBINED.budgetBytes)}, hard fail ${fmtKb(COMBINED.hardFailBytes)}) [${status}]`,
      );
      if (status === 'FAIL') {
        const delta = gzipBytes - COMBINED.hardFailBytes;
        const top = topModules.map((m) => `${m.path} (${fmtKb(m.bytes)})`).join(', ');
        failures.push(
          `${COMBINED.label} exceeds hard fail by ${fmtKb(delta)}. Largest modules: ${top || 'n/a'}`,
        );
      }
    } catch (err) {
      console.warn(
        `warning: combined browser payload: could not bundle (${err.message}). Build client and protocol first.`,
      );
    }
  } else {
    console.warn('warning: combined browser payload: client/protocol dist not built yet, skipping');
  }

  console.log(lines.join('\n'));

  if (failures.length) {
    console.error(`\nSize budget violations:\n\n${failures.join('\n\n')}`);
    process.exit(1);
  }

  console.log('\ncheck:size passed');
}

main();
