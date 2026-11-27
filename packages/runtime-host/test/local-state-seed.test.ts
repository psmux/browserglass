/**
 * The Local State seed and the guard against unseeded Chrome starts. Runs
 * on every OS: `prepareLocalState` takes the platform as an option, so the
 * Windows path is exercised here without starting any Chrome.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  UnseededProfileError,
  prepareLocalState,
  profileHasPasswordCheckAnswer,
  seedProfileLocalState,
  seedRequired,
} from '../src/local-state-seed.js';
import { spawnDetachedChrome } from '../src/spawn.js';

const ANSWER = {
  is_biometric_avaliable: false,
  os_password_blank: false,
  os_password_last_changed: '13427408052738199',
};
const TRUSTED = {
  browser: { x: 1 },
  variations_country: 'zz',
  variations_seed_date: '1',
  variations_last_fetch_time: '1',
  password_manager: ANSWER,
};

let work: string;
let priorSeed: string | undefined;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'bgls-seed-test-'));
  priorSeed = process.env['BGLS_LOCAL_STATE_SEED'];
  process.env['BGLS_LOCAL_STATE_SEED'] = join(work, 'seed.json');
});

afterEach(() => {
  if (priorSeed === undefined) delete process.env['BGLS_LOCAL_STATE_SEED'];
  else process.env['BGLS_LOCAL_STATE_SEED'] = priorSeed;
  rmSync(work, { recursive: true, force: true });
});

function udd(name: string, localState?: unknown): string {
  const dir = join(work, name);
  mkdirSync(dir, { recursive: true });
  if (localState !== undefined) writeFileSync(join(dir, 'Local State'), JSON.stringify(localState));
  return dir;
}

const args = (dir: string) => [`--user-data-dir=${dir}`, '--headless=new', 'about:blank'];
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

describe('seedProfileLocalState', () => {
  it('gives a fresh profile the whole seed', () => {
    writeFileSync(process.env['BGLS_LOCAL_STATE_SEED']!, JSON.stringify(TRUSTED));
    const fresh = udd('fresh');
    expect(seedProfileLocalState(fresh)).toBe('seeded');
    expect(JSON.parse(readFileSync(join(fresh, 'Local State'), 'utf8'))).toEqual(TRUSTED);
    expect(profileHasPasswordCheckAnswer(fresh)).toBe(true);
  });

  it('merges the answer into a Local State without one and keeps what was there', () => {
    writeFileSync(process.env['BGLS_LOCAL_STATE_SEED']!, JSON.stringify(TRUSTED));
    const bare = udd('bare', { browser: { mine: true }, password_manager: { other: 1 } });
    expect(seedProfileLocalState(bare)).toBe('seeded');
    const s = JSON.parse(readFileSync(join(bare, 'Local State'), 'utf8'));
    expect(s.browser).toEqual({ mine: true });
    expect(s.password_manager).toEqual({ other: 1, ...ANSWER });
  });

  it('leaves a profile that answers alone, and an unreadable one to Chrome', () => {
    writeFileSync(process.env['BGLS_LOCAL_STATE_SEED']!, JSON.stringify(TRUSTED));
    const answered = udd('answered', { password_manager: { os_password_blank: true, os_password_last_changed: '2' } });
    expect(seedProfileLocalState(answered)).toBe('had-answer');
    const broken = udd('broken');
    writeFileSync(join(broken, 'Local State'), '{not json');
    expect(seedProfileLocalState(broken)).toBe('unreadable');
  });

  it('does not use a seed Chrome would not trust (no variations fetched yet)', () => {
    writeFileSync(process.env['BGLS_LOCAL_STATE_SEED']!, JSON.stringify({ password_manager: ANSWER }));
    const fresh = udd('fresh');
    expect(seedProfileLocalState(fresh)).toBe('no-seed');
    expect(existsSync(join(fresh, 'Local State'))).toBe(false);
  });
});

describe('prepareLocalState, the guard before every Chrome start', () => {
  it('is on under the test runner', () => {
    expect(seedRequired()).toBe(true);
  });

  it('seeds on Windows before Chrome starts', () => {
    writeFileSync(process.env['BGLS_LOCAL_STATE_SEED']!, JSON.stringify(TRUSTED));
    const fresh = udd('fresh');
    expect(prepareLocalState(CHROME, args(fresh), { platform: 'win32' })).toBe('seeded');
    expect(profileHasPasswordCheckAnswer(fresh)).toBe(true);
  });

  it('fails loudly on Windows when the profile would start unseeded', () => {
    const fresh = udd('fresh');
    expect(() => prepareLocalState(CHROME, args(fresh), { platform: 'win32' })).toThrow(UnseededProfileError);
    expect(() => prepareLocalState(CHROME, ['about:blank'], { platform: 'win32' })).toThrow(UnseededProfileError);
  });

  it('does nothing off Windows, and nothing for the headless shell', () => {
    const fresh = udd('fresh');
    expect(prepareLocalState('/opt/chrome/chrome', args(fresh), { platform: 'linux' })).toBe('skipped');
    expect(prepareLocalState('C:\\pw\\chrome-headless-shell.exe', args(fresh), { platform: 'win32' })).toBe('skipped');
    expect(existsSync(join(fresh, 'Local State'))).toBe(false);
  });

  it.runIf(process.platform === 'win32')('spawnDetachedChrome refuses an unseeded profile before anything starts', () => {
    const fresh = udd('fresh');
    expect(() => spawnDetachedChrome({ binaryPath: CHROME, args: args(fresh), env: {} })).toThrow(UnseededProfileError);
  });
});
