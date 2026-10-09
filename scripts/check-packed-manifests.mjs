#!/usr/bin/env node
/**
 * Packs every publishable package and inspects the manifest inside the tarball,
 * which is the only artifact that tells you what consumers will actually get.
 *
 * Fails on:
 *   1. Any dependency range still carrying pnpm's `workspace:` protocol. npm and
 *      yarn classic reject it with EUNSUPPORTEDPROTOCOL, so a tarball with one
 *      of these in it is uninstallable for most of the ecosystem.
 *   2. A `@browserglass/*` dependency on a package that is `private`, and so
 *      will never exist on the registry.
 *   3. A missing LICENSE in the tarball.
 *   4. A version of `0.0.0`, which is the placeholder, not a release.
 *
 * Requires `pnpm -r build` first, because packing an unbuilt package produces a
 * tarball with no dist.
 *
 * Usage: node scripts/check-packed-manifests.mjs
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const PACKAGES_DIR = join(ROOT, 'packages');

const pkgDirs = readdirSync(PACKAGES_DIR, { withFileTypes: true })
  .filter((d) => d.isDirectory() && existsSync(join(PACKAGES_DIR, d.name, 'package.json')))
  .map((d) => d.name)
  .sort();

const manifests = new Map();
for (const dir of pkgDirs) {
  manifests.set(dir, JSON.parse(readFileSync(join(PACKAGES_DIR, dir, 'package.json'), 'utf8')));
}

const privateNames = new Set(
  [...manifests.values()].filter((m) => m.private === true).map((m) => m.name),
);

const failures = [];
const out = mkdtempSync(join(tmpdir(), 'bgls-pack-'));

try {
  for (const dir of pkgDirs) {
    const local = manifests.get(dir);
    if (local.private === true) {
      console.log(`skip   ${local.name} (private)`);
      continue;
    }

    execFileSync('pnpm', ['pack', '--pack-destination', out], {
      cwd: join(PACKAGES_DIR, dir),
      stdio: 'pipe',
      shell: process.platform === 'win32',
    });

    const tgz = readdirSync(out).find((f) =>
      f.startsWith(`${local.name.replace('@', '').replace('/', '-')}-`),
    );
    if (!tgz) {
      failures.push(`${local.name}: pnpm pack produced no tarball`);
      continue;
    }

    const listing = execFileSync('tar', ['-tzf', tgz], { cwd: out, encoding: 'utf8' });
    const packed = JSON.parse(
      execFileSync('tar', ['-xzOf', tgz, 'package/package.json'], { cwd: out, encoding: 'utf8' }),
    );

    const ranges = {
      ...packed.dependencies,
      ...packed.peerDependencies,
      ...packed.optionalDependencies,
    };
    for (const [dep, range] of Object.entries(ranges)) {
      if (typeof range === 'string' && range.includes('workspace:')) {
        failures.push(
          `${local.name}: dependency "${dep}" is still "${range}" inside the tarball; npm and yarn reject this with EUNSUPPORTEDPROTOCOL`,
        );
      }
      if (privateNames.has(dep)) {
        failures.push(
          `${local.name}: depends on "${dep}", which is private and will never be on the registry`,
        );
      }
    }

    if (packed.version === '0.0.0') {
      failures.push(`${local.name}: version is still the 0.0.0 placeholder`);
    }
    if (!listing.split('\n').some((l) => l.trim() === 'package/LICENSE')) {
      failures.push(`${local.name}: tarball contains no LICENSE`);
    }

    console.log(
      `ok     ${local.name}@${packed.version} (${Object.keys(ranges).length} ranges checked)`,
    );
  }
} finally {
  rmSync(out, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`\nPacked manifest violations:\n  ${failures.join('\n  ')}`);
  process.exit(1);
}
console.log(`\ncheck:packed passed (${pkgDirs.length} packages inspected)`);
