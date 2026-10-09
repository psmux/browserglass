/**
 * `ViewerRateLimiters`'s `input`/`control` buckets, keyed per `(viewer,
 * targetId)` rather than once per connection. The wire limits are
 * inputRatePerSec: 300 and controlRatePerSec: 60; enforced per session
 * rather than per target they would throttle N panes driven at once. Before this fix a single viewer with several panes open shared
 * one 300/sec input budget across every one of them; exhausting it on one
 * pane silently throttled every other pane's input too, which reproduces
 * the "several browsers can never be driven at once" symptom
 * through a different mechanism than the active-target steal
 * `promoteOnInput` fixes.
 */
import { describe, expect, it } from 'vitest';
import { ViewerRateLimiters } from '../../src/wire/rate-limit.js';

const LIMITS = {
  inputRatePerSec: 10,
  controlRatePerSec: { perSecond: 5, burst: 5 },
  navRatePerSec: { perSecond: 4, burst: 8 },
  cursorRate: { perSecond: 20, burst: 40 },
  probeFullRate: { perSecond: 2, burst: 4 },
  captureRatePerSec: 1,
  ackRate: { perSecond: 200, burst: 400 },
};

describe('ViewerRateLimiters: input/control scoped per target', () => {
  it("exhausting target A's input budget does not throttle target B's input on the same connection", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(limiters.take('input', 0, 'tgt_a')).toBe(true);
    }
    // Target A's own burst (10 tokens) is now spent.
    expect(limiters.take('input', 0, 'tgt_a')).toBe(false);

    // Target B, same connection, same instant: a fresh, full budget.
    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(limiters.take('input', 0, 'tgt_b')).toBe(true);
    }
    expect(limiters.take('input', 0, 'tgt_b')).toBe(false);
  });

  it('the same holds for control', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);
    for (let i = 0; i < LIMITS.controlRatePerSec.burst; i++) {
      expect(limiters.take('control', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('control', 0, 'tgt_a')).toBe(false);
    expect(limiters.take('control', 0, 'tgt_b')).toBe(true);
  });

  it('connection-wide buckets (nav, cursor, probeFull, capture, ack) are unaffected: still one budget shared across every target', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);
    for (let i = 0; i < LIMITS.navRatePerSec.burst; i++) {
      expect(limiters.take('nav', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('nav', 0, 'tgt_a')).toBe(false);
    // A different targetId does not get its own nav budget: this bucket is
    // deliberately still connection-wide (see the module doc comment on
    // `PER_TARGET_BUCKETS`).
    expect(limiters.take('nav', 0, 'tgt_b')).toBe(false);
  });

  it('an input message with no resolvable targetId still gets rate limited, in one shared bucket, rather than bypassing the check', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);
    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(limiters.take('input', 0, undefined)).toBe(true);
    }
    expect(limiters.take('input', 0, undefined)).toBe(false);
  });
});

/**
 * The `ack` bucket, keyed per stream rather than once per connection.
 *
 * This one was found by measurement, not by review, and the failure did not
 * look like a rate limit at all. `parallel-live-streams.test.ts` ran three
 * concurrent live streams at ~100fps each; all three were healthy for
 * 4044ms, then exactly ONE went to a hard zero and never came back while
 * its two siblings carried on untouched.
 *
 * The arithmetic behind that number: an ack is sent per frame the server
 * chose to send, so three streams at ~100fps generate ~300 acks/sec against
 * `DEFAULT_LIMITS.ackRate` of 200/sec with a 400 token burst. The burst
 * drains at the 100/sec difference and empties after about four seconds.
 *
 * What makes it starve rather than stutter is that dropping an ack is not
 * self correcting: the server's `Attachment` stops sending once `maxBacklog`
 * (3) unacked frames are outstanding, and the only thing that drains that
 * backlog is the acks now being refused.
 */
/**
 * Shared control is the first thing that puts
 * several SENDERS on one target's `input` bucket, so the connection half of
 * the `(connection, target)` key stops being incidental and starts being the
 * thing that keeps two people able to drag in the same tab at the same time.
 *
 * `ViewerRateLimiters` is constructed once per `Connection`
 * (`ws/connection.ts`'s `ensureRateLimiters`), so two viewers are two
 * instances. These tests state that as a contract rather than leaving it as
 * a fact about where the constructor happens to be called, because the
 * tempting "simplification" is a session-wide per target input budget, and
 * that one fails silently: N drivers divide one budget, and the driver who
 * loses the race has a `mouse.up` refused, which leaves a button held down
 * for EVERYONE on that tab. `resolveInputFencing`'s "never drop releases"
 * rule cannot save it, because the limiter runs before any handler and never
 * sees the kind.
 */
describe('ViewerRateLimiters: shared control, several drivers on one target', () => {
  it('two viewers driving the SAME target each get their own full input budget', () => {
    const driverA = new ViewerRateLimiters(LIMITS, 0);
    const driverB = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(driverA.take('input', 0, 'tgt_shared')).toBe(true);
    }
    expect(driverA.take('input', 0, 'tgt_shared')).toBe(false);

    // Same target, same instant, different connection. Under a session-wide
    // per target budget this whole loop is refused and B's drag freezes
    // because A happened to be dragging harder.
    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(driverB.take('input', 0, 'tgt_shared')).toBe(true);
    }
  });

  it('three drivers each sending at the per-viewer rate all keep sending indefinitely', () => {
    // The measured shape of the ack finding, applied to input before it can
    // happen again: sustained load, not a burst, because a burst hides the
    // refill arithmetic that decides whether a bucket recovers or empties.
    const drivers = [
      new ViewerRateLimiters(LIMITS, 0),
      new ViewerRateLimiters(LIMITS, 0),
      new ViewerRateLimiters(LIMITS, 0),
    ];
    let refused = 0;
    // Ten seconds, stepped in 100ms ticks, each driver sending its full
    // `inputRatePerSec` share of events per second at one target.
    for (let tick = 0; tick < 100; tick++) {
      const nowMono = tick * 100;
      for (const driver of drivers) {
        for (let i = 0; i < LIMITS.inputRatePerSec / 10; i++) {
          if (!driver.take('input', nowMono, 'tgt_shared')) refused += 1;
        }
      }
    }
    expect(refused).toBe(0);
  });

  it('a driver exhausting one target still has a full budget for a second target', () => {
    // The window-isolation half of the same key, restated for the shared
    // case: a person driving two shared tabs at once must not have one
    // starve the other.
    const driver = new ViewerRateLimiters(LIMITS, 0);
    for (let i = 0; i < LIMITS.inputRatePerSec; i++) {
      expect(driver.take('input', 0, 'tgt_shared')).toBe(true);
    }
    expect(driver.take('input', 0, 'tgt_shared')).toBe(false);
    expect(driver.take('input', 0, 'tgt_other')).toBe(true);
  });
});

describe('ViewerRateLimiters: ack scoped per stream', () => {
  it("exhausting stream 1's ack budget does not stop stream 2's acks on the same connection", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < LIMITS.ackRate.burst; i++) {
      expect(limiters.take('ack', 0, '1')).toBe(true);
    }
    expect(limiters.take('ack', 0, '1')).toBe(false);

    // Stream 2, same connection, same instant: a full budget of its own.
    // Connection-wide, this assertion failed, and the stream behind it
    // stalled permanently.
    for (let i = 0; i < LIMITS.ackRate.burst; i++) {
      expect(limiters.take('ack', 0, '2')).toBe(true);
    }
  });

  it('three streams each acking at 100/sec all keep acking past the point a shared budget would have emptied', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);
    const streams = ['1', '2', '3'];

    // Ten seconds at 100 acks per stream per second, stepped in 10ms ticks
    // so the buckets refill exactly as they would in real time. A shared
    // 200/sec bucket empties around the four second mark; per stream, each
    // is drawing 100/sec against its own 200/sec refill and never runs dry.
    let refused = 0;
    for (let tick = 0; tick < 1000; tick++) {
      const nowMono = tick * 10;
      for (const streamId of streams) {
        if (!limiters.take('ack', nowMono, streamId)) refused += 1;
      }
    }
    expect(refused).toBe(0);
  });
});

/**
 * The `probeFull` bucket, keyed per target rather than once per connection.
 *
 * Found the same way as the `ack` one: by a test failing for a reason that
 * looked nothing like a rate limit. `drag-select-parallel.test.ts` polls
 * three panes' report bands through `client.probe()`, and every read came
 * back `Rate limit exceeded for target.probe`, which is indistinguishable
 * from a page that never responded.
 *
 * `probeFullRate` is deliberately tight (2/sec, burst 4) because a full
 * probe is expensive. Connection-wide that becomes 2/sec shared across
 * every pane, so three panes hit-testing their own hover state get 0.67/sec
 * each and the third to ask is simply refused. Per target restores the
 * budget a single-pane app always had, and the total stays bounded by
 * `maxTargets`.
 */
describe('ViewerRateLimiters: probeFull scoped per target', () => {
  it("exhausting target A's probe budget does not refuse target B's probes on the same connection", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < LIMITS.probeFullRate.burst; i++) {
      expect(limiters.take('probeFull', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('probeFull', 0, 'tgt_a')).toBe(false);

    for (let i = 0; i < LIMITS.probeFullRate.burst; i++) {
      expect(limiters.take('probeFull', 0, 'tgt_b')).toBe(true);
    }
  });
});

/**
 * The `console`/`pageError`/`network` buckets, scoped per target like `input`/`control`/`probeFull` above.
 *
 * Unlike every other bucket in this file, these three are never checked
 * against an INBOUND message: they cap OUTBOUND diagnostics pushes the
 * server itself decides to send (`console.entry`/`page.error`/`network.request`/
 * `network.summary`), gated in `Connection.sendEnvelope()`, not
 * `ws/connection.ts`'s inbound `dispatch()`/`bucketFor()` path (see
 * `wire/rate-limit.ts`'s `RateBucketName` doc for why). This suite exercises
 * `ViewerRateLimiters` directly, the same way the inbound buckets above are
 * tested, since the scoping rule itself (per target, not per connection) is
 * identical either direction: a `console.log` loop on one pane must not
 * exhaust the budget a sibling pane's own diagnostics traffic needs.
 */
describe('ViewerRateLimiters: console/pageError/network scoped per target', () => {
  it("exhausting target A's console budget does not refuse target B's console entries on the same connection", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    // Burst for `console` (20/sec, burst 40) is not part of `LIMITS` above:
    // these three buckets have their own internal defaults
    // (`DIAGNOSTICS_BUCKET_DEFAULTS`), not threaded through `welcome.limits`.
    for (let i = 0; i < 40; i++) {
      expect(limiters.take('console', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('console', 0, 'tgt_a')).toBe(false);

    for (let i = 0; i < 40; i++) {
      expect(limiters.take('console', 0, 'tgt_b')).toBe(true);
    }
  });

  it('the same holds for pageError and network, each with its own scope and its own budget', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < 10; i++) {
      expect(limiters.take('pageError', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('pageError', 0, 'tgt_a')).toBe(false);
    expect(limiters.take('pageError', 0, 'tgt_b')).toBe(true);

    for (let i = 0; i < 60; i++) {
      expect(limiters.take('network', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('network', 0, 'tgt_a')).toBe(false);
    expect(limiters.take('network', 0, 'tgt_b')).toBe(true);

    // `pageError`'s own budget on target A is independent of `network`'s:
    // exhausting one bucket for a target does not touch a sibling bucket
    // for the SAME target, only the same bucket for a different target is
    // guaranteed fresh.
    expect(limiters.take('pageError', 0, 'tgt_a')).toBe(false);
  });
});

/**
 * `evaluate` and `evaluateInternal`, `ws/connection.ts`'s two buckets
 * behind `page.evaluate` and `page.evaluate.internal`
 * (`@browserglass/protocol`'s `PageEvaluateInternal`).
 *
 * Before this split, the locator surface's own resolve/verify bookkeeping
 * (`AutomationClient`'s `evaluateFunction` port) went out as an ordinary
 * `page.evaluate` and spent from the exact same bucket a caller's own
 * `evaluate()`/`waitForFunction()` calls draw from. A single `fill()`
 * call's verify retry loop (up to six `READ_SCRIPT` round trips) could
 * exhaust that shared bucket and trip the caller's NEXT, unrelated
 * `page.evaluate` with a rate-limit refusal, which is exactly the "a
 * library taxing its user's own budget for its own bookkeeping" failure
 * this suite guards against.
 *
 * Neither bucket is part of `LIMITS` above (same reason `console`/
 * `pageError`/`network` are not, see that suite's own comment): both have
 * internal defaults, `EVALUATE_BUCKET_DEFAULT` (30/sec, burst 60) and
 * `INTERNAL_EVALUATE_BUCKET_DEFAULT` (15/sec, burst 15), so this suite
 * uses those numbers directly rather than importing the un-exported
 * constants.
 */
describe('ViewerRateLimiters: evaluate and evaluateInternal are separate, per-target budgets', () => {
  it("a caller-originated evaluate flood is still limited: exhausting a target's evaluate budget refuses further page.evaluate calls on it", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < 60; i++) {
      expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(false);
  });

  it('exhausting one target does not throttle evaluate on a sibling target on the same connection', () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < 60; i++) {
      expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(false);
    expect(limiters.take('evaluate', 0, 'tgt_b')).toBe(true);
  });

  it("SDK-internal locator bookkeeping (evaluateInternal) no longer exhausts the caller's own evaluate allowance", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    // Drain evaluateInternal completely: the worst case this bucket was
    // sized for, a fill() verify retry loop's roughly eight internal
    // round trips, and then some.
    for (let i = 0; i < 15; i++) {
      expect(limiters.take('evaluateInternal', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluateInternal', 0, 'tgt_a')).toBe(false);

    // The caller's own evaluate budget on the SAME target is untouched:
    // this is the exact regression the split exists to prevent. Before
    // the split, both kinds of call shared one bucket and this assertion
    // would have started failing partway through the loop above.
    for (let i = 0; i < 60; i++) {
      expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(false);
  });

  it("conversely, a caller's own evaluate flood does not exhaust evaluateInternal's budget on the same target", () => {
    const limiters = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < 60; i++) {
      expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluate', 0, 'tgt_a')).toBe(false);

    for (let i = 0; i < 15; i++) {
      expect(limiters.take('evaluateInternal', 0, 'tgt_a')).toBe(true);
    }
    expect(limiters.take('evaluateInternal', 0, 'tgt_a')).toBe(false);
  });

  it('evaluateInternal is kept per (connection, target), the same as evaluate: two viewers, or two targets, each get their own budget', () => {
    const driverA = new ViewerRateLimiters(LIMITS, 0);
    const driverB = new ViewerRateLimiters(LIMITS, 0);

    for (let i = 0; i < 15; i++) {
      expect(driverA.take('evaluateInternal', 0, 'tgt_shared')).toBe(true);
    }
    expect(driverA.take('evaluateInternal', 0, 'tgt_shared')).toBe(false);
    // A different connection driving the same target starts with a full
    // budget of its own; a connection-wide bucket (the regression
    // `input`/`ack`/`probeFull` already guard against for other verbs)
    // would have this refused too.
    expect(driverB.take('evaluateInternal', 0, 'tgt_shared')).toBe(true);

    const single = new ViewerRateLimiters(LIMITS, 0);
    for (let i = 0; i < 15; i++) {
      expect(single.take('evaluateInternal', 0, 'tgt_a')).toBe(true);
    }
    expect(single.take('evaluateInternal', 0, 'tgt_a')).toBe(false);
    expect(single.take('evaluateInternal', 0, 'tgt_b')).toBe(true);
  });
});
