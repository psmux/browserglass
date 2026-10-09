/**
 * Runs every probe in this directory against a live gateway and prints one
 * table saying what works.
 *
 * The probes were written one at a time, each proving a different claim,
 * and they had drifted into the state where nobody ran all of them because
 * running all of them meant remembering eight command lines and eight sets
 * of environment variables. So this is the single command.
 *
 * Each probe already exits non-zero on a failed assertion, which is the
 * whole contract this relies on: no output parsing, no regexes over log
 * lines, just the exit code the probe already promises.
 *
 * The probes launch real Chrome instances, so this is slow (minutes, not
 * seconds) and it is deliberately SEQUENTIAL. Running them concurrently
 * would have them compete for the same quota and blame each other for the
 * refusals.
 *
 * Run:  node examples/nextjs-demo/verify-all.mjs
 *       BASE=http://localhost:3000 node examples/nextjs-demo/verify-all.mjs
 *       ONLY=parallel,collab node examples/nextjs-demo/verify-all.mjs
 */
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.BASE ?? 'http://localhost:3000';
const WS = process.env.WS ?? 'ws://localhost:3000/browserglass/socket';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null;

/**
 * `what` is the claim the probe exists to defend, phrased so a failing row
 * tells you what broke rather than which file ran.
 */
const PROBES = [
  {
    name: 'parallel',
    file: 'parallel-probe.mjs',
    env: { N: '4' },
    what: 'N browsers are driven at the same time, not in turns',
  },
  {
    name: 'parallel-ops',
    file: 'parallel-ops-probe.mjs',
    env: { N: '4' },
    what: 'the whole input and diagnostics surface survives concurrency',
  },
  {
    name: 'input-concurrency',
    file: 'input-concurrency-probe.mjs',
    env: { LEVELS: '1,2,4' },
    what: 'keystrokes, clicks, wheel events are not dropped under load',
  },
  {
    name: 'collab',
    file: 'collab-probe.mjs',
    env: {},
    what: 'several viewers share one browser, control is immediate, nobody is queued',
  },
  {
    name: 'form-parity',
    file: 'form-parity-probe.mjs',
    env: {},
    what: 'the Playwright-shaped surface a form-filling app needs',
  },
  {
    name: 'isolated-world',
    file: 'isolated-world-probe.mjs',
    env: {},
    what: 'the locator surface runs where the page cannot watch it',
  },
  {
    name: 'gate',
    file: 'gate-probe.mjs',
    env: {},
    what: 'the outbound request gate holds, denies and releases',
  },
  {
    name: 'netidle',
    file: 'netidle-probe.mjs',
    env: {},
    what: 'waitForNetworkIdle tracks real in-flight requests',
  },
  {
    name: 'a11y',
    file: 'a11y-probe.mjs',
    env: {},
    what: 'the accessibility tree and the role= selector',
  },
];

function run(probe) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [join(HERE, probe.file)], {
      cwd: HERE,
      env: { ...process.env, BASE, WS, ...probe.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
    });
    child.stderr.on('data', (d) => {
      out += d;
    });
    child.on('close', (code) => resolve({ ...probe, code, ms: Date.now() - started, out }));
    child.on('error', (e) =>
      resolve({ ...probe, code: -1, ms: Date.now() - started, out: String(e) }),
    );
  });
}

const log = (...a) => console.log(...a);

async function main() {
  const res = await fetch(`${BASE}/api/browser/instances`).catch(() => null);
  if (res === null) {
    log(`No gateway answering at ${BASE}.`);
    log('Start one first:  cd examples/nextjs-demo && node server.mjs');
    process.exit(2);
  }

  const selected = PROBES.filter((p) => ONLY === null || ONLY.has(p.name));
  log(`\nVerifying against ${BASE}`);
  log(
    `${selected.length} probe(s), run one after another because they compete for browser quota.\n`,
  );

  const results = [];
  for (const probe of selected) {
    process.stdout.write(`  ${probe.name.padEnd(20)} running... `);
    const r = await run(probe);
    results.push(r);
    log(`${r.code === 0 ? 'PASS' : 'FAIL'}  (${(r.ms / 1000).toFixed(1)}s)`);
  }

  log(`\n${'='.repeat(78)}`);
  log(`  ${'probe'.padEnd(20)} ${'result'.padEnd(8)} what it proves`);
  log(`  ${'-'.repeat(20)} ${'-'.repeat(8)} ${'-'.repeat(44)}`);
  for (const r of results)
    log(`  ${r.name.padEnd(20)} ${(r.code === 0 ? 'PASS' : 'FAIL').padEnd(8)} ${r.what}`);

  const failed = results.filter((r) => r.code !== 0);
  if (failed.length > 0) {
    log(`\n${'='.repeat(78)}`);
    log(`Output from the ${failed.length} failing probe(s):\n`);
    for (const r of failed) {
      log(`--- ${r.name} (exit ${r.code}) ${'-'.repeat(Math.max(0, 60 - r.name.length))}`);
      log(r.out.trimEnd());
      log('');
    }
  }

  log(`\n${results.length - failed.length}/${results.length} probes passed.`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().then(undefined, (e) => {
  console.error(e);
  process.exit(2);
});
