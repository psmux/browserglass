import { describe, expect, it, vi } from 'vitest';
import { resolveInputFencing } from '../../src/control/fencing.js';
import type { Lease } from '../../src/control/types.js';
import { InputDispatcher, type InputSignal } from '../../src/input/dispatcher.js';
import { FakeCdpSender, FakeTargetResolver, flushMicrotasks } from './test-helpers.js';

/**
 * A minimal fake `Lease` shape, matching `control/fencing.test.ts`'s own
 * helper. `leaseId`/`holderViewerId` describe the ONE holder of an exclusive
 * lease, which is what every case in this file is about; `resolveInputFencing`
 * reads `holders`, plural, so the single holder is built into a one element
 * list rather than into the derived `holder`/`leaseId` getters the real
 * `Lease` exposes over it.
 */
function leaseWith(overrides: {
  leaseId?: string | null;
  phase?: Lease['phase'];
  holderViewerId?: string | null;
}): FakeLease {
  const leaseId = overrides.leaseId === undefined ? 'lse_current' : overrides.leaseId;
  const holders =
    overrides.holderViewerId && leaseId
      ? [{ leaseId, viewerId: overrides.holderViewerId, connected: true }]
      : [];
  return {
    phase: overrides.phase ?? 'held',
    holders,
  };
}

/** Exactly the slice of `Lease` `resolveInputFencing` reads. */
type FakeLease = {
  readonly phase: Lease['phase'];
  readonly holders: readonly {
    readonly leaseId: string;
    readonly viewerId: string;
    readonly connected: boolean;
  }[];
};

/** A shared lease with several concurrent drivers, each with their own `leaseId`. */
function sharedLeaseWith(
  ...holders: readonly (readonly [viewerId: string, leaseId: string])[]
): FakeLease {
  return {
    phase: 'held',
    holders: holders.map(([viewerId, leaseId]) => ({ viewerId, leaseId, connected: true })),
  };
}

function baseMouse(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'input.mouse',
    ts: 1,
    targetId: 'tgt_1',
    fw: 1280,
    fh: 720,
    gen: 0,
    leaseId: 'lse_current',
    kind: 'move',
    x: 100,
    y: 100,
    buttons: 0,
    modifiers: 0,
    ...overrides,
  };
}

function baseDrag(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'input.drag',
    ts: 1,
    targetId: 'tgt_1',
    fw: 1280,
    fh: 720,
    gen: 0,
    leaseId: 'lse_current',
    kind: 'over',
    x: 100,
    y: 100,
    modifiers: 0,
    ...overrides,
  };
}

function baseText(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'input.text',
    ts: 1,
    targetId: 'tgt_1',
    fw: 1280,
    fh: 720,
    gen: 0,
    leaseId: 'lse_current',
    text: 'hello',
    ...overrides,
  };
}

function makeDispatcher(opts: {
  bridge?: FakeCdpSender;
  targets?: FakeTargetResolver;
  lease?: FakeLease;
  onSignal?: (s: InputSignal) => void;
  cdpDispatchRaceMs?: number;
  maxQueueDepth?: number;
}) {
  const bridge = opts.bridge ?? new FakeCdpSender();
  const targets = opts.targets ?? new FakeTargetResolver();
  targets.setViewport('tgt_1', 1280, 720);
  targets.setViewport('tgt_2', 1280, 720);
  const lease = opts.lease ?? leaseWith({ leaseId: 'lse_current', holderViewerId: 'vwr_alice' });

  const dispatcher = new InputDispatcher({
    sessionId: 'sess_1',
    bridge,
    targets,
    checkFencing: (input, fenceOpts) => resolveInputFencing(lease, input, fenceOpts),
    cdpDispatchRaceMs: opts.cdpDispatchRaceMs ?? 20,
    maxQueueDepth: opts.maxQueueDepth ?? 10,
    ...(opts.onSignal ? { onSignal: opts.onSignal } : {}),
  });
  return { dispatcher, bridge, targets, lease };
}

describe('InputDispatcher: ordering and chain isolation', () => {
  it('two viewers on two targets never interleave on one chain: each target dispatches strictly in received order', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue('vwr_alice', baseMouse({ targetId: 'tgt_1', kind: 'move', x: 1, gen: 0 }));
    dispatcher.enqueue('vwr_bob', baseMouse({ targetId: 'tgt_2', kind: 'move', x: 2, gen: 0 }));
    dispatcher.enqueue('vwr_alice', baseMouse({ targetId: 'tgt_1', kind: 'move', x: 3, gen: 0 }));
    dispatcher.enqueue('vwr_bob', baseMouse({ targetId: 'tgt_2', kind: 'move', x: 4, gen: 0 }));

    await Promise.all([dispatcher.tailFor('tgt_1'), dispatcher.tailFor('tgt_2')]);
    await flushMicrotasks();

    const tgt1Calls = bridge.calls.filter((c) => c.params['x'] === 1 || c.params['x'] === 3);
    const tgt2Calls = bridge.calls.filter((c) => c.params['x'] === 2 || c.params['x'] === 4);
    expect(tgt1Calls.map((c) => c.params['x'])).toEqual([1, 3]);
    expect(tgt2Calls.map((c) => c.params['x'])).toEqual([2, 4]);
  });

  it('a rejected promise inside a queued dispatch does not stop the next event on that same chain', async () => {
    // input.text is awaited fully (it is never raced), so its rejection
    // actually propagates out of performDispatch and must be caught INSIDE
    // the chained function, not merely swallowed by dispatchWithRace's
    // catch. An uncaught rejection here would poison chain.tail
    // forever and every subsequent .then would short circuit silently.
    const bridge = new FakeCdpSender();
    bridge.rejectNextFor = 'Input.insertText';
    const signals: InputSignal[] = [];
    const { dispatcher } = makeDispatcher({ bridge, onSignal: (s) => signals.push(s) });

    dispatcher.enqueue('vwr_alice', baseText({ text: 'first' }));
    dispatcher.enqueue('vwr_alice', baseText({ text: 'second' }));

    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    expect(bridge.calls).toHaveLength(2); // both events actually reached the bridge
    expect(bridge.calls.map((c) => c.params['text'])).toEqual(['first', 'second']);
    expect(signals.some((s) => s.kind === 'dispatch_error')).toBe(true); // the first one's failure was reported, not swallowed silently
  });
});

describe('InputDispatcher: stale-lease asymmetry', () => {
  it('a stale-lease mouseup dispatches while a stale-lease mousedown does not', async () => {
    const bridge = new FakeCdpSender();
    const lease = leaseWith({ leaseId: 'lse_current', holderViewerId: 'vwr_alice' });
    const { dispatcher } = makeDispatcher({ bridge, lease });

    dispatcher.enqueue(
      'vwr_mallory',
      baseMouse({ kind: 'down', leaseId: 'lse_stale', button: 'left', clickCount: 1 }),
    );
    dispatcher.enqueue(
      'vwr_mallory',
      baseMouse({ kind: 'up', leaseId: 'lse_stale', button: 'left', clickCount: 1 }),
    );

    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const types = bridge.calls.map((c) => c.params['type']);
    expect(types).not.toContain('mousePressed');
    expect(types).toContain('mouseReleased');
  });

  it('a stale-lease key.up dispatches while a stale-lease key.down does not', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue('vwr_mallory', {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 0,
      leaseId: 'lse_stale',
      kind: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
    });
    dispatcher.enqueue('vwr_mallory', {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 0,
      leaseId: 'lse_stale',
      kind: 'up',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
    });

    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const types = bridge.calls.map((c) => c.params['type']);
    expect(types).toEqual(['keyUp']);
  });
});

describe('InputDispatcher: stale gen', () => {
  it('drops a stale-gen mouse move silently (no bridge call)', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    // getGeneration defaults to 0; a message claiming gen 5 is stale.
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', gen: 5 }));
    await dispatcher.tailFor('tgt_1');
    expect(bridge.calls).toHaveLength(0);
  });

  it('dispatches a stale-gen mouseup at the last dispatched position', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', gen: 0, x: 55, y: 66 }));
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'up', gen: 5, button: 'left', clickCount: 1 }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    const up = bridge.calls.find((c) => c.params['type'] === 'mouseReleased');
    expect(up).toBeDefined();
    expect(up?.params['x']).toBe(55);
    expect(up?.params['y']).toBe(66);
  });

  it('signals gen_stale for a stale-gen mouse down and does not dispatch it', async () => {
    const bridge = new FakeCdpSender();
    const signals: InputSignal[] = [];
    const { dispatcher } = makeDispatcher({ bridge, onSignal: (s) => signals.push(s) });
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', gen: 5, button: 'left', clickCount: 1 }),
    );
    await dispatcher.tailFor('tgt_1');
    expect(bridge.calls).toHaveLength(0);
    expect(signals.some((s) => s.kind === 'gen_stale')).toBe(true);
  });
});

describe('InputDispatcher: queue depth shedding', () => {
  it('sheds mouse moves above maxQueueDepth, but never down/up/key/text', async () => {
    const bridge = new FakeCdpSender();
    bridge.delayMs = 5;
    const { dispatcher } = makeDispatcher({ bridge, maxQueueDepth: 3 });

    for (let i = 0; i < 20; i++) {
      dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: i, y: i }));
    }
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 999, button: 'left', clickCount: 1 }),
    );
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'up', x: 999, button: 'left', clickCount: 1 }),
    );

    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const moveCount = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved').length;
    expect(moveCount).toBeLessThan(20); // some were shed
    expect(bridge.calls.some((c) => c.params['type'] === 'mousePressed')).toBe(true);
    expect(bridge.calls.some((c) => c.params['type'] === 'mouseReleased')).toBe(true);
  });
});

describe('InputDispatcher: dispatch race versus full await', () => {
  it('races a mouse dispatch: does not block the chain on a page that never responds', async () => {
    const bridge = new FakeCdpSender();
    bridge.delayMs = 5000; // far longer than the race window
    const { dispatcher } = makeDispatcher({ bridge, cdpDispatchRaceMs: 10 });

    const start = Date.now();
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 1 }));
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 2 }));
    await dispatcher.tailFor('tgt_1');
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(2000); // the chain settled well under the 5000ms send delay
  });

  it('input.text is awaited fully, not raced: the chain does not settle until the send actually resolves', async () => {
    const bridge = new FakeCdpSender();
    let resolveSend: (() => void) | null = null;
    bridge.send = vi.fn((method: string, params?: Record<string, unknown>) => {
      bridge.calls.push({ method, params: params ?? {}, sessionId: 'sess-tgt_1' as never });
      if (method === 'Input.insertText') {
        return new Promise((resolve) => {
          resolveSend = () => resolve(undefined);
        });
      }
      return Promise.resolve(undefined);
    });
    const { dispatcher } = makeDispatcher({ bridge, cdpDispatchRaceMs: 10 });

    dispatcher.enqueue('vwr_alice', baseText());
    await flushMicrotasks(10);
    // The chain must still be pending: input.text is fully awaited, unlike a raced mouse event.
    let settled = false;
    dispatcher.tailFor('tgt_1').then(() => {
      settled = true;
    });
    await flushMicrotasks(10);
    expect(settled).toBe(false);

    resolveSend?.();
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    expect(settled).toBe(true);
  });

  /**
   * The regression `input-concurrency-probe.mjs` caught directly against a
   * running gateway: `type('hello')` sends ten raced `input.key` events
   * (keydown/keyup per character) on ONE target's chain. Before this fix,
   * `performDispatch`'s raced branch AWAITED `Promise.race([send,
   * raceTimeout(cdpDispatchRaceMs)])` before letting `enqueueOnChain` start
   * the next queued event, so whenever the real CDP round trip exceeded
   * `cdpDispatchRaceMs` (which several concurrent browsers sharing one
   * gateway routinely does), EVERY event on that chain cost at least the
   * full `cdpDispatchRaceMs`, not because Chrome needed that long but
   * because this dispatcher waited that long before moving on. Ten events
   * at even a modest 20ms race window is 200ms of purely self-inflicted
   * delay before the tenth keystroke's `Input.dispatchKeyEvent` had even
   * been written to the wire, on top of whatever CDP itself was slow to
   * report back on. A `click()` (2 events) or `scroll()` (1 event) barely
   * notices that; a `type()` of a real word does, and its trailing
   * characters missed every reasonable read-back window even though
   * nothing was ever actually dropped.
   *
   * Ten raced dispatches with a real per-send delay well past the race
   * window must all reach the bridge in close to zero elapsed time: the
   * chain no longer waits on the race to advance.
   */
  it('many raced dispatches on one chain do not each cost the race window: total elapsed stays near-instant, not N x cdpDispatchRaceMs', async () => {
    const bridge = new FakeCdpSender();
    bridge.delayMs = 300; // far longer than the 20ms race window below
    const { dispatcher } = makeDispatcher({ bridge, cdpDispatchRaceMs: 20 });

    const start = Date.now();
    for (let i = 0; i < 10; i++) {
      dispatcher.enqueue('vwr_alice', {
        v: 1,
        t: 'input.key',
        ts: 1,
        targetId: 'tgt_1',
        fw: 1280,
        fh: 720,
        gen: 0,
        leaseId: 'lse_current',
        kind: i % 2 === 0 ? 'down' : 'up',
        key: 'h',
        code: 'KeyH',
        modifiers: 0,
        ...(i % 2 === 0 ? { text: 'h' } : {}),
      });
    }
    await dispatcher.tailFor('tgt_1');
    const elapsed = Date.now() - start;

    expect(bridge.calls).toHaveLength(10); // every event actually reached the bridge
    // Old behaviour (chain gated on the race) would need at least
    // 10 * 20ms = 200ms here; the fix keeps this well under one race window.
    expect(elapsed).toBeLessThan(20);
  });

  /**
   * A raced dispatch (every kind but `input.text`/`imeSetComposition`)
   * returns from `performDispatch` the instant EITHER the send settles OR
   * `cdpDispatchRaceMs` elapses, whichever comes first. When
   * the timeout wins that race, the underlying send is still running in
   * the background, unobserved by anything the chain awaits. Before the
   * fix, if it later REJECTED, nothing checked `fastError`/`settled` again
   * after the race (that check only ran synchronously right after
   * `Promise.race` resolved, which is before a late rejection happens), so
   * a key or mouse event whose CDP command was merely slow, then
   * genuinely failed, was dropped with no `onSignal` at all,
   * indistinguishable from success to every caller. This is the exact
   * shape a page under heavy concurrent load produces: the round trip
   * occasionally exceeds the race window, and its eventual failure must
   * still be reported once it arrives.
   */
  it('a raced dispatch that loses the race and then rejects still reports dispatch_error', async () => {
    const bridge = new FakeCdpSender();
    bridge.send = vi.fn((method: string, params?: Record<string, unknown>) => {
      bridge.calls.push({ method, params: params ?? {}, sessionId: 'sess-tgt_1' as never });
      // Settles well after the 10ms race window, and REJECTS rather than
      // resolving: a genuine late CDP failure, not merely a slow success.
      return new Promise((_resolve, reject) => {
        setTimeout(() => reject(new Error('late CDP failure')), 50);
      });
    });
    const signals: InputSignal[] = [];
    const { dispatcher } = makeDispatcher({
      bridge,
      cdpDispatchRaceMs: 10,
      onSignal: (s) => signals.push(s),
    });

    dispatcher.enqueue('vwr_alice', {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 0,
      leaseId: 'lse_current',
      kind: 'down',
      key: 'h',
      code: 'KeyH',
      modifiers: 0,
      text: 'h',
    });
    await dispatcher.tailFor('tgt_1');
    // The chain already moved on (raced, per the mouse test above); now
    // wait past the point where the underlying send actually rejects.
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(bridge.calls).toHaveLength(1); // the command really was sent
    expect(signals).toHaveLength(1); // ...and its later failure IS reported
    expect(signals[0]).toMatchObject({
      kind: 'dispatch_error',
      viewerId: 'vwr_alice',
      targetId: 'tgt_1',
    });
  });
});

describe('InputDispatcher: session lookup timeout still reports dispatch_error', () => {
  /**
   * `resolveSession()` races `targets.attach()` against
   * `sessionLookupTimeoutMs`. Every OTHER drop path in this class reports
   * through `onSignal` (that is the class's own stated invariant: "Every
   * observable outcome the dispatcher reports through `onSignal`... in
   * place of throwing or logging directly"); before the fix this one did
   * not: `performDispatch` just returned when `resolveSession()` yielded
   * `null`, with no signal and nothing logged. Under real load
   * `targets.attach()` is a genuine CDP round trip
   * (`TargetRegistry.attach()`), so a saturated gateway handling several
   * concurrent connections can easily make it slower than the timeout,
   * and every event it swallowed this way used to disappear with zero
   * observability, even though the class was explicitly designed so that
   * never happens.
   */
  it('emits dispatch_error when the session lookup exceeds its timeout', async () => {
    const bridge = new FakeCdpSender();
    const targets = new FakeTargetResolver();
    targets.setViewport('tgt_1', 1280, 720);
    targets.attachDelayMs = 50; // longer than the 10ms sessionLookupTimeoutMs below
    const lease = leaseWith({ leaseId: 'lse_current', holderViewerId: 'vwr_alice' });
    const signals: InputSignal[] = [];

    const dispatcher = new InputDispatcher({
      sessionId: 'sess_1',
      bridge,
      targets,
      checkFencing: (input, fenceOpts) => resolveInputFencing(lease, input, fenceOpts),
      cdpDispatchRaceMs: 20,
      sessionLookupTimeoutMs: 10,
      onSignal: (s) => signals.push(s),
    });

    dispatcher.enqueue('vwr_alice', {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 0,
      leaseId: 'lse_current',
      kind: 'down',
      key: 'h',
      code: 'KeyH',
      modifiers: 0,
      text: 'h',
    });
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    expect(bridge.calls).toHaveLength(0); // the CDP command was never even sent
    expect(signals).toHaveLength(1); // ...but the drop IS reported
    expect(signals[0]).toMatchObject({
      kind: 'dispatch_error',
      viewerId: 'vwr_alice',
      targetId: 'tgt_1',
    });
  });
});

describe('InputDispatcher: releaseHeld', () => {
  it('sends release commands for held buttons and keys, then clears state', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 5, y: 5, button: 'left', buttons: 1, clickCount: 1 }),
    );
    await dispatcher.tailFor('tgt_1');

    await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
    await flushMicrotasks();

    expect(bridge.calls.some((c) => c.params['type'] === 'mouseReleased')).toBe(true);

    // A second releaseHeld with nothing held sends nothing further.
    const before = bridge.calls.length;
    await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
    expect(bridge.calls.length).toBe(before);
  });
});

/**
 * Click-drag: a move sent while a button is held.
 *
 * Chrome decides whether a `mouseMoved` continues a drag or is a plain
 * hover from `Input.dispatchMouseEvent`'s `button` field, not from
 * `buttons`. The dispatcher used to send `button: msg.button ?? 'none'`,
 * and a client has no reason to repeat `button` on every move of a drag, so
 * every drag arrived at Chrome as a hover: no text selection, no element
 * drag, no splitter resize.
 *
 * Measured on the running demo before the fix. The identical gesture across
 * three panes changed 0 pixels with `'none'` and roughly 500,000 with
 * `'left'`, and the screenshot showed the whole page highlighted.
 *
 * The fix derives both fields from `held.buttons`, which this dispatcher
 * maintains itself from the `down`/`up` it has actually seen, so a client
 * that omits them still drags correctly and a client that lies about them
 * cannot claim a button this dispatcher never saw pressed.
 */
describe('InputDispatcher: drag moves name the held button', () => {
  async function dragAndCollect(moveOverrides: Record<string, unknown>) {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1 }),
    );
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 50, y: 50, ...moveOverrides }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    return bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
  }

  it('names the held button on a move even when the client omits it entirely', async () => {
    const moves = await dragAndCollect({ buttons: 0 });
    expect(moves).toHaveLength(1);
    // `'none'` here is the bug: Chrome would treat this as a hover.
    expect(moves[0]?.params['button']).toBe('left');
    // And `buttons` comes from tracked state too, so a client that forgot
    // to set it (as above, `buttons: 0`) still produces a real drag.
    expect(moves[0]?.params['buttons']).toBe(1);
  });

  it('reports the right button for a right-drag', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 10, y: 10, button: 'right', buttons: 2, clickCount: 1 }),
    );
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 50, y: 50, buttons: 0 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    const moves = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
    expect(moves[0]?.params['button']).toBe('right');
    expect(moves[0]?.params['buttons']).toBe(2);
  });

  it('leaves a plain hover alone: no button held means button "none"', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 50, y: 50, buttons: 0 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    const moves = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
    expect(moves[0]?.params['button']).toBe('none');
    expect(moves[0]?.params['buttons']).toBe(0);
  });

  it('stops naming the button once it is released', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 10, y: 10, button: 'left', buttons: 1, clickCount: 1 }),
    );
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 50, y: 50, buttons: 0 }));
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'up', x: 50, y: 50, button: 'left', buttons: 0, clickCount: 1 }),
    );
    dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: 90, y: 90, buttons: 0 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    const moves = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
    expect(moves.map((m) => m.params['button'])).toEqual(['left', 'none']);
  });
});

/**
 * Held state is per `(target, viewer)`, and the release sweep is per viewer.
 *
 * `held-state.ts` has always documented it that way; the dispatcher kept one
 * `HeldState` per target, and `releaseHeld(targetId, _viewerId)` ignored the
 * viewer entirely, so one driver leaving wiped both drivers' state. That is
 * only invisible while exactly one viewer can ever dispatch to a target,
 * which is precisely the assumption shared control removes.
 */
describe('InputDispatcher: per (target, viewer) held state under several drivers', () => {
  const lease = () => sharedLeaseWith(['vwr_alice', 'lse_alice'], ['vwr_bob', 'lse_bob']);

  function keyEvent(overrides: Record<string, unknown>) {
    return {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 0,
      modifiers: 0,
      key: '',
      ...overrides,
    };
  }

  it("releasing one driver's held modifier leaves the other driver's held down", async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge, lease: lease() });

    dispatcher.enqueue(
      'vwr_alice',
      keyEvent({ leaseId: 'lse_alice', kind: 'down', key: 'Shift', code: 'ShiftLeft' }),
    );
    dispatcher.enqueue(
      'vwr_bob',
      keyEvent({ leaseId: 'lse_bob', kind: 'down', key: 'Control', code: 'ControlLeft' }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const before = bridge.calls.length;
    await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
    await flushMicrotasks();

    const sweep = bridge.calls.slice(before).filter((c) => c.params['type'] === 'keyUp');
    expect(sweep.map((c) => c.params['code'])).toEqual(['ShiftLeft']);

    // Bob's ControlLeft is still held, so his own sweep still lifts it.
    const beforeBob = bridge.calls.length;
    await dispatcher.releaseHeld('tgt_1', 'vwr_bob');
    await flushMicrotasks();
    const bobSweep = bridge.calls.slice(beforeBob).filter((c) => c.params['type'] === 'keyUp');
    expect(bobSweep.map((c) => c.params['code'])).toEqual(['ControlLeft']);
  });

  it("one driver leaving mid-drag does not lift the other driver's button, and the drag keeps naming it", async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge, lease: lease() });

    dispatcher.enqueue(
      'vwr_bob',
      baseMouse({
        leaseId: 'lse_bob',
        kind: 'down',
        x: 10,
        y: 10,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    );
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({
        leaseId: 'lse_alice',
        kind: 'down',
        x: 80,
        y: 80,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const before = bridge.calls.length;
    await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
    await flushMicrotasks();
    // Exactly one button came up, at Alice's last position, not Bob's.
    const released = bridge.calls.slice(before).filter((c) => c.params['type'] === 'mouseReleased');
    expect(released).toHaveLength(1);
    expect(released[0]?.params['x']).toBe(80);

    // Bob is still mid-drag: his next move must still name the held button,
    // or Chrome treats it as a hover and the selection stops growing.
    dispatcher.enqueue(
      'vwr_bob',
      baseMouse({ leaseId: 'lse_bob', kind: 'move', x: 200, y: 200, buttons: 0 }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();
    const moves = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
    expect(moves).toHaveLength(1);
    expect(moves[0]?.params['button']).toBe('left');
    expect(moves[0]?.params['buttons']).toBe(1);
  });

  it("a departed driver's stale-lease mouse.up lifts only their own button", async () => {
    const bridge = new FakeCdpSender();
    // Bob alone holds; Alice's press happened under a lease that is now gone.
    const { dispatcher } = makeDispatcher({
      bridge,
      lease: sharedLeaseWith(['vwr_bob', 'lse_bob']),
    });

    dispatcher.enqueue(
      'vwr_bob',
      baseMouse({
        leaseId: 'lse_bob',
        kind: 'down',
        x: 10,
        y: 10,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    );
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({
        leaseId: 'lse_dead',
        kind: 'up',
        x: 80,
        y: 80,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    // The release dispatched (the asymmetry), and it came out of Alice's own
    // held state, so Bob's button mask is untouched: his sweep still has one
    // button to lift.
    expect(bridge.calls.some((c) => c.params['type'] === 'mouseReleased')).toBe(true);
    const before = bridge.calls.length;
    await dispatcher.releaseHeld('tgt_1', 'vwr_bob');
    await flushMicrotasks();
    const bobSweep = bridge.calls.slice(before).filter((c) => c.params['type'] === 'mouseReleased');
    expect(bobSweep).toHaveLength(1);
    expect(bobSweep[0]?.params['x']).toBe(10);
  });
});

/**
 * `input.drag`: native drag via `Input.dispatchDragEvent`. `browser_use`'s
 * own drag (`browser_use/actor/element.py:625-637`) never sends a drag
 * event at all, it presses, sends ONE intermediate `mouse.move`, and
 * releases; this suite covers both the native path this dispatcher adds on
 * top of that, and the pre-existing `input.mouse` fallback for pages that
 * implement drag purely on mouse events, exercised here with several
 * intermediate move points rather than one, which is what a sortable
 * list's own dragover threshold needs to actually trigger.
 */
describe('InputDispatcher: native drag (input.drag)', () => {
  it('dispatches enter/over/drop as dragEnter/dragOver/drop', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', x: 10, y: 10 }));
    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'over', x: 50, y: 50 }));
    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'drop', x: 90, y: 90 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const dragCalls = bridge.calls.filter((c) => c.method === 'Input.dispatchDragEvent');
    expect(dragCalls.map((c) => c.params['type'])).toEqual(['dragEnter', 'dragOver', 'drop']);
    expect(dragCalls[2]?.params['x']).toBe(90);
    expect(dragCalls[2]?.params['y']).toBe(90);
  });

  it('dispatches leave as dragCancel', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', x: 10, y: 10 }));
    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'leave', x: 10, y: 10 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const dragCalls = bridge.calls.filter((c) => c.method === 'Input.dispatchDragEvent');
    expect(dragCalls.map((c) => c.params['type'])).toEqual(['dragEnter', 'dragCancel']);
  });

  it('forwards drag data (items, dragOperationsMask) verbatim, field by field', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue(
      'vwr_alice',
      baseDrag({
        kind: 'enter',
        data: { items: [{ mimeType: 'text/plain', data: 'hello' }], dragOperationsMask: 1 },
      }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const enter = bridge.calls.find((c) => c.params['type'] === 'dragEnter');
    expect(enter?.params['data']).toEqual({
      items: [{ mimeType: 'text/plain', data: 'hello' }],
      dragOperationsMask: 1,
    });
  });

  it('an HTML5 fallback drag over plain input.mouse carries several intermediate move points, not one', async () => {
    const bridge = new FakeCdpSender();
    const { dispatcher } = makeDispatcher({ bridge });

    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'down', x: 0, y: 0, button: 'left', buttons: 1, clickCount: 1 }),
    );
    for (const step of [20, 40, 60, 80]) {
      dispatcher.enqueue('vwr_alice', baseMouse({ kind: 'move', x: step, y: step, buttons: 0 }));
    }
    dispatcher.enqueue(
      'vwr_alice',
      baseMouse({ kind: 'up', x: 100, y: 100, button: 'left', buttons: 0, clickCount: 1 }),
    );
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const moves = bridge.calls.filter((c) => c.params['type'] === 'mouseMoved');
    // Every move names the held button (the fix `dispatcher.ts`'s own doc
    // comment describes), or Chrome treats each one as a hover and a
    // sortable list's dragover threshold never fires.
    expect(moves).toHaveLength(4);
    expect(moves.every((m) => m.params['button'] === 'left')).toBe(true);
    expect(moves.map((m) => m.params['x'])).toEqual([20, 40, 60, 80]);
  });

  it('sheds drag.over above maxQueueDepth, same as a mouse move', async () => {
    const bridge = new FakeCdpSender();
    bridge.delayMs = 5;
    const { dispatcher } = makeDispatcher({ bridge, maxQueueDepth: 3 });

    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', x: 0, y: 0 }));
    for (let i = 0; i < 20; i++) {
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'over', x: i, y: i }));
    }
    dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'drop', x: 99, y: 99 }));
    await dispatcher.tailFor('tgt_1');
    await flushMicrotasks();

    const overCount = bridge.calls.filter((c) => c.params['type'] === 'dragOver').length;
    expect(overCount).toBeLessThan(20); // some were shed
    expect(bridge.calls.some((c) => c.params['type'] === 'drop')).toBe(true); // the release itself is never shed
  });

  describe('stale gen', () => {
    it('drops a stale-gen drag.over silently (no bridge call)', async () => {
      const bridge = new FakeCdpSender();
      const { dispatcher } = makeDispatcher({ bridge });
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'over', gen: 5 }));
      await dispatcher.tailFor('tgt_1');
      expect(bridge.calls).toHaveLength(0);
    });

    it('dispatches a stale-gen drag.drop at the last dispatched position', async () => {
      const bridge = new FakeCdpSender();
      const { dispatcher } = makeDispatcher({ bridge });
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', gen: 0, x: 33, y: 44 }));
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'drop', gen: 5 }));
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();
      const drop = bridge.calls.find((c) => c.params['type'] === 'drop');
      expect(drop).toBeDefined();
      expect(drop?.params['x']).toBe(33);
      expect(drop?.params['y']).toBe(44);
    });
  });

  describe('lease loss and disconnect hygiene sweep a drag in progress', () => {
    it('releaseHeld cancels an in-progress drag (dragCancel at the last position), same sweep as lease loss or disconnect hygiene', async () => {
      const bridge = new FakeCdpSender();
      const { dispatcher } = makeDispatcher({ bridge });

      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', x: 15, y: 25 }));
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();

      await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
      await flushMicrotasks();

      const cancel = bridge.calls.find((c) => c.params['type'] === 'dragCancel');
      expect(cancel).toBeDefined();
      expect(cancel?.params['x']).toBe(15);
      expect(cancel?.params['y']).toBe(25);

      // A completed drag (drop already sent) leaves nothing to sweep.
      const before = bridge.calls.length;
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'enter', x: 1, y: 1 }));
      dispatcher.enqueue('vwr_alice', baseDrag({ kind: 'drop', x: 2, y: 2 }));
      await dispatcher.tailFor('tgt_1');
      await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
      await flushMicrotasks();
      const cancelsAfterDrop = bridge.calls
        .slice(before)
        .filter((c) => c.params['type'] === 'dragCancel');
      expect(cancelsAfterDrop).toHaveLength(0);
    });

    it("one driver leaving mid-drag does not cancel the other driver's drag: the sweep is scoped per (target, viewer)", async () => {
      const bridge = new FakeCdpSender();
      const lease = sharedLeaseWith(['vwr_alice', 'lse_alice'], ['vwr_bob', 'lse_bob']);
      const { dispatcher } = makeDispatcher({ bridge, lease });

      dispatcher.enqueue(
        'vwr_alice',
        baseDrag({ leaseId: 'lse_alice', kind: 'enter', x: 5, y: 5 }),
      );
      dispatcher.enqueue('vwr_bob', baseDrag({ leaseId: 'lse_bob', kind: 'enter', x: 60, y: 60 }));
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();

      await dispatcher.releaseHeld('tgt_1', 'vwr_alice');
      await flushMicrotasks();

      const cancels = bridge.calls.filter((c) => c.params['type'] === 'dragCancel');
      expect(cancels).toHaveLength(1);
      expect(cancels[0]?.params['x']).toBe(5); // Alice's own last position, not Bob's

      // Bob's drag is untouched: his own next dragOver still dispatches normally.
      dispatcher.enqueue('vwr_bob', baseDrag({ leaseId: 'lse_bob', kind: 'over', x: 70, y: 70 }));
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();
      expect(
        bridge.calls.some((c) => c.params['type'] === 'dragOver' && c.params['x'] === 70),
      ).toBe(true);
    });
  });

  describe('a departing driver cannot leave a drag stuck: drop and leave always dispatch', () => {
    it('a stale-lease drag.drop dispatches while a stale-lease drag.enter does not', async () => {
      const bridge = new FakeCdpSender();
      const lease = leaseWith({ leaseId: 'lse_current', holderViewerId: 'vwr_alice' });
      const { dispatcher } = makeDispatcher({ bridge, lease });

      dispatcher.enqueue(
        'vwr_mallory',
        baseDrag({ leaseId: 'lse_stale', kind: 'enter', x: 1, y: 1 }),
      );
      dispatcher.enqueue(
        'vwr_mallory',
        baseDrag({ leaseId: 'lse_stale', kind: 'drop', x: 2, y: 2 }),
      );
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();

      const types = bridge.calls.map((c) => c.params['type']);
      expect(types).not.toContain('dragEnter');
      expect(types).toContain('drop');
    });

    it('a stale-lease drag.leave (dragCancel) dispatches too', async () => {
      const bridge = new FakeCdpSender();
      const lease = leaseWith({ leaseId: 'lse_current', holderViewerId: 'vwr_alice' });
      const { dispatcher } = makeDispatcher({ bridge, lease });

      dispatcher.enqueue(
        'vwr_mallory',
        baseDrag({ leaseId: 'lse_stale', kind: 'leave', x: 1, y: 1 }),
      );
      await dispatcher.tailFor('tgt_1');
      await flushMicrotasks();

      expect(bridge.calls.some((c) => c.params['type'] === 'dragCancel')).toBe(true);
    });
  });
});
