import { describe, expect, it } from 'vitest';
import { BACKGROUNDING_FLAGS, buildLaunchArgs } from '../src/flags.js';
import { fixtureBrowserSpec } from './fixtures.js';

describe('buildLaunchArgs, the backgrounding triad', () => {
  it('always includes all three backgrounding flags together', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'C:\\profiles\\p1',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    for (const flag of BACKGROUNDING_FLAGS) {
      expect(args).toContain(flag);
    }
    expect(BACKGROUNDING_FLAGS).toHaveLength(3);
  });

  it('includes the Windows occlusion fix alongside the backgrounding triad', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'C:\\profiles\\p1',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    const features = args.filter((a) => a.startsWith('--disable-features='));
    expect(features).toHaveLength(1);
    expect(features[0]?.split('=')[1]?.split(',')).toContain('CalculateNativeWinOcclusion');
  });
});

/**
 * The launch flags this runtime passes so an unattended Chrome never stops
 * in front of a dialog, and the five it deliberately stopped passing.
 *
 * Both halves are asserted, because both halves are decisions somebody
 * could undo by accident. See `flags.ts`'s own `UNATTENDED_DIALOG_FLAGS`
 * and `UNCONDITIONAL_BASE_FLAGS` doc comments for the reasoning behind
 * each entry; the tests here only pin the outcome.
 */
describe('buildLaunchArgs, the unattended browser', () => {
  const argsFor = () =>
    buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'C:\\profiles\\p1',
      profileMode: 'persistent',
      allowNoSandbox: false,
    }).args;

  it('suppresses the crash restore bubble and the profile error dialog', () => {
    const args = argsFor();
    expect(args).toContain('--noerrdialogs');
    expect(args).toContain('--hide-crash-restore-bubble');
    expect(args).toContain('--disable-session-crashed-bubble');
  });

  it('suppresses the search engine choice screen and sync, as patchright does', () => {
    const args = argsFor();
    expect(args).toContain('--disable-search-engine-choice-screen');
    expect(args).toContain('--disable-sync');
  });

  /**
   * Exactly one `--disable-features=`, ever. Chrome keeps only the last
   * occurrence on a command line and silently discards the earlier ones,
   * so a second one added anywhere does not extend the list, it replaces
   * it. This test is the guard against that being done by accident.
   */
  it('emits exactly one --disable-features, carrying every feature it disables', () => {
    const args = argsFor();
    const features = args.filter((a) => a.startsWith('--disable-features='));
    expect(features).toHaveLength(1);
    const names = features[0]?.split('=')[1]?.split(',') ?? [];
    expect(names).toEqual(
      expect.arrayContaining([
        'CalculateNativeWinOcclusion',
        'InfiniteSessionRestore',
        'PasswordManagerOnboarding',
      ]),
    );
  });

  /**
   * The five Playwright inherited flags patchright strips and this runtime
   * now strips too. `--disable-popup-blocking` is the one a page can
   * actually read (open a window from a timer, with no gesture, and see
   * whether it works), which is why it is named first.
   */
  it('passes none of the five flags patchright strips from Playwright', () => {
    const args = argsFor();
    for (const flag of [
      '--disable-popup-blocking',
      '--disable-ipc-flooding-protection',
      '--disable-client-side-phishing-detection',
      '--disable-component-update',
      '--metrics-recording-only',
    ]) {
      expect(args).not.toContain(flag);
    }
  });

  /**
   * The one flag on this axis that does all the work, and the reason
   * `BASIC_STEALTH_PROFILE`'s JavaScript override is unnecessary as well
   * as harmful. Unconditional, at every stealth level including `'off'`.
   */
  it('always disables the AutomationControlled Blink feature, at every stealth level', () => {
    for (const stealth of ['off', 'basic', 'full'] as const) {
      const { args } = buildLaunchArgs({
        spec: { ...fixtureBrowserSpec(), stealth },
        profilePath: 'p',
        profileMode: 'persistent',
        allowNoSandbox: false,
      });
      expect(args).toContain('--disable-blink-features=AutomationControlled');
    }
  });
});

describe('buildLaunchArgs, base composition', () => {
  it('always sets --user-data-dir and --remote-debugging-port=0 explicitly', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'C:\\profiles\\p1',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).toContain('--user-data-dir=C:\\profiles\\p1');
    expect(args).toContain('--remote-debugging-port=0');
  });

  it('never passes --disable-gpu by default', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).not.toContain('--disable-gpu');
  });

  it('passes --disable-gpu only when told a prior GPU init failure was observed', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
      disableGpu: true,
    });
    expect(args).toContain('--disable-gpu');
  });

  it('never passes --single-process', () => {
    const { args } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).not.toContain('--single-process');
  });

  it('never passes --no-sandbox unless allowNoSandbox is explicitly true', () => {
    const withoutFlag = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(withoutFlag.args).not.toContain('--no-sandbox');
    const withFlag = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: true,
    });
    expect(withFlag.args).toContain('--no-sandbox');
  });

  it('adds --headless=new only for headless mode new, and never the legacy bare --headless spelling', () => {
    const headlessNew = buildLaunchArgs({
      spec: fixtureBrowserSpec({ headless: 'new' }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(headlessNew.args).toContain('--headless=new');
    expect(headlessNew.args.some((a) => a === '--headless')).toBe(false);

    const off = buildLaunchArgs({
      spec: fixtureBrowserSpec({ headless: 'off' }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(off.args.some((a) => a.startsWith('--headless'))).toBe(false);
  });

  it('sets TZ in env when spec.timezoneId is set', () => {
    const { env } = buildLaunchArgs({
      spec: fixtureBrowserSpec({ timezoneId: 'America/New_York' }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(env['TZ']).toBe('America/New_York');
  });
});

describe('buildLaunchArgs, ephemeral footprint', () => {
  it('adds the smaller-footprint flags only for ephemeral profiles', () => {
    const ephemeral = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'ephemeral',
      allowNoSandbox: false,
    });
    expect(ephemeral.args).toContain('--disk-cache-size=67108864');

    const persistent = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(persistent.args).not.toContain('--disk-cache-size=67108864');
  });
});

describe('buildLaunchArgs, ARG_ALLOW / ARG_DENY screening', () => {
  it('passes through an allow-listed extra arg', () => {
    const { args, deniedExtraArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec({ extraArgs: ['--disable-gpu'] }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).toContain('--disable-gpu');
    expect(deniedExtraArgs).toHaveLength(0);
  });

  it('rejects a denied extra arg and reports it, deny winning over anything else', () => {
    const { args, deniedExtraArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec({ extraArgs: ['--no-sandbox', '--user-data-dir=/tmp/evil'] }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).not.toContain('--no-sandbox');
    expect(args.some((a) => a.includes('/tmp/evil'))).toBe(false);
    expect(deniedExtraArgs.map((d) => d.arg)).toEqual([
      '--no-sandbox',
      '--user-data-dir=/tmp/evil',
    ]);
  });

  it('rejects an extra arg on neither list', () => {
    const { args, deniedExtraArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec({ extraArgs: ['--some-unknown-flag'] }),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(args).not.toContain('--some-unknown-flag');
    expect(deniedExtraArgs).toHaveLength(1);
  });
});

describe('buildLaunchArgs, stealthArgs ARG_ALLOW / ARG_DENY screening', () => {
  it('passes through an allow-listed stealth arg, same screening as extraArgs', () => {
    const { args, deniedStealthArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
      stealthArgs: ['--hide-scrollbars'],
    });
    expect(args).toContain('--hide-scrollbars');
    expect(deniedStealthArgs).toHaveLength(0);
  });

  it('rejects a stealth arg ARG_DENY blocks, reporting it separately from deniedExtraArgs', () => {
    const { args, deniedStealthArgs, deniedExtraArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
      stealthArgs: ['--no-sandbox'],
    });
    expect(args).not.toContain('--no-sandbox');
    expect(deniedStealthArgs.map((d) => d.arg)).toEqual(['--no-sandbox']);
    expect(deniedExtraArgs).toHaveLength(0);
  });

  it('rejects a stealth arg on neither list, the same as an unknown extraArgs entry', () => {
    const { args, deniedStealthArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
      stealthArgs: ['--some-unknown-stealth-flag'],
    });
    expect(args).not.toContain('--some-unknown-stealth-flag');
    expect(deniedStealthArgs).toHaveLength(1);
  });

  it('omitting stealthArgs entirely behaves exactly as an empty array', () => {
    const { deniedStealthArgs } = buildLaunchArgs({
      spec: fixtureBrowserSpec(),
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(deniedStealthArgs).toHaveLength(0);
  });
});

describe('BrowserSpec.userAgent reaches the command line', () => {
  // Regression guard. This field was accepted by the API, persisted, read
  // back, and compared for instance reuse, and then never emitted by this
  // runtime, so a caller asking for a user agent got Chrome's default and
  // no error. That silence is the whole problem: a bot check failing
  // because of an unset user agent looks nothing like a dropped field.
  it('emits --user-agent when the spec names one', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 TestAgent/1.0',
      },
      profilePath: 'C:profilesp1',
      profileMode: 'ephemeral',
      allowNoSandbox: false,
    });
    expect(built.args).toContain(
      '--user-agent=Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 TestAgent/1.0',
    );
  });

  it('emits no --user-agent at all when the spec leaves it null', () => {
    const built = buildLaunchArgs({
      spec: { ...fixtureBrowserSpec(), userAgent: null },
      profilePath: 'C:profilesp1',
      profileMode: 'ephemeral',
      allowNoSandbox: false,
    });
    expect(built.args.some((a) => a.startsWith('--user-agent'))).toBe(false);
  });
});

/**
 * `BrowserSpec.proxy` reaching the command line. Launch flags only:
 * `--proxy-server` and `--proxy-bypass-list`. `username`/`password` are
 * scoped to the CDP auth layer another package owns, so this file never
 * emits anything for them; see `flags.ts`'s own comment on the `proxy`
 * block for why.
 */
describe('BrowserSpec.proxy reaches the command line', () => {
  it('emits --proxy-server when the spec names one', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        proxy: {
          server: 'http://proxy.example.test:8080',
          bypass: [],
          username: null,
          password: null,
        },
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(built.args).toContain('--proxy-server=http://proxy.example.test:8080');
  });

  it('emits a semicolon separated --proxy-bypass-list only when bypass is non-empty', () => {
    const withBypass = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        proxy: {
          server: 'http://proxy.example.test:8080',
          bypass: ['*.internal.test', '127.0.0.1'],
          username: null,
          password: null,
        },
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(withBypass.args).toContain('--proxy-bypass-list=*.internal.test;127.0.0.1');

    const withoutBypass = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        proxy: {
          server: 'http://proxy.example.test:8080',
          bypass: [],
          username: null,
          password: null,
        },
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(withoutBypass.args.some((a) => a.startsWith('--proxy-bypass-list'))).toBe(false);
  });

  it('emits neither proxy flag when the spec has no proxy', () => {
    const built = buildLaunchArgs({
      spec: { ...fixtureBrowserSpec(), proxy: null },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(
      built.args.some((a) => a.startsWith('--proxy-server') || a.startsWith('--proxy-bypass-list')),
    ).toBe(false);
  });

  it('never emits a proxy flag carrying username or password', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        proxy: {
          server: 'http://proxy.example.test:8080',
          bypass: [],
          username: 'alice',
          password: 'secret',
        },
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(built.args.some((a) => a.includes('alice') || a.includes('secret'))).toBe(false);
  });
});

/**
 * `BrowserSpec.extensions` reaching the command line. Only `kind: 'path'`
 * (an unpacked directory) maps to a real Chrome flag; `crx` and `storeId`
 * entries are accepted by the type but produce no flag, matching
 * `capabilities()`'s `extensions.crx: false`.
 */
describe('BrowserSpec.extensions reaches the command line', () => {
  it('emits --load-extension and --disable-extensions-except for kind: path entries, same path list', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        extensions: [
          { kind: 'path', value: 'C:\\ext\\one', trusted: true },
          { kind: 'path', value: 'C:\\ext\\two', trusted: true },
        ],
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(built.args).toContain('--load-extension=C:\\ext\\one,C:\\ext\\two');
    expect(built.args).toContain('--disable-extensions-except=C:\\ext\\one,C:\\ext\\two');
  });

  it('emits neither extension flag when spec.extensions is empty', () => {
    const built = buildLaunchArgs({
      spec: { ...fixtureBrowserSpec(), extensions: [] },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(
      built.args.some(
        (a) => a.startsWith('--load-extension') || a.startsWith('--disable-extensions-except'),
      ),
    ).toBe(false);
  });

  it('skips kind: crx and kind: storeId entries; no flag installs either', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        extensions: [
          { kind: 'crx', value: 'C:\\ext\\packed.crx', trusted: true },
          { kind: 'storeId', value: 'abcdefghijklmnopabcdefghijklmnop', trusted: true },
        ],
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(
      built.args.some(
        (a) => a.startsWith('--load-extension') || a.startsWith('--disable-extensions-except'),
      ),
    ).toBe(false);
  });

  it('mixes kinds correctly: only the path entries reach --load-extension', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        extensions: [
          { kind: 'crx', value: 'C:\\ext\\packed.crx', trusted: true },
          { kind: 'path', value: 'C:\\ext\\one', trusted: true },
        ],
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(built.args).toContain('--load-extension=C:\\ext\\one');
    expect(built.args.some((a) => a.includes('packed.crx'))).toBe(false);
  });

  /**
   * The security point the task turned on this file for: `arg-lists.ts`'s
   * `ARG_DENY` has `--load-extension` and `--disable-extensions-except` on
   * it specifically so an app cannot smuggle either through `extraArgs`.
   * Only the structured, operator-controlled `spec.extensions` field (never
   * request-overridable, `settings.ts`'s `NEVER_OVERRIDABLE`) may produce
   * either flag. This test proves the denylist still wins even once
   * `buildLaunchArgs` itself knows how to emit both flags.
   */
  it('still rejects --load-extension and --disable-extensions-except from extraArgs, denylist wins', () => {
    const built = buildLaunchArgs({
      spec: {
        ...fixtureBrowserSpec(),
        extraArgs: ['--load-extension=C:\\evil\\ext', '--disable-extensions-except=C:\\evil\\ext'],
      },
      profilePath: 'p',
      profileMode: 'persistent',
      allowNoSandbox: false,
    });
    expect(built.args.some((a) => a.includes('evil'))).toBe(false);
    expect(built.deniedExtraArgs.map((d) => d.arg)).toEqual([
      '--load-extension=C:\\evil\\ext',
      '--disable-extensions-except=C:\\evil\\ext',
    ]);
  });
});
