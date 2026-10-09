/**
 * `onRecovery`, fired from `session/managed-session.ts`'s `dispatchEffect`
 * for every `recovery.progress`/`recovery.recovered`/`recovery.unrecoverable`/
 * `instance.restart.progress`/`instance.restart.result` effect
 * `core.Session` emits (`fireRecovery`, that file's own doc). Non-vetoing
 * (`HOOK_TIMEOUTS.onRecovery`), so this suite is fire only; the fail-open
 * timeout policy is covered generically in `dispatch-policy.test.ts`.
 *
 * Drives a REAL recovery rung against the fake CDP endpoint
 * (`test/ws/support/fake-chrome-server.ts`'s catch-all `reply({})` answers
 * R0's `Page.stopScreencast`/`Page.startScreencast` calls), via
 * `ManagedSession.reportSignal()`, the same entry point the frame
 * staleness watchdog uses on its own initiative
 * (`core/src/session/session.ts`'s `reportSignal`).
 */

import { setTier1EncoderFactory } from '@browserglass/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RecoveryEvent } from '../../src/hooks/types.js';
import {
  type TestGateway,
  nextMessage,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from '../ws/support/test-gateway.js';

setTier1EncoderFactory(async (input) => input);

function hello(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
    ...overrides,
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let gw: TestGateway;

beforeEach(async () => {
  gw = await startTestGateway();
  gw.addTarget({
    targetId: 'cdp-a',
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
  });
});

afterEach(async () => {
  await gw.close();
});

describe('onRecovery: fire', () => {
  it('reportSignal("screencast_silent") fires a recovery.progress event: rung 0, trigger frame_silence, succeeded null', async () => {
    const events: RecoveryEvent[] = [];
    // Resolves once `recovery.recovered` lands, not on the first
    // `recovery.progress`: the fake R0 rung completes in well under a
    // second, and closing the socket while `core.Session` is still in its
    // `'recovering'` state races `removeViewer()`'s `'lastViewerLeft'`
    // transition against `SESSION_TRANSITIONS`' state machine (illegal
    // from `'recovering'`), an unrelated uncaught exception this test has
    // no business tripping. Waiting for the terminal event keeps this test
    // about `onRecovery`, not about that race.
    const done = deferred<void>();
    gw.connectionDeps.hooks.on('onRecovery', (e) => {
      events.push(e);
      if (e.succeeded !== null) done.resolve();
    });

    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;

    // A stream must exist for `core.Session.reportSignal` to find a
    // `perTarget` entry at all (`session.ts`'s own `if (!per) return`);
    // subscribing is the same thing a real viewer does before it could
    // ever observe a stalled screencast in the first place.
    ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', id: 's1', ts: Date.now(), targetId }));
    // Drains the leftover `presence.state` that always follows `welcome`
    // (`ManagedSession.broadcastPresence()`), then the actual
    // `stream.subscribed` reply: only once that reply is in hand is
    // `core.Session.ensureTargetState()` guaranteed to have run, which is
    // what makes `reportSignal` below find a `perTarget` entry instead of
    // silently no-oping (`session.ts`'s own `if (!per) return`).
    const subscribed = await nextMessageSkipping(ws, ['presence.state']);
    expect(subscribed['t']).toBe('stream.subscribed');

    const managed = gw.sessionRegistry.get(gw.instanceId);
    expect(managed).toBeDefined();
    managed!.reportSignal(targetId, 'screencast_silent');
    await done.promise;

    const progress = events[0]!;
    expect(progress.rung).toBe(0);
    expect(progress.rungName).toBe('restart_stream');
    expect(progress.trigger).toBe('frame_silence');
    expect(progress.succeeded).toBeNull();
    expect(progress.instanceId).toBe(gw.instanceId);

    const terminal = events[events.length - 1]!;
    expect(terminal.succeeded).toBe(true);
    expect(terminal.rung).toBe(0);
    ws.close();
  });

  it('is not consulted at all when nothing is registered: reportSignal still runs without throwing', async () => {
    const token = await gw.issueToken();
    const ws = gw.connect();
    await waitOpen(ws);
    ws.send(JSON.stringify(hello({ auth: { scheme: 'bearer', token } })));
    const welcome = await nextMessage(ws);
    const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
    ws.send(JSON.stringify({ v: 1, t: 'stream.subscribe', id: 's1', ts: Date.now(), targetId }));
    await nextMessageSkipping(ws, ['presence.state']);

    const managed = gw.sessionRegistry.get(gw.instanceId);
    expect(() => managed!.reportSignal(targetId, 'screencast_silent')).not.toThrow();
    // Let the fake R0 rung actually finish (see the sibling test's comment
    // on why closing mid-`'recovering'` races `removeViewer()`) before
    // tearing the socket down.
    for (let i = 0; i < 50 && managed!.coreSession.state === 'recovering'; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
  });
});
