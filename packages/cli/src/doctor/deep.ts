/**
 * `bgls doctor --deep`: launches a real browser end to end, in about 8
 * seconds. Builds a throwaway embedded gateway, acquires an instance,
 * navigates to a self-contained test page, connects a lightweight internal
 * `bgls.v1` client (a raw `WebSocket` speaking the wire protocol directly;
 * `@browserglass/client`'s `BrowserGlassClient` needs a real DOM
 * `<canvas>` to decode/paint into, which a Node CLI does not have), starts
 * a stream, injects a click, and confirms a new, different frame arrives.
 * Everything is torn down (browser killed, gateway stopped, scratch
 * directory left for the OS temp cleaner) before this resolves.
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { CAPABILITIES, type Principal, decodeBinaryHeader } from '@browserglass/protocol';
import { killProcessTree, listAllChromeFamilyProcesses } from '@browserglass/runtime-host';
import { buildEmbeddedGateway } from '../gateway.js';
import { type DoctorCheckResult, timedCheck } from './types.js';

/**
 * Registers a last-resort `uncaughtException` handler for the duration of
 * `fn()`, so a crash inside the embedded gateway's own message handling
 * (this build's `@browserglass/server`, running in-process, can throw
 * uncaught out of a WS `message` event handler on a not-yet-attached CDP
 * target, confirmed directly: it kills the whole process before this
 * function's own `try`/`finally` ever runs) still reaps every Chrome
 * process this run's `dataDir` launched, rather than leaving it orphaned.
 * Re-throws afterward so the crash still surfaces as this check's
 * (unhelpful, but honest) failure detail.
 */
async function withCrashCleanup<T>(dataDir: string, fn: () => Promise<T>): Promise<T> {
  const onCrash = (err: unknown): void => {
    // `dataDir` (a short, random scratch root unique to this run) as a
    // plain substring match, not `chromeProcsForDataDir`'s exact
    // `--user-data-dir=<dataDir>` match: the actual value that flag
    // carries is a nested subdirectory of `dataDir`
    // (`<dataDir>/profiles/tenants/<id>/profiles/<id>/udd`), which this
    // function has no reason to know precisely at the moment a crash
    // reaches it.
    for (const proc of listAllChromeFamilyProcesses()) {
      if (proc.commandLine.includes(dataDir)) killProcessTree(proc.pid, 'SIGKILL');
    }
    process.stderr.write(
      `bgls doctor --deep: gateway crashed, reaped its Chrome process(es): ${err instanceof Error ? err.stack : String(err)}\n`,
    );
    process.exit(1);
  };
  process.on('uncaughtException', onCrash);
  try {
    return await fn();
  } finally {
    process.off('uncaughtException', onCrash);
  }
}

/**
 * A throwaway scratch directory, short enough that
 * `tenants/<tenantId>/profiles/<profileId>/udd` (about 85 characters on
 * its own) still lands under `runtime-host`'s 120 character Windows
 * profile-root guard. `os.tmpdir()` alone is already 40+ characters deep
 * on a typical Windows user profile (confirmed on this machine), which
 * blows that budget once the tenant/profile id segments are appended; on
 * Windows this uses the system drive root instead, matching how the guard
 * itself is scoped (POSIX has no such limit, so `os.tmpdir()` is fine
 * there).
 */
function shortScratchDir(): string {
  if (platform() !== 'win32') return mkdtempSync(join(tmpdir(), 'bgls-doctor-deep-'));
  const root = process.env['SystemDrive'] ?? 'C:';
  const dir = join(root, '\\', 'bglsdeep', randomBytes(3).toString('hex'));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** A self-contained, offline test page: red background, turns blue and records a click when clicked. No network access required. */
const TEST_PAGE_URL = `data:text/html,${encodeURIComponent(
  '<!doctype html><html><body style="margin:0;width:100vw;height:100vh;background:#c0392b" onclick="document.body.style.background=\'#2980b9\'"><h1 style="color:white;font-family:sans-serif">bgls doctor --deep</h1></body></html>',
)}`;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
  pollMs = 25,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(pollMs);
  }
  return predicate();
}

interface JsonEnvelope {
  readonly t: string;
  readonly [key: string]: unknown;
}

function waitForEnvelope(
  received: JsonEnvelope[],
  type: string,
  timeoutMs: number,
): Promise<JsonEnvelope> {
  const startIndex = received.length;
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      for (let i = startIndex; i < received.length; i += 1) {
        if (received[i]?.t === type) {
          resolve(received[i] as JsonEnvelope);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error(`timed out waiting for a "${type}" message`));
        return;
      }
      setTimeout(poll, 25);
    };
    poll();
  });
}

/** Runs the full `--deep` scenario. Never throws: failures are reported as a `fail` verdict, matching every other doctor check. */
export async function runDeepCheck(): Promise<DoctorCheckResult> {
  return timedCheck('deep', 'browser', async () => {
    const dataDir = shortScratchDir();
    return withCrashCleanup(dataDir, () => runDeepCheckInner(dataDir));
  });
}

async function runDeepCheckInner(
  dataDir: string,
): Promise<Omit<DoctorCheckResult, 'name' | 'group' | 'durationMs'>> {
  const gateway = await buildEmbeddedGateway({ dataDir, listenPort: 0, killOnShutdown: true });
  let ws: WebSocket | undefined;
  try {
    if (gateway.bg.router === undefined) {
      return {
        verdict: 'fail',
        detail:
          'The throwaway gateway started with no router; this is an internal bgls doctor bug.',
      };
    }
    // A full-capability principal, not `@browserglass/router`'s own
    // `SYSTEM_PRINCIPAL` (`caps: ['admin']` only): the router's
    // capability check is an exact match per action, and `admin` alone
    // does not imply `instance.create`.
    const principal: Principal = {
      tenantId: gateway.session.tenantId,
      appId: gateway.session.appId,
      sub: 'bgls-doctor-deep',
      subKind: 'service',
      caps: [...CAPABILITIES],
      scope: { kind: 'tenant' },
      jti: 'bgls-doctor-deep',
      exp: Math.floor(Date.now() / 1000) + 300,
    };
    let acquireHandle: Awaited<ReturnType<typeof gateway.bg.router.acquire>>;
    try {
      acquireHandle = await gateway.bg.router.acquire({ pool: 'default' }, principal);
    } catch (err) {
      const context = (err as { context?: unknown }).context;
      return {
        verdict: 'fail',
        detail: `acquire() failed: ${err instanceof Error ? err.message : String(err)}${context !== undefined ? ` ${JSON.stringify(context)}` : ''}`,
      };
    }
    let result = acquireHandle.result;
    if (result.attach === undefined) {
      result = await acquireHandle.ready;
    }
    if (result.attach === undefined) {
      return {
        verdict: 'fail',
        detail: 'The instance never reached "ready" with a usable attach ticket.',
      };
    }

    // `AcquireResult.instanceId` is nullable, and null means exactly one
    // thing: the pool was full and the request was queued rather than
    // placed, so what came back is a `placement_queue` row id and not a
    // browser. Checked rather than asserted. Reading it as a string
    // would put a `plc_` id into the token's `instanceId` scope below,
    // which is precisely the "queue ticket dressed as an instance" bug
    // this nullability was introduced to make impossible. A doctor that
    // reported a healthy round trip against a browser that was never
    // launched would be worse than one that says the pool is full.
    if (result.instanceId === null) {
      return {
        verdict: 'fail',
        detail: `acquire() returned a queued placement (${result.placementId ?? 'no placement id'}) rather than an instance: the pool is at capacity, so this check could not obtain a browser. Free capacity or raise the pool limit, then re-run.`,
      };
    }
    const instanceId = result.instanceId;

    // `AcquireResult.attach.{wsUrl,ticket}` are both synthetic
    // placeholders in this single-node, in-process build:
    // `LocalNodeTransport` has no real per-node WebSocket server to
    // point at (`wsUrl` is `ws://local/<nodeId>`), and `BrowserRouter`
    // mints its `ticket` as a bare id (`newId('tkt')`) without ever
    // registering it with `@browserglass/server`'s own `TicketRegistry`
    // (confirmed directly: redeeming it always answers
    // `bgls.error.auth.invalid_ticket`). A bearer token minted through
    // `bg.tokens` (a fully working, separate auth path) scoped to this
    // one instance sidesteps both gaps at once.
    const mintToken = (): Promise<string> =>
      gateway.bg.tokens.issue({
        sub: 'bgls-doctor-deep',
        subKind: 'service',
        scope: { kind: 'instance', instanceId, targets: '*' },
        caps: ['view', 'control', 'navigate'],
        ttlSeconds: 60,
      });

    const received: JsonEnvelope[] = [];
    const frames: { streamId: number; seq: number }[] = [];

    // `acquireHandle.result`/`.ready` both resolve once placement and
    // profile leasing succeed; the node's own session/CDP wiring for
    // this instance can still land a moment later, surfacing as
    // `bgls.error.instance.not_found` ("no live CDP endpoint (runtime
    // not ready)") on an immediate connect, confirmed directly.
    // `Instance.runtime` itself never leaves the node ("never exposed to
    // clients", per its own doc comment), so there is no external signal
    // to poll for readiness; retrying the connect itself, a few times
    // with a short pause, is the only externally observable option.
    let welcome: JsonEnvelope | undefined;
    let lastConnectError: string | undefined;
    for (let attempt = 0; attempt < 8 && welcome === undefined; attempt += 1) {
      if (attempt > 0) await sleep(500);
      received.length = 0;
      try {
        ws?.close();
      } catch {
        // Best effort.
      }
      const socket = new WebSocket(gateway.wsUrl, ['bgls.v1']);
      socket.binaryType = 'arraybuffer';
      ws = socket;

      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('WebSocket connect timed out')), 5000);
        socket.addEventListener('open', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.addEventListener('error', () => {
          clearTimeout(timer);
          reject(new Error('WebSocket connect failed'));
        });
      });

      socket.addEventListener('message', (ev: MessageEvent) => {
        if (typeof ev.data === 'string') {
          try {
            received.push(JSON.parse(ev.data) as JsonEnvelope);
          } catch {
            // Not JSON; ignore.
          }
        } else if (ev.data instanceof ArrayBuffer) {
          const header = decodeBinaryHeader(ev.data);
          frames.push({ streamId: header.streamId, seq: header.seq });
          socket.send(
            JSON.stringify({
              v: 1,
              t: 'ack',
              ts: Date.now(),
              streamId: header.streamId,
              seq: header.seq,
            }),
          );
        }
      });

      socket.send(
        JSON.stringify({
          v: 1,
          t: 'hello',
          id: `bgls-doctor-deep-${attempt}`,
          ts: Date.now(),
          versions: [1],
          minVersion: 1,
          client: { name: 'bgls-doctor', version: '1', runtime: 'cli' },
          capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse'] },
          viewport: { width: 1024, height: 768, dpr: 1, visible: true, fitMode: 'contain' },
          // A fresh token (and jti) every attempt: `InProcessJtiCache`
          // enforces single-use, so replaying the same token from a
          // prior, unsuccessful connect attempt is rejected outright.
          auth: { scheme: 'bearer', token: await mintToken() },
        }),
      );

      try {
        welcome = await waitForEnvelope(received, 'welcome', 1000);
      } catch {
        const err = received.find((m) => m.t === 'error');
        lastConnectError =
          typeof err?.['message'] === 'string'
            ? (err['message'] as string)
            : 'no welcome and no error message received';
      }
    }
    if (welcome === undefined) {
      return {
        verdict: 'fail',
        detail: `Never got a "welcome" after 8 connect attempts: ${lastConnectError ?? 'unknown'}`,
      };
    }
    const socket = ws as WebSocket;

    const welcomeTargets = welcome['targets'] as Array<{ targetId: string }> | undefined;
    const targetId = welcomeTargets?.[0]?.targetId;
    if (targetId === undefined) {
      return {
        verdict: 'fail',
        detail: 'The launched instance reported no targets to stream (welcome.targets was empty).',
      };
    }

    // `welcome.targets` lists a target the instant the node discovers
    // it, ahead of `TargetRegistry` finishing its own CDP session
    // attachment for it; sending `nav.goto` (or any per-target command)
    // before that attachment lands throws inside the gateway's message
    // handler uncaught, confirmed directly (it crashes the whole
    // process, not just this one WS request). There is no external
    // "attached" signal to poll for over the wire in this build, so a
    // short fixed wait is this check's only externally available option.
    await sleep(1500);

    socket.send(JSON.stringify({ v: 1, t: 'control.request', ts: Date.now(), targetId }));
    const granted = await waitForEnvelope(received, 'control.granted', 3000);
    const leaseId = granted['leaseId'] as string;

    socket.send(
      JSON.stringify({
        v: 1,
        t: 'nav.goto',
        ts: Date.now(),
        targetId,
        url: TEST_PAGE_URL,
        waitUntil: 'load',
      }),
    );
    await waitForEnvelope(received, 'nav.state', 5000);

    socket.send(JSON.stringify({ v: 1, t: 'stream.subscribe', ts: Date.now(), targetId }));
    const subscribed = await waitForEnvelope(received, 'stream.subscribed', 3000);
    const gen = subscribed['gen'] as number;
    const fw = subscribed['width'] as number;
    const fh = subscribed['height'] as number;

    const gotFirstFrame = await waitUntil(() => frames.length >= 1, 3000);
    if (!gotFirstFrame) {
      return {
        verdict: 'fail',
        detail: 'No frame arrived within 3s of subscribing to the stream.',
      };
    }
    const baselineFrames = frames.length;

    const x = Math.floor(fw / 2);
    const y = Math.floor(fh / 2);
    const inputBase = { v: 1, targetId, fw, fh, gen, leaseId };
    socket.send(
      JSON.stringify({
        ...inputBase,
        t: 'input.mouse',
        ts: Date.now(),
        kind: 'down',
        x,
        y,
        button: 'left',
        buttons: 1,
        modifiers: 0,
        clickCount: 1,
      }),
    );
    await sleep(50);
    socket.send(
      JSON.stringify({
        ...inputBase,
        t: 'input.mouse',
        ts: Date.now(),
        kind: 'up',
        x,
        y,
        button: 'left',
        buttons: 0,
        modifiers: 0,
        clickCount: 1,
      }),
    );

    const gotNewFrame = await waitUntil(() => frames.length > baselineFrames, 5000);
    if (!gotNewFrame) {
      return {
        verdict: 'fail',
        detail: `The click was injected but no new frame arrived within 5s (had ${baselineFrames}, still ${frames.length}).`,
        fix: 'The screencast pipeline is not reacting to page repaints; check core/stream logs on the gateway.',
      };
    }
    return {
      verdict: 'pass',
      detail: `Launched Chrome, opened a page, streamed ${frames.length} frame(s), injected a click, and observed a new frame.`,
      observed: { framesBeforeClick: baselineFrames, framesAfterClick: frames.length },
    };
  } finally {
    try {
      ws?.close();
    } catch {
      // Best effort.
    }
    await gateway.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      // Best effort: a locked file (e.g. Chrome not fully exited yet) is
      // not worth failing this check's already-decided verdict over.
    }
  }
}
