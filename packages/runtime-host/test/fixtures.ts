/** Shared test fixtures: a minimal, fully-populated `BrowserSpec`. */
import type { BrowserSpec } from '@browserglass/protocol';

export function fixtureBrowserSpec(overrides: Partial<BrowserSpec> = {}): BrowserSpec {
  return {
    engine: 'chromium',
    channel: 'chrome',
    executablePath: null,
    headless: 'new',
    viewport: { width: 1440, height: 900, deviceScaleFactor: 1 },
    window: null,
    // Historical single-window behaviour, matching this package's launch
    // flag tests, none of which exercise multi target streaming.
    isolation: 'tab',
    userAgent: null,
    clientHints: null,
    locale: null,
    timezoneId: null,
    geolocation: null,
    permissions: [],
    colorScheme: 'light',
    reducedMotion: 'no-preference',
    proxy: null,
    extraArgs: [],
    ignoreDefaultArgs: ['--disable-web-security'],
    env: {},
    extensions: [],
    stealth: 'off',
    initScripts: [],
    ignoreHttpsErrors: false,
    downloadDir: null,
    uploadDir: null,
    acceptDownloads: false,
    maxDownloadBytes: null,
    resources: { cpus: null, memoryMb: null, shmMb: null, pidsLimit: null },
    initialUrl: null,
    launchTimeoutMs: 45000,
    ...overrides,
  };
}
