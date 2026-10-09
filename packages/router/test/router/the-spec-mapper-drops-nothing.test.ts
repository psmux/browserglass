import type { BrowserSpec, StoredBrowserSpec } from '@browserglass/protocol';
import { DEFAULT_BROWSER_SPEC } from '@browserglass/protocol';
/**
 * `toStoredSpecInput` must carry every content addressed field of a
 * `BrowserSpec` into the row `upsertBrowserSpec` writes, and this file is
 * built to fail when a NEW field is added to the schema and forgotten in
 * the mapper, rather than only when the two fields already forgotten are.
 *
 * Two fields have been dropped there so far. `clientHints` was dropped
 * once. A comment was written on it recording the incident, and then
 * `initScripts` was added to the schema and dropped in exactly the same
 * way, which cost a 2,860 character `initScripts` payload its trip to the
 * page: the pool row held the scripts, `rowToPool` carried them into
 * `pool.template`, `overlayFullSpec` returned them, the mapper silently
 * discarded them, `doAcquire` filed the instance against a second spec row
 * with `init_scripts` null, and `createTargetRegistry` was handed an empty
 * array. Nothing raised anywhere. A comment did not stop the second
 * occurrence, so the defence is now a type plus this test.
 *
 * WHY THE ASSERTION IS SHAPED THE WAY IT IS. Naming the fields it checks
 * would reproduce the original bug in the test: a field added to the
 * schema and forgotten in the mapper would also be forgotten in the list,
 * and the suite would stay green. So nothing here names a field. It writes
 * two specs, one default and one in which every content addressed field
 * has been changed to something else, reads BOTH rows back out of SQLite,
 * and requires every column the SCHEMA defines to differ between them.
 *
 * The key set therefore comes from the database, not from this file. A
 * dropped field is stored as null for both specs, so its column is EQUAL
 * across the two rows, and the loop fails naming that column. That is true
 * for a field nobody has written yet as much as for `initScripts`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { toStoredSpecInput } from '../../src/router/specMapping.js';
import {
  type Basics,
  type StoreFixture,
  freshRouterStore,
  seedBasics,
} from '../profiles/support/testStore.js';

/**
 * A spec whose every content addressed field differs from
 * `DEFAULT_BROWSER_SPEC`. Fields the `browser_specs` table has no column
 * for (`geolocation`, `env`, `colorScheme` and the rest) are left alone:
 * they are not persisted and are not what this test is about.
 */
const VARIED: BrowserSpec = {
  ...DEFAULT_BROWSER_SPEC,
  channel: 'chrome-beta',
  headless: 'off',
  isolation: 'window',
  viewport: { width: 1024, height: 768, deviceScaleFactor: 2 },
  locale: 'en-GB',
  timezoneId: 'Europe/London',
  userAgent: 'Mozilla/5.0 (varied)',
  clientHints: { brands: [{ brand: 'Chromium', version: '128' }], platform: 'Windows' },
  initScripts: [{ name: 'block-submit', source: 'window.__blocked = true;' }],
  proxy: {
    server: 'http://proxy.test:8080',
    bypass: ['localhost'],
    username: null,
    password: null,
  },
  extraArgs: ['--some-flag'],
  extensions: [{ kind: 'path', value: '/tmp/ext', trusted: true }],
  stealth: 'basic',
  resources: { cpus: 2, memoryMb: 2048, shmMb: 256, pidsLimit: 512 },
  launchTimeoutMs: 60_000,
  remoteEndpointName: 'varied-endpoint',
} as BrowserSpec;

/** Set by the row's identity or by the engine, so they cannot vary with the spec's content. */
const NOT_CONTENT = new Set(['id', 'tenantId', 'createdAt', 'engine']);

describe('toStoredSpecInput carries every persisted field', () => {
  let fixture: StoreFixture;
  let basics: Basics;

  beforeEach(async () => {
    fixture = await freshRouterStore();
    basics = await seedBasics(fixture.store);
  });

  afterEach(async () => {
    await fixture.cleanup();
  });

  it('changes every column the browser_specs schema defines when every field of the spec changes', async () => {
    const tenantId = basics.tenantId;

    const baseRow = await fixture.store.upsertBrowserSpec(
      tenantId,
      toStoredSpecInput(DEFAULT_BROWSER_SPEC),
    );
    const variedRow = await fixture.store.upsertBrowserSpec(tenantId, toStoredSpecInput(VARIED));

    // Read back through the store rather than trusting the objects just
    // written: the round trip is where a field that the mapper set but the
    // INSERT never persisted would be lost, and that is a different bug
    // from the one above with the same symptom.
    const base = (await fixture.store.getBrowserSpec(tenantId, baseRow.id)) as StoredBrowserSpec;
    const varied = (await fixture.store.getBrowserSpec(
      tenantId,
      variedRow.id,
    )) as StoredBrowserSpec;
    expect(base).not.toBeNull();
    expect(varied).not.toBeNull();

    const identical: string[] = [];
    for (const key of Object.keys(varied)) {
      if (NOT_CONTENT.has(key)) continue;
      const a = JSON.stringify((base as unknown as Record<string, unknown>)[key]);
      const b = JSON.stringify((varied as unknown as Record<string, unknown>)[key]);
      if (a === b) identical.push(`${key} (both ${a})`);
    }

    expect(
      identical,
      'these persisted columns did not change when the spec did, which means toStoredSpecInput never wrote them',
    ).toEqual([]);
  });

  it('gives the two specs different digests, so they are not one content addressed row', async () => {
    // The consequence of a dropped field that bites hardest in production:
    // two specs that differ ONLY in the dropped field hash to the same
    // digest, so the second acquire silently reuses the first one's row.
    const tenantId = basics.tenantId;
    const withScripts = { ...DEFAULT_BROWSER_SPEC, initScripts: VARIED.initScripts } as BrowserSpec;

    const a = await fixture.store.upsertBrowserSpec(
      tenantId,
      toStoredSpecInput(DEFAULT_BROWSER_SPEC),
    );
    const b = await fixture.store.upsertBrowserSpec(tenantId, toStoredSpecInput(withScripts));

    expect(b.digest).not.toBe(a.digest);
    expect(b.id).not.toBe(a.id);
  });

  it('round trips the init scripts themselves, not merely a non-null column', async () => {
    const tenantId = basics.tenantId;
    const row = await fixture.store.upsertBrowserSpec(tenantId, toStoredSpecInput(VARIED));
    const read = (await fixture.store.getBrowserSpec(tenantId, row.id)) as StoredBrowserSpec;
    expect(read.initScripts).toEqual([
      { name: 'block-submit', source: 'window.__blocked = true;' },
    ]);
  });
});
