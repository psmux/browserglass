import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Chrome holds DevToolsActivePort open while it writes it, and on Windows a
// read in that window fails with EBUSY. The mock lets one test make the
// first read fail that way without needing a real Chrome to race.
const busyReads = { remaining: 0 };
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: ((...args: Parameters<typeof actual.readFileSync>) => {
      if (busyReads.remaining > 0 && String(args[0]).endsWith('DevToolsActivePort')) {
        busyReads.remaining -= 1;
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
      }
      return actual.readFileSync(...args);
    }) as typeof actual.readFileSync,
  };
});

const { waitForDevToolsActivePort } = await import('../src/cdp-endpoint.js');

const dirs: string[] = [];

afterEach(() => {
  busyReads.remaining = 0;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function profileWithPortFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'bgls-devtools-port-'));
  dirs.push(dir);
  writeFileSync(join(dir, 'DevToolsActivePort'), '9333\n/devtools/browser/abc\n');
  return dir;
}

describe('waitForDevToolsActivePort', () => {
  it('reads the port and browser path once the file is there', async () => {
    const found = await waitForDevToolsActivePort(profileWithPortFile(), Date.now() + 2000, 10);
    expect(found).toEqual({ port: 9333, browserPath: '/devtools/browser/abc' });
  });

  it('keeps polling through an EBUSY read instead of failing the launch', async () => {
    const dir = profileWithPortFile();
    busyReads.remaining = 2;
    const found = await waitForDevToolsActivePort(dir, Date.now() + 2000, 10);
    expect(found.port).toBe(9333);
    expect(busyReads.remaining).toBe(0);
  });
});
