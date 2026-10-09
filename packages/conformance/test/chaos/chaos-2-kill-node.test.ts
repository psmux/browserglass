/**
 * Chaos scenario 2: `kill -9` the node agent.
 * Assert: Chrome never restarted, tab URLs unchanged, zero orphans, zero
 * stranded leases.
 *
 * Scope note: this build's embedded
 * mode mints a fresh router `nodeId` on every `createBrowserGlass()`
 * `start()` call (`packages/server/src/lifecycle/wiring.ts`'s
 * `buildRouterWiring`), so there is no persistent node identity for the
 * *router* to reattach a profile lease against across a process restart
 * today; only `@browserglass/runtime-host`'s own startup
 * reattach (`reconcileOnStartup`, driven by its durable
 * `<stateDir>/runtime-host.json`) is the real, implemented mechanism a
 * fresh process uses to recover a survived Chrome. This test therefore
 * exercises that real mechanism directly, using a genuine second OS
 * process for "the node agent" (spawned via `node`, killed with
 * `SIGKILL`, never given the chance to run its own `dispose()`), which
 * is the literal chaos scenario, rather than `runtime-host`'s own unit
 * suite's `dispose()`-without-`killOnShutdown` simulation of the same
 * thing inside one process.
 */
import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newId } from '@browserglass/protocol';
import {
  type HostRuntime,
  chromeProcsForDataDir,
  createHostRuntime,
  killProcessTree,
} from '@browserglass/runtime-host';
import { afterEach, describe, expect, it } from 'vitest';
import { shortTempRoot } from '../e2e/support/real-gateway.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_SCRIPT = join(HERE, '..', 'e2e', 'support', 'node-agent-child.mjs');
const INITIAL_URL = 'data:text/html,<h1>chaos-scenario-2</h1>';

let workDir: string | undefined;
let childPid: number | undefined;
let chromePid: number | undefined;
let runtimeB: HostRuntime | undefined;

afterEach(async () => {
  if (runtimeB) {
    await runtimeB.dispose();
    runtimeB = undefined;
  }
  if (childPid !== undefined) {
    try {
      process.kill(childPid, 0); // still alive?
      killProcessTree(childPid, 'SIGKILL');
    } catch {
      // already gone
    }
    childPid = undefined;
  }
  // Safety net for a test that failed before reaching its own
  // `runtime.terminate()` call: `runtimeB.dispose()` above never kills
  // Chrome (`killOnShutdown` defaults false, deliberately, since chaos
  // scenario 2 is specifically about Chrome surviving), so a real Chrome
  // this test launched would otherwise leak, and its still-open profile
  // files would make the `rmSync` below fail with `EBUSY`.
  if (chromePid !== undefined) {
    try {
      killProcessTree(chromePid, 'SIGKILL');
    } catch {
      // already gone
    }
    chromePid = undefined;
  }
  if (workDir) {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // best effort: a just-killed Chrome can hold a file handle open for
      // a few hundred ms after the process itself is gone on Windows.
    }
    workDir = undefined;
  }
});

/** Spawns the real node-agent child process and waits for its one JSON status line. */
function spawnChildAgent(
  stateDir: string,
  profileRoot: string,
  nodeId: string,
  instanceId: string,
): Promise<{ pid: number; browserGuid: string; profilePath: string; cdpUrl: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [CHILD_SCRIPT, stateDir, profileRoot, nodeId, instanceId, INITIAL_URL],
      {
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    childPid = child.pid;
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(
      () => reject(new Error(`node agent child did not report ready in time. stderr: ${stderr}`)),
      45_000,
    );
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
      const newline = stdout.indexOf('\n');
      if (newline >= 0) {
        clearTimeout(timer);
        resolve(JSON.parse(stdout.slice(0, newline)));
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on('exit', (code, signal) => {
      if (stdout.indexOf('\n') < 0) {
        clearTimeout(timer);
        reject(
          new Error(
            `node agent child exited before reporting ready (code=${code}, signal=${signal}). stderr: ${stderr}`,
          ),
        );
      }
    });
  });
}

describe('chaos scenario 2: kill -9 the node agent, real Chrome, real reattach', () => {
  it('a fresh HostRuntime process reattaches after a SIGKILLed node agent: Chrome never restarted, tab URL unchanged, zero orphans, lease fence preserved', async () => {
    workDir = shortTempRoot('c2-');
    const stateDir = join(workDir, 's');
    const profileRoot = join(workDir, 'p');
    const nodeId = 'nod_chaos2test';
    const instanceId = newId('inst');

    const status = await spawnChildAgent(stateDir, profileRoot, nodeId, instanceId);
    expect(status.pid).toBeGreaterThan(0);
    expect(status.cdpUrl).toBeTruthy();
    chromePid = status.pid;

    // Confirm the tab really did navigate before the kill, so the
    // "unchanged" assertion after reattach is meaningful and not
    // vacuously true.
    const beforeList = (await fetch(`${status.cdpUrl}/json/list`).then((r) => r.json())) as Array<{
      url: string;
    }>;
    expect(beforeList.some((t) => t.url === INITIAL_URL)).toBe(true);

    // The literal chaos scenario: SIGKILL the NODE agent process
    // (`childPid`, this `node` child), never Chrome's own pid
    // (`status.pid`, chaos scenario 1's target). `childPid` stays
    // recorded for the `afterEach` safety net; on POSIX this is a
    // no-op once the process is already gone, and on Windows
    // `process.kill` with a signal name maps to `TerminateProcess`.
    process.kill(childPid!, 'SIGKILL');
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Chrome itself must have survived the node agent's death.
    const survivors = chromeProcsForDataDir(status.profilePath);
    expect(survivors.length).toBeGreaterThan(0);

    // A fresh process (this test process standing in for "a fresh node
    // agent") runs the real startup reattach algorithm against the
    // same durable state.
    const { runtime, reconcileReport } = await createHostRuntime({ nodeId, stateDir, profileRoot });
    runtimeB = runtime;

    expect(reconcileReport.orphansReaped).toBe(0);
    expect(reconcileReport.adoptedCount).toBeGreaterThanOrEqual(1);

    const list = await runtime.list();
    const adopted = list.find((e) => e.instanceId === instanceId);
    expect(adopted).toBeDefined();
    // Chrome never restarted: identical GUID and pid, not merely "a
    // browser is running".
    expect(adopted?.browserGuid).toBe(status.browserGuid);
    expect(adopted?.pid).toBe(status.pid);
    expect(adopted?.status).toBe('live');
    // The lease fence this instance was launched with survived the
    // crash intact (the stand-in for "zero stranded leases" here:
    // see this file's header comment on scope).
    expect(adopted?.profileFence).toBe(1);

    // Tab URL genuinely unchanged: Chrome was never asked to reload or
    // restart, so the same document is still there.
    const afterList = (await fetch(`${status.cdpUrl}/json/list`).then((r) => r.json())) as Array<{
      url: string;
    }>;
    expect(afterList.some((t) => t.url === INITIAL_URL)).toBe(true);

    // Zero orphans: every real Chrome process for this profile
    // directory is the one instance runtimeB now tracks.
    const stillTherePostReattach = chromeProcsForDataDir(status.profilePath);
    expect(stillTherePostReattach).toHaveLength(1);
    expect(stillTherePostReattach[0]?.pid).toBe(status.pid);

    // 'force' mode never touches CDP, so a bare {instanceId, pid} handle
    // is enough for this cleanup call. Followed by a direct
    // `killProcessTree` regardless of its outcome: a synthetic handle
    // built here rather than returned by a real `launch()` is missing
    // whatever internal bookkeeping `terminate()` normally relies on,
    // and this suite must never leave a real Chrome process behind
    // even if that bookkeeping gap means `terminate()` alone does not
    // fully clean up.
    await runtime
      .terminate({ instanceId, pid: status.pid, cdpWsUrl: '' } as never, 'force')
      .catch(() => undefined);
    try {
      killProcessTree(status.pid, 'SIGKILL');
    } catch {
      // already gone
    }
    childPid = undefined;
    chromePid = undefined;
  }, 120_000);
});
