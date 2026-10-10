/**
 * Token-bucket rate limiting for the `bgls.v1` message loop. Every INBOUND
 * bucket (input, control, nav, cursor, probe.full, capture, ack, and the raw
 * inbound-byte budget) is enforced *before any work is done*, before
 * parsing the payload beyond `t`: a connection's dispatcher checks the relevant bucket the
 * instant it reads `t`, and only then decodes the rest of the envelope.
 * Reading `msg['targetId']` off the already-parsed JSON object at that same
 * point (needed for the `input`/`control` buckets below) is free: the
 * envelope is already a JS object by then, this is a property read, not
 * additional parsing.
 *
 * Three OUTBOUND buckets (`console`, `pageError`, `network`) were added for
 * the diagnostics feeds; see {@link RateBucketName}'s own
 * doc comment for why they are checked at a different place entirely
 * (`Connection.sendEnvelope()`, not the inbound dispatcher above).
 *
 * `input` and `control` are keyed per `(connection, targetId)`, not once per
 * connection: see {@link PER_SCOPE_BUCKETS}'s doc comment for why a
 * connection-wide budget for those two specifically defeats window
 * isolation's whole point of driving several targets at once, and for why
 * shared control's several-viewers-on-one-target case needs the CONNECTION
 * half of that key just as badly.
 *
 * Every timer this module could plausibly need is a plain elapsed-time
 * computation against an injected monotonic clock reading, never a real
 * `setTimeout`/`setInterval`, so there is nothing here for universal rule 3
 * (`.unref?.()`) to apply to.
 */

import type { RateLimit } from '@browserglass/protocol';

/** One token bucket: `burst` capacity, refilling at `perSecond` tokens per second, seeded full. */
export class TokenBucket {
  private tokens: number;
  private lastRefillMono: number;
  private readonly capacity: number;
  private readonly refillPerMs: number;

  constructor(limit: RateLimit, nowMono: number) {
    this.capacity = Math.max(1, limit.burst);
    this.refillPerMs = limit.perSecond / 1000;
    this.tokens = this.capacity;
    this.lastRefillMono = nowMono;
  }

  private refill(nowMono: number): void {
    const elapsedMs = Math.max(0, nowMono - this.lastRefillMono);
    if (elapsedMs <= 0) return;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * this.refillPerMs);
    this.lastRefillMono = nowMono;
  }

  /** Attempts to take `cost` tokens (default 1). Returns whether the bucket had enough. */
  take(nowMono: number, cost = 1): boolean {
    this.refill(nowMono);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Current token count, for diagnostics/tests. */
  peek(nowMono: number): number {
    this.refill(nowMono);
    return this.tokens;
  }

  /**
   * Milliseconds until `cost` tokens are available again, 0 when they
   * already are. Feeds the `retryAfterMs` of a `bgls.error.limit.rate`
   * reply, so a client that waits exactly this long succeeds.
   */
  msUntil(nowMono: number, cost = 1): number {
    this.refill(nowMono);
    const missing = Math.min(cost, this.capacity) - this.tokens;
    if (missing <= 0) return 0;
    if (this.refillPerMs <= 0) return Number.POSITIVE_INFINITY;
    return Math.ceil(missing / this.refillPerMs);
  }
}

/** A plain per-second bucket (`inputRatePerSec`), expressed as a {@link RateLimit} with `burst` equal to the rate itself. */
export function perSecondAsRateLimit(perSecond: number): RateLimit {
  return { perSecond, burst: Math.max(1, perSecond) };
}

/**
 * The named buckets one {@link ViewerRateLimiters} instance tracks. Every
 * name but the last three governs an INBOUND message class from
 * `welcome.limits`/`Limits` (`@browserglass/protocol`), checked by
 * `ws/connection.ts`'s `dispatch()` before a handler runs, via `bucketFor()`.
 *
 * `console`, `pageError` and `network` are the odd ones out: they cap
 * OUTBOUND diagnostics traffic (`console.entry`, `page.error`,
 * `network.request`/`network.summary`), which the server itself decides to send, not a message a client ever
 * transmits. There is nothing for them in `bucketFor()`, deliberately: that
 * function only ever sees inbound `t`s. They are checked instead at the one
 * place every outbound envelope funnels through regardless of who produced
 * it, `Connection.sendEnvelope()`, gating a page in a `console.log` loop (or
 * a target with heavy network traffic) from drowning the socket the video
 * streams share, the same concern the module doc's `ack` finding already
 * describes for inbound acks starving a sibling stream.
 */
export type RateBucketName =
  | 'input'
  | 'control'
  | 'nav'
  | 'cursor'
  | 'probeFull'
  | 'capture'
  | 'ack'
  | 'evaluate'
  | 'evaluateInternal'
  | 'pagemap'
  | 'console'
  | 'pageError'
  | 'network';

/**
 * `input` and `control` are the two bucket names window isolation needs
 * scoped per target rather than once for the whole connection.
 * `Limits.inputRatePerSec`'s own doc comment calls it a "per-viewer" rate,
 * and that was true when at most one target on an Instance could ever be
 * driven live at a time: "per viewer" and "per viewer per target"
 * were the same thing. Window isolation makes several targets drivable at
 * once, and a single shared 300/sec input
 * budget (60/sec for control) across every one of them means dragging
 * hard in two or three panes at once starves a fourth, which reproduces
 * the "several browsers can never be driven at once" symptom that window
 * isolation fixes, just from a different mechanism than the active-target
 * steal. `cursor` stays connection-wide: its ceiling is already generous
 * relative to how often a viewer actually moves a shared cursor.
 *
 * `capture` (`target.capture`, `page.pdf.get`, `recording.start`) is scoped
 * per TARGET. It used to be one connection-wide bucket at 1/sec, which was
 * sized for a person clicking "save screenshot" and nothing else. An
 * automation script that screenshots after every step, a visual test, or a
 * swarm of agents each owning a tab all share one connection and were
 * refused the second screenshot inside a second, across every tab at once.
 * Per target, each tab gets `captureRate` (5/sec, burst 10 by default) and
 * the total stays bounded by `maxTargets`. The cost per call is one CDP
 * round trip plus an encode, which Chrome serialises per renderer anyway,
 * so a per target budget tracks the real resource being protected.
 *
 * `nav` is scoped per TARGET too. One person rarely navigates faster than
 * 4/sec, but one script driving several panes does: back, forward and
 * reload across four targets at once is 12 messages in a breath, and a
 * connection-wide burst of 8 refused the ninth.
 * `parallel-live-streams.test.ts` read `Rate limit exceeded for nav.back`
 * on fast CI runners for exactly that reason. Per target, each pane keeps
 * the budget a single-pane app always had, bounded overall by `maxTargets`.
 *
 * `probeFull` is scoped per TARGET, for the same reason and found the same
 * way. Its ceiling is deliberately tight (2/sec, burst 4) because a full
 * probe is expensive, but connection-wide that becomes 2/sec shared across
 * every pane: three panes hit-testing their own hover state get 0.67/sec
 * each, and the third one to ask is simply refused. `drag-select-parallel.test.ts`
 * hit exactly that while polling three panes' report bands and read
 * `Rate limit exceeded for target.probe` on all three, which looks like the
 * page never responded rather than like a limiter. A per-target budget
 * keeps the per-pane cost identical to what a single-pane app always had,
 * and the total stays bounded by `maxTargets` (24).
 *
 * `ack` is scoped per STREAM, for a sharper version of the same problem,
 * and it was measured rather than reasoned about. An ack is not a viewer
 * action at all: the client sends exactly one per frame the SERVER chose to
 * send it. `ackRate` is 200/sec with a burst of 400
 * (`DEFAULT_LIMITS`, `packages/protocol/src/wire/limits.ts`), which was
 * ample while at most one target per Instance could stream live, because
 * one stream cannot outrun it. Three concurrent live streams at ~100fps
 * produce ~300 acks/sec against a 200/sec refill, so the 400 token burst
 * drains at 100/sec and empties after about four seconds.
 *
 * `parallel-live-streams.test.ts` caught exactly that, and the shape of the
 * failure is worth recording because it does not look like a rate limit:
 * three streams ran at ~100fps each for 4044ms, then ONE of them went to a
 * hard zero and never recovered, while its two siblings carried on
 * untouched. Dropping an ack is not self correcting. The server's
 * `Attachment` stops sending once `maxBacklog` (3) unacked frames are
 * outstanding, and the only thing that drains that backlog is the acks that
 * are now being refused, so whichever stream loses the race starves
 * permanently while the others keep theirs.
 *
 * Per stream keeps the abuse protection that motivated the bucket (a client
 * still cannot flood acks for any one stream) while removing the coupling
 * that made one stream's frame rate depend on how many other streams the
 * same socket happened to be carrying.
 *
 * ── Shared control: why `input` is per `(CONNECTION, target)` ──
 *
 * Shared control (`LeaseMode = 'shared'`) lets several viewers drive ONE target at
 * once, which is the first time the `input` bucket has ever had more than
 * one sender per target. That makes the CONNECTION half of the key
 * load-bearing in a way it was not before, so it was re-derived rather than
 * assumed, and the conclusion is that the existing scoping is already right
 * and must not be changed to per target.
 *
 * The scoping is per `(connection, target)` because {@link ViewerRateLimiters}
 * is constructed once per `Connection` (`ws/connection.ts`'s
 * `ensureRateLimiters`) and `take('input', ..., targetId)` then keys within
 * it by target. `@browserglass/core`'s own `InputDispatcher.buckets` keys
 * identically, by `(viewerId, targetId)`, so both layers agree.
 *
 * A SESSION-WIDE per target `input` budget is the tempting alternative and
 * it is the ack finding above all over again, with a worse ending. Three
 * people dragging in the same tab would divide one 300/sec budget three
 * ways, and the loser of the race is simply refused. Unlike an ack there is
 * nothing self correcting about that: a refused `mouse.move` mid drag is a
 * visible jump, and a refused `mouse.up` leaves a button stuck down for
 * EVERY driver of that tab, because CDP has no idea a release was ever
 * attempted. That is precisely the failure `resolveInputFencing`'s release
 * asymmetry exists to prevent ("NEVER drop releases"),
 * defeated one layer above it by a limiter that runs before any handler
 * does and therefore never sees the kind.
 *
 * The accepted cost is that N drivers on one target get N budgets, so the
 * aggregate CDP input rate for a hotly shared tab scales with the number of
 * drivers. That is deliberate: input dispatch is cheap relative to
 * screencast encoding, the driver count is bounded by how many people are
 * actually in the session, and the alternative is a limiter that gets
 * quieter and more dangerous the more useful the feature is being.
 */
const PER_SCOPE_BUCKETS: ReadonlySet<RateBucketName> = new Set([
  'input',
  'control',
  'nav',
  'capture',
  'ack',
  'probeFull',
  'evaluate',
  'evaluateInternal',
  'pagemap',
  'console',
  'pageError',
  'network',
]);

/**
 * Defaults for the three OUTBOUND diagnostics buckets (`console`,
 * `pageError`, `network`; see {@link RateBucketName}'s doc). Unlike every
 * other bucket's limit, these are not read off `welcome.limits`/`Limits`
 * (`@browserglass/protocol`): threading a new negotiated rate through that
 * type, plus `wire/welcome-fields.ts`'s `rateLimitInputsFor()`, is a
 * larger cross-package change than these defaults justify. Chosen
 * generously relative to how often a real page actually logs or issues
 * requests, since the point is dropping a genuine flood
 * (the collector side of this feature already makes the same "coalesce,
 * cap per target, drop past the cap" call; this is the same choice applied at delivery), not throttling
 * ordinary use.
 */
const DIAGNOSTICS_BUCKET_DEFAULTS: Readonly<
  Record<'console' | 'pageError' | 'network', RateLimit>
> = Object.freeze({
  console: { perSecond: 20, burst: 40 },
  pageError: { perSecond: 5, burst: 10 },
  network: { perSecond: 30, burst: 60 },
});

/**
 * The `evaluate` bucket's limit (`page.evaluate`,
 * `@browserglass/protocol`'s `./wire/messages/evaluate.ts`). Not read off
 * `welcome.limits`/`Limits` for the same reason the three diagnostics
 * buckets above are not: adding a negotiated rate to that type, and to
 * `wire/welcome-fields.ts`'s `rateLimitInputsFor()`, is a cross-package
 * change not worth making yet. Revisit if evaluation ever needs a
 * per-tenant rate.
 *
 * Scoped PER TARGET (see {@link PER_SCOPE_BUCKETS}) for the same reason
 * `probeFull` is: an agent polling three tabs' readiness with
 * `waitForFunction` must not have the third tab starved by the first two.
 *
 * 30/sec with a burst of 60, raised from 10/20. The original 10/sec was
 * sized ASSUMING every locator verb's own internal bookkeeping (`resolve`,
 * `waitFor`, a `fill()` verify retry) spent from this same bucket, which
 * is what made a single `fill()` call able to exhaust it and trip the
 * NEXT unrelated `page.evaluate` with `POLICY_DENIED Rate limit exceeded`
 * (the failure `locator/engine.ts`'s own `VERIFY_BACKOFF_MS` comment
 * documents). That traffic now goes out as `page.evaluate.internal`
 * against its own `evaluateInternal` bucket instead (see that bucket's
 * doc, and `AutomationClient`'s `locators` getter), so this bucket is
 * once again purely a caller's own `evaluate()`/`waitForFunction()` rate.
 * Even so, 10/sec is tight for a real automation loop driving several
 * conditions at once, and a swarm of parallel agents makes "one caller, one target, occasional polling" the common
 * case rather than the rare one. 30/sec keeps three `waitForFunction`
 * polls per target running at their default ~10/sec cadence at once, or
 * one poll with headroom for ad hoc `evaluate()` calls alongside it,
 * while staying bounded: each call still occupies a renderer thread for
 * as long as the caller's script runs, so a caller wanting more
 * throughput should still do more work per call rather than more calls.
 */
const EVALUATE_BUCKET_DEFAULT: RateLimit = Object.freeze({ perSecond: 30, burst: 60 });

/**
 * The `evaluateInternal` bucket's limit: `page.evaluate.internal`
 * (`@browserglass/protocol`'s `PageEvaluateInternal`), the locator
 * surface's own resolve/verify bookkeeping, split out of `evaluate` above
 * so it is never charged against a caller's own budget. See that
 * message's module doc for why this is an accounting split enforced by
 * the wire message TYPE (not a client-asserted flag `checkCapability`
 * would have to trust), and why the split cannot become a general
 * rate-limit bypass: this bucket still gates the same `evaluate`
 * capability and the same target/session scoping `page.evaluate` does, it
 * is simply a second, SMALLER meter on the same door, sized to what
 * genuine bookkeeping actually needs rather than to general scripting.
 *
 * Sized from the worst real internal burst in this codebase: `fill()`'s
 * verify retry loop (`locator/engine.ts`'s `VERIFY_BACKOFF_MS`) issues up
 * to six `READ_SCRIPT` round trips backed off at 25/50/100/200/400/800ms,
 * roughly eight internal calls (that retry loop plus the initial read and
 * `resolve()`'s own call before it) inside about two seconds. 15/sec with
 * a burst of 15 clears that with real headroom and leaves room for a
 * `click()`'s occasional `resolve()`/`waitFor()`/`DISPATCH_CLICK_SCRIPT`
 * calls interleaved on the same target, while staying small enough that a
 * client routing raw traffic through this door instead of `page.evaluate`
 * gains only that modest, bounded throughput, never an escape from rate
 * limiting altogether.
 *
 * Scoped PER TARGET, same as `evaluate`: see {@link PER_SCOPE_BUCKETS}.
 */
const INTERNAL_EVALUATE_BUCKET_DEFAULT: RateLimit = Object.freeze({ perSecond: 15, burst: 15 });

/**
 * The `pagemap` bucket's limit: `page.map.get`/`page.map.stamp`
 * (`@browserglass/protocol`'s `wire/messages/pagemap.ts`). Its own bucket
 * rather than `evaluate`, per that message's own module doc: "One page map
 * is three CDP round trips plus one per frame plus a whole-tree decode, so
 * bucketing it with evaluate hands a caller the ability to spend the
 * entire evaluate budget of the connection on calls that cost roughly ten
 * times what an evaluate does".
 *
 * Not read off `welcome.limits`/`Limits`, for the same cross-package-scope
 * reason {@link EVALUATE_BUCKET_DEFAULT} above is not.
 *
 * 3/sec with a burst of 6: {@link EVALUATE_BUCKET_DEFAULT}'s 30/sec divided
 * by the "roughly ten times" cost ratio above, rounded down
 * rather than up so a caller cannot spend page-map-equivalent CDP work at
 * evaluate's own rate by simply calling the cheaper-per-call door more
 * often. No measurement backs the exact number; revisit once a
 * real capture's wall-clock cost is measured against a live target.
 * `page.map.stamp` shares this bucket with `page.map.get` rather than
 * getting its own: a stamp costs at most `MAX_PAGEMAP_STAMP_INDICES`
 * (`@browserglass/protocol`) `DOM.setAttributeValue` calls plus zero to one
 * `DOM.pushNodesByBackendIdsToFrontend`, the same cost class as one
 * capture's own per-frame fan-out, and it never runs
 * without a prior `page.map.get` against the same target (the epoch check
 * refuses an unknown or stale epoch before any CDP
 * command goes out), so it is never the first or only page-map traffic a
 * caller sends.
 *
 * Scoped PER TARGET (see {@link PER_SCOPE_BUCKETS}), matching `evaluate`
 * and `probeFull`: an agent polling one tab's page map must not starve a
 * sibling tab's.
 */
const PAGEMAP_BUCKET_DEFAULT: RateLimit = Object.freeze({ perSecond: 3, burst: 6 });

/**
 * Every rate bucket for one viewer socket, plus the raw inbound-byte budget
 * (`security.maxInboundBytesPerMin`). Constructed once
 * per connection from the negotiated {@link Limits}.
 */
export class ViewerRateLimiters {
  private readonly limits: {
    readonly inputRatePerSec: number;
    readonly controlRatePerSec: RateLimit;
    readonly navRatePerSec: RateLimit;
    readonly cursorRate: RateLimit;
    readonly probeFullRate: RateLimit;
    readonly captureRate: RateLimit;
    readonly ackRate: RateLimit;
  };
  private readonly connectionBuckets: Record<
    Exclude<
      RateBucketName,
      | 'input'
      | 'control'
      | 'nav'
      | 'capture'
      | 'ack'
      | 'probeFull'
      | 'evaluate'
      | 'evaluateInternal'
      | 'pagemap'
      | 'console'
      | 'pageError'
      | 'network'
    >,
    TokenBucket
  >;
  /** `input`/`control`/`ack` buckets, one per `(bucket name, scope)` pair, created lazily on first use. Never pruned when a target closes, same tolerated per-target growth as `core`'s own `InputDispatcher.buckets` (`packages/core/src/input/dispatcher.ts`): a session drives a bounded number of targets in practice, and one abandoned `TokenBucket` (two numbers) per target that ever sent input is not worth a teardown hook this class has no target-lifecycle visibility to drive correctly anyway. */
  private readonly perScopeBuckets = new Map<string, TokenBucket>();
  private readonly inboundBytesBucket: TokenBucket;

  constructor(
    limits: {
      readonly inputRatePerSec: number;
      readonly controlRatePerSec: RateLimit;
      readonly navRatePerSec: RateLimit;
      readonly cursorRate: RateLimit;
      readonly probeFullRate: RateLimit;
      readonly captureRate: RateLimit;
      readonly ackRate: RateLimit;
    },
    nowMono: number,
    maxInboundBytesPerMin = 8 * 1024 * 1024,
  ) {
    this.limits = limits;
    this.connectionBuckets = {
      cursor: new TokenBucket(limits.cursorRate, nowMono),
    };
    // `maxInboundBytesPerMin` bytes per 60000ms, expressed as a token bucket
    // seeded full so a burst at connect time does not immediately trip it.
    this.inboundBytesBucket = new TokenBucket(
      { perSecond: maxInboundBytesPerMin / 60, burst: maxInboundBytesPerMin },
      nowMono,
    );
  }

  /**
   * `scope` is required for the {@link PER_SCOPE_BUCKETS} names: the
   * `targetId` for `'input'`/`'control'`/`'nav'`/`'capture'`/`'probeFull'`/`'evaluate'`/`'evaluateInternal'`/`'pagemap'`/`'console'`/`'pageError'`/`'network'`,
   * the `streamId` for `'ack'`. A
   * message of one of those types with no resolvable scope (malformed, and
   * rejected by validation downstream regardless) falls into one shared
   * `''`-keyed bucket rather than bypassing rate limiting altogether.
   */
  take(name: RateBucketName, nowMono: number, scope?: string, cost = 1): boolean {
    return this.bucket(name, nowMono, scope).take(nowMono, cost);
  }

  /**
   * How long the caller of a refused {@link take} should wait before the
   * same call would pass, in whole milliseconds and never below 1. Sent as
   * the reply's `retryAfterMs`. Looking the bucket up here creates it if a
   * caller asks before ever taking, which is harmless: it is seeded full.
   */
  retryAfterMs(name: RateBucketName, nowMono: number, scope?: string, cost = 1): number {
    const ms = this.bucket(name, nowMono, scope).msUntil(nowMono, cost);
    return Number.isFinite(ms) ? Math.max(1, ms) : 1000;
  }

  private bucket(name: RateBucketName, nowMono: number, scope?: string): TokenBucket {
    if (PER_SCOPE_BUCKETS.has(name)) {
      const key = `${name} ${scope ?? ''}`;
      let bucket = this.perScopeBuckets.get(key);
      if (!bucket) {
        const limit =
          name === 'input'
            ? perSecondAsRateLimit(this.limits.inputRatePerSec)
            : name === 'nav'
              ? this.limits.navRatePerSec
              : name === 'capture'
                ? this.limits.captureRate
                : name === 'ack'
                  ? this.limits.ackRate
                  : name === 'probeFull'
                    ? this.limits.probeFullRate
                    : name === 'console' || name === 'pageError' || name === 'network'
                      ? DIAGNOSTICS_BUCKET_DEFAULTS[name]
                      : name === 'evaluate'
                        ? EVALUATE_BUCKET_DEFAULT
                        : name === 'evaluateInternal'
                          ? INTERNAL_EVALUATE_BUCKET_DEFAULT
                          : name === 'pagemap'
                            ? PAGEMAP_BUCKET_DEFAULT
                            : this.limits.controlRatePerSec;
        bucket = new TokenBucket(limit, nowMono);
        this.perScopeBuckets.set(key, bucket);
      }
      return bucket;
    }
    return this.connectionBuckets[
      name as Exclude<
        RateBucketName,
        | 'input'
        | 'control'
        | 'nav'
        | 'capture'
        | 'ack'
        | 'probeFull'
        | 'evaluate'
        | 'evaluateInternal'
        | 'pagemap'
        | 'console'
        | 'pageError'
        | 'network'
      >
    ];
  }

  /** The raw per-socket inbound byte budget, checked ahead of every bucket above (a message that fails this never reaches type dispatch at all). */
  takeInboundBytes(nowMono: number, byteLength: number): boolean {
    return this.inboundBytesBucket.take(nowMono, byteLength);
  }
}
