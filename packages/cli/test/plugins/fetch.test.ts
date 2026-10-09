import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  PluginFetchError,
  fetchGitCommit,
  fetchLocalPlugin,
  fetchNpmPackage,
  fetchPlugin,
  parsePluginSource,
} from '../../src/plugins/fetch.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NPM_FIXTURE_DIR = join(__dirname, 'fixtures', 'npm-plugin');

const dirs: string[] = [];
function track(dir: string): string {
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/**
 * Builds a real, local, hermetic git repository with one commit, and
 * returns its path plus that commit's full sha. Used as the `url` for
 * every git test below: git's own local filesystem transport treats a
 * plain path as a first-class remote, so `fetchGitCommit` exercises the
 * exact `init` / `remote add` / `fetch --depth 1` / `checkout` sequence it
 * uses against a real server, with no network involved
 * (fetch mechanics are tested against a local fixture repository rather
 * than the network).
 */
function buildGitFixtureRepo(): { repoDir: string; sha: string } {
  const repoDir = track(mkdtempSync(join(tmpdir(), 'bgls-fetch-test-repo-')));
  const run = (args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' });
  run(['init', '--quiet', '.']);
  run(['config', 'user.email', 'fixture@example.invalid']);
  run(['config', 'user.name', 'fixture']);
  const distDir = join(repoDir, 'dist');
  mkdirSync(distDir);
  writeFileSync(
    join(repoDir, 'package.json'),
    JSON.stringify(
      { name: 'bgls-plugin-git-fixture', version: '1.0.0', main: 'dist/plugin.mjs' },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(
    join(distDir, 'plugin.mjs'),
    'export default { id: "bgls-plugin-git-fixture" };\n',
    'utf8',
  );
  run(['add', '-A']);
  run(['commit', '--quiet', '-m', 'init']);
  const sha = run(['rev-parse', 'HEAD']).trim();
  return { repoDir, sha };
}

describe('parsePluginSource: npm sources', () => {
  it('accepts a scoped package pinned to an exact version', () => {
    const result = parsePluginSource('@browserglass/plugin-video-export@0.2.1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toEqual({
        type: 'npm',
        name: '@browserglass/plugin-video-export',
        version: '0.2.1',
      });
    }
  });

  it('accepts an unscoped package pinned to an exact version', () => {
    const result = parsePluginSource('bgls-plugin-fixture@1.0.0');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toEqual({ type: 'npm', name: 'bgls-plugin-fixture', version: '1.0.0' });
    }
  });

  it('refuses a bare name with no version', () => {
    const result = parsePluginSource('bgls-plugin-fixture');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exact version/);
  });

  it('refuses "latest"', () => {
    const result = parsePluginSource('bgls-plugin-fixture@latest');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exact semver version/);
  });

  it('refuses a semver range', () => {
    const result = parsePluginSource('bgls-plugin-fixture@^1.0.0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exact semver version/);
  });
});

describe('parsePluginSource: git sources', () => {
  const SHA = 'a'.repeat(40);

  it('accepts git+https pinned to a full 40 character commit sha', () => {
    const result = parsePluginSource(`git+https://github.com/someone/bgls-plugin.git#${SHA}`);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toEqual({
        type: 'git',
        url: 'https://github.com/someone/bgls-plugin.git',
        commit: SHA,
      });
    }
  });

  it('refuses a branch', () => {
    const result = parsePluginSource('git+https://github.com/someone/bgls-plugin.git#main');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/branch or tag can move/);
  });

  it('refuses a tag', () => {
    const result = parsePluginSource('git+https://github.com/someone/bgls-plugin.git#v1.0.0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/branch or tag can move/);
  });

  it('refuses a short sha', () => {
    const result = parsePluginSource('git+https://github.com/someone/bgls-plugin.git#a1b2c3d');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/too short to be a full commit sha/);
  });

  it('refuses git+ssh', () => {
    const result = parsePluginSource(`git+ssh://git@github.com/someone/bgls-plugin.git#${SHA}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git\+https/);
  });

  it('refuses git:// with no git+ prefix', () => {
    const result = parsePluginSource(`git://github.com/someone/bgls-plugin.git#${SHA}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git\+https/);
  });

  it('refuses plain http://', () => {
    const result = parsePluginSource('http://example.com/plugin.tgz');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/git\+https/);
  });

  it('refuses a git source with no commit named after "#"', () => {
    const result = parsePluginSource('git+https://github.com/someone/bgls-plugin.git');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/must name a commit after "#"/);
  });
});

describe('parsePluginSource: local sources', () => {
  it('accepts a relative path, normalised to absolute', () => {
    const result = parsePluginSource('./my-plugin');
    expect(result.ok).toBe(true);
    if (result.ok && result.source.type === 'local') {
      expect(result.source.path.endsWith('my-plugin')).toBe(true);
      expect(result.source.path.startsWith('.')).toBe(false);
    }
  });
});

describe('parsePluginSource: malformed and injection-attempt sources', () => {
  it('refuses an empty spec', () => {
    const result = parsePluginSource('   ');
    expect(result.ok).toBe(false);
  });

  it('refuses a spec that is not a recognised npm name, git URL, or path', () => {
    const result = parsePluginSource('not a valid spec at all!!');
    expect(result.ok).toBe(false);
  });

  it('refuses an npm spec carrying a shell injection attempt in the version field', () => {
    const result = parsePluginSource('evil-package@1.0.0; rm -rf /');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/exact semver version/);
  });

  it('refuses a git URL carrying a shell injection attempt in the host/path', () => {
    const sha = 'b'.repeat(40);
    const result = parsePluginSource(`git+https://example.com/$(whoami)/repo.git#${sha}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid https git URL/);
  });

  it('refuses an npm package name containing shell metacharacters', () => {
    const result = parsePluginSource('$(touch pwned)@1.0.0');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/not a valid npm package name/);
  });

  // Node's built-in modules expose non-configurable exports under this
  // ESM/vitest setup, so `execFileSync` cannot be spied on here to prove
  // by instrumentation that parsing never calls it. The claim is instead
  // structural and verifiable by reading fetch.ts directly:
  // parsePluginSource (and every function it calls: refused,
  // parseNpmSource, parseGitHttpsSource, parseLocalSource) does not
  // import node:child_process at all. Every injection attempt above is
  // refused by a regular expression before there is anything to execute.
});

describe('fetchNpmPackage: hermetic extraction against a local fixture directory', () => {
  it('packs, extracts, and resolves the declared entry file', () => {
    const result = fetchNpmPackage(NPM_FIXTURE_DIR);
    track(result.cleanupDir as string);
    expect(result.resolved).toBe('1.0.0');
    expect(existsSync(result.entryPath)).toBe(true);
    expect(result.entryPath.endsWith(join('dist', 'plugin.mjs'))).toBe(true);
    const contents = readFileSync(result.entryPath, 'utf8');
    expect(contents).toContain('bgls-plugin-fixture');
  });

  it('parses into the exact source fetchPlugin would build the same "name@version" spec from', () => {
    // fetchPlugin's npm branch always builds "name@version" and would hit
    // the real registry for a real package name, so it is not exercised
    // end to end here; this asserts the parsed shape it would consume,
    // and the extraction path itself is covered by the hermetic
    // fetchNpmPackage test above.
    const parsed = parsePluginSource('bgls-plugin-fixture@1.0.0');
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.source).toEqual({ type: 'npm', name: 'bgls-plugin-fixture', version: '1.0.0' });
  });
});

describe('fetchGitCommit: hermetic clone against a local fixture repository', () => {
  it('clones at the pinned sha, strips .git, and resolves the entry file', () => {
    const { repoDir, sha } = buildGitFixtureRepo();
    const result = fetchGitCommit(repoDir, sha);
    track(result.cleanupDir as string);
    expect(result.resolved).toBe(sha.toLowerCase());
    expect(existsSync(result.entryPath)).toBe(true);
    expect(existsSync(join(result.cleanupDir as string, '.git'))).toBe(false);
    expect(readFileSync(result.entryPath, 'utf8')).toContain('bgls-plugin-git-fixture');
  });

  it('via fetchPlugin, for a parsed git source pointed at the local fixture', () => {
    const { repoDir, sha } = buildGitFixtureRepo();
    const result = fetchPlugin({ type: 'git', url: repoDir, commit: sha.toLowerCase() });
    track(result.cleanupDir as string);
    expect(result.resolved).toBe(sha.toLowerCase());
    expect(existsSync(result.entryPath)).toBe(true);
  });
});

describe('fetchLocalPlugin', () => {
  it('resolves the entry file of an already-local plugin with no fetch at all', () => {
    const result = fetchLocalPlugin(NPM_FIXTURE_DIR);
    expect(result.cleanupDir).toBeNull();
    expect(result.resolved).toBeNull();
    expect(existsSync(result.entryPath)).toBe(true);
  });

  it('throws PluginFetchError for a path that is not a directory', () => {
    expect(() => fetchLocalPlugin(join(NPM_FIXTURE_DIR, 'does-not-exist'))).toThrow(
      PluginFetchError,
    );
  });
});
