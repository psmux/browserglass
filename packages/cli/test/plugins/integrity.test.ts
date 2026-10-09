import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestsMatch, hashPluginFile, verifyPluginFile } from '../../src/plugins/integrity.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Each call gets its own temp directory, so two fixtures written in the same test never share a path. */
function writeFixture(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-integrity-test-'));
  dirs.push(dir);
  const path = join(dir, 'plugin.mjs');
  writeFileSync(path, contents, 'utf8');
  return path;
}

describe('hashPluginFile', () => {
  it('hashes a known input to its known sha512 digest', () => {
    const path = writeFixture('export default { id: "fixture" };\n');
    const expected = `sha512-${createHash('sha512').update('export default { id: "fixture" };\n').digest('base64')}`;
    expect(hashPluginFile(path)).toBe(expected);
  });

  it('is deterministic across repeated calls on the same file', () => {
    const path = writeFixture('same bytes every time');
    expect(hashPluginFile(path)).toBe(hashPluginFile(path));
  });

  it('produces a different digest for a different file', () => {
    const a = writeFixture('content a');
    const b = writeFixture('content b');
    expect(hashPluginFile(a)).not.toBe(hashPluginFile(b));
  });
});

describe('digestsMatch', () => {
  it('reports true for two equal well formed digests', () => {
    const digest = hashPluginFile(writeFixture('identical'));
    expect(digestsMatch(digest, digest)).toBe(true);
  });

  it('rejects a mismatched digest', () => {
    const a = hashPluginFile(writeFixture('one'));
    const b = hashPluginFile(writeFixture('two'));
    expect(digestsMatch(a, b)).toBe(false);
  });

  it('rejects a digest missing the sha512- prefix', () => {
    const digest = hashPluginFile(writeFixture('prefixed'));
    const payload = digest.slice('sha512-'.length);
    expect(digestsMatch(digest, payload)).toBe(false);
  });

  it('rejects a malformed (non base64) digest without throwing', () => {
    const digest = hashPluginFile(writeFixture('malformed'));
    expect(digestsMatch(digest, 'sha512-not*valid*base64!!')).toBe(false);
    expect(digestsMatch('sha512-not*valid*base64!!', digest)).toBe(false);
  });

  it('rejects an empty digest payload without throwing', () => {
    expect(digestsMatch('sha512-', 'sha512-')).toBe(false);
  });
});

describe('verifyPluginFile', () => {
  it('accepts a file against its own freshly computed digest', () => {
    const path = writeFixture('trusted contents');
    const digest = hashPluginFile(path);
    expect(verifyPluginFile(path, digest)).toBe(true);
  });

  it('rejects a file whose bytes changed after the digest was recorded', () => {
    const path = writeFixture('original contents');
    const recorded = hashPluginFile(path);
    writeFileSync(path, 'tampered contents', 'utf8');
    expect(verifyPluginFile(path, recorded)).toBe(false);
  });
});
