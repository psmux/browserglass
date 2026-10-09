/**
 * `HostRuntime.capabilities()` regression guard. `runtime.ts:143` (before
 * this change) claimed `extensions: { unpacked: true, crx: true,
 * withHeadlessNew: false }` and `proxyPerInstance: false` while nothing in
 * `flags.ts` emitted `--load-extension` or `--proxy-server` at all, and
 * `crx` was never true either: no store mapper has ever produced an
 * `ExtensionRef` of kind `'crx'`, and no Chrome launch flag installs one
 * anyway. This file pins the corrected claim so a future edit to
 * `flags.ts` cannot silently reopen either gap.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type HostRuntime, createHostRuntime } from '../src/runtime.js';

const runtimes: HostRuntime[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshRuntime(): Promise<HostRuntime> {
  const base = mkdtempSync(join(tmpdir(), 'bgls-runtime-host-caps-'));
  dirs.push(base);
  const { runtime } = await createHostRuntime({
    nodeId: 'node-caps-test',
    stateDir: join(base, 'state'),
    profileRoot: join(base, 'profiles'),
  });
  runtimes.push(runtime);
  return runtime;
}

describe('HostRuntime.capabilities(), extensions and proxy honesty', () => {
  it('claims unpacked extensions and per-instance proxy, now that flags.ts wires both', async () => {
    const caps = (await freshRuntime()).capabilities();
    expect(caps.extensions.unpacked).toBe(true);
    expect(caps.proxyPerInstance).toBe(true);
  });

  it('does not claim crx extension support: no flag installs one and no store mapper ever produces that kind', async () => {
    const caps = (await freshRuntime()).capabilities();
    expect(caps.extensions.crx).toBe(false);
  });

  it('still does not claim withHeadlessNew, and says why in notes', async () => {
    const caps = (await freshRuntime()).capabilities();
    expect(caps.extensions.withHeadlessNew).toBe(false);
    expect(caps.notes.some((n) => n.includes('extensions.crx: false'))).toBe(true);
  });

  it('claims proxyAuthPerInstance only now that the credential is actually threaded, and the note names where', async () => {
    const caps = (await freshRuntime()).capabilities();
    // This flag was false for a while with a working CDP implementation
    // underneath it, because nothing fed `createTargetRegistry` the
    // credential. Not claiming it until it was true is the whole point of
    // the notes array, and the extensions claim being wrong in exactly the
    // other direction is what made that rule explicit.
    expect(caps.proxyAuthPerInstance).toBe(true);
    expect(caps.notes.some((n) => n.includes('proxyAuthCredentials'))).toBe(true);
    expect(caps.notes.some((n) => n.includes('Fetch.continueWithAuth'))).toBe(true);
  });
});
