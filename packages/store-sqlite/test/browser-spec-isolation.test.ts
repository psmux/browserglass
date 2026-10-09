import { describe, expect, it } from 'vitest';
import { freshStore } from './helpers.js';

/**
 * `upsertBrowserSpec` is content addressed (`digestOfSpec`, `store.ts`):
 * two calls that hash the same land on the same row. `isolation` has to be
 * one of the hashed fields, or a `'tab'` spec and an otherwise identical
 * `'window'` spec would collapse onto one row and whichever was written
 * first would silently win forever.
 */
describe('browser_specs.isolation', () => {
  const BASE = {
    engine: 'chromium' as const,
    channel: 'chrome' as const,
    headless: 'new' as const,
    viewportW: 1280,
    viewportH: 720,
    dpr: 1,
    locale: null,
    timezone: null,
    userAgent: null,
    proxy: null,
    args: [],
    extensions: [],
    stealth: 'off' as const,
    limits: {},
  };

  it('two specs differing only in isolation produce two distinct spec ids', async () => {
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });

    const tabSpec = await f.store.upsertBrowserSpec(tenant.id, { ...BASE, isolation: 'tab' });
    const windowSpec = await f.store.upsertBrowserSpec(tenant.id, { ...BASE, isolation: 'window' });

    expect(tabSpec.id).not.toBe(windowSpec.id);
    expect(tabSpec.digest).not.toBe(windowSpec.digest);

    f.cleanup();
  });

  it('omitting isolation hashes the same as isolation: tab, the historical meaning of an unset value', async () => {
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });

    const omitted = await f.store.upsertBrowserSpec(tenant.id, { ...BASE });
    const explicitTab = await f.store.upsertBrowserSpec(tenant.id, { ...BASE, isolation: 'tab' });

    expect(omitted.id).toBe(explicitTab.id);

    f.cleanup();
  });

  it('round-trips isolation: window through getBrowserSpec and storedSpecToBrowserSpec', async () => {
    const { storedSpecToBrowserSpec } = await import('../src/mappers.js');
    const f = freshStore();
    const tenant = await f.store.createTenant({ name: 'Acme' });

    const written = await f.store.upsertBrowserSpec(tenant.id, { ...BASE, isolation: 'window' });
    const read = await f.store.getBrowserSpec(tenant.id, written.id);

    expect(read?.isolation).toBe('window');
    expect(storedSpecToBrowserSpec(read!).isolation).toBe('window');

    f.cleanup();
  });

  it('the isolation column defaults to tab, so a spec written before this column existed keeps its meaning', () => {
    const f = freshStore();
    const info = f.db
      .prepare("SELECT dflt_value FROM pragma_table_info('browser_specs') WHERE name = 'isolation'")
      .get() as { dflt_value: string } | undefined;
    expect(info?.dflt_value).toBe("'tab'");
    f.cleanup();
  });
});
