import type { WebSocketConstructorLike } from '@browserglass/client';
import { AutomationClient } from './client/AutomationClient.js';
import { AutomationError } from './errors.js';
import type { LaunchOptions } from './launch.js';
import type { ControlYieldEvent } from './types.js';

/**
 * One Instance's connection coordinates, exactly what
 * `AutomationClientOptions.endpoint`/`token`/`instanceId` need. `acquire()`
 * mints these however the caller's own deployment does it (an embedded
 * `@browserglass/router`, a remote gateway's own REST endpoint, a pool
 * with its own admission policy); see {@link BrowserSwarmOptions.acquire}.
 *
 * `acquire()` has no paired `release()` in this contract, which is a real
 * boundary, not an oversight: `BrowserSwarm` only ever closes what IT
 * opened, the `AutomationClient` connections `openOneMember()` created
 * (`close()`/`shrink()`, and a partially failed `open()`/`grow()` cleaning
 * up whatever DID connect). It never reaches back into whatever `acquire()`
 * reserved on the router/gateway side of `instanceId`, the same "no back
 * door" boundary `AutomationClient` itself keeps around the wire protocol.
 * If the caller's own admission layer needs an explicit release call
 * (most do; ephemeral profiles and pool slots are not free), that is the
 * caller's own responsibility, keyed by `instanceId` and `index` from
 * every `SwarmMember`, including in a `catch` around `open()`/`grow()`:
 * see the parallelism guide's gotchas section.
 */
export interface SwarmAcquireResult {
  instanceId: string;
  wsUrl: string;
  token: string;
}

/**
 * The second argument every `acquire()` call receives, carrying the
 * ownership decision {@link BrowserSwarmOptions.subject} expresses.
 * `BrowserSwarm` cannot act on this itself: it never talks to a router, so
 * an `acquire()` that ignores `ctx` still compiles and still works exactly
 * as it did before this argument existed. What the swarm DOES own is the
 * derivation, because getting it wrong is expensive in a way that is hard
 * to see from a call site.
 *
 * The derivation, and why it is per member rather than per swarm: the
 * router's sticky reuse (`packages/router/src/router/reuse.ts`,
 * `findReusable` step 2) resolves one subject to at most ONE instance, the
 * most recently active one that is still shareable. Hand the same subject
 * to all 20 members of a swarm and the 20 concurrent acquires do not
 * produce 20 reattached browsers; they converge, nondeterministically,
 * onto whichever instances happen to be visible when each call runs its
 * reuse check, so a swarm asked for 20 comes back holding 20 clients
 * pointed at a handful of browsers. That is the same defect as spawning 20
 * fresh Chromes, just inverted, and it is quieter. So one subject per
 * MEMBER SLOT (`<swarm subject>#<index>`) is the only derivation that
 * makes "give me my 20 browsers back" mean what a caller reading it thinks
 * it means: slot 3 reattaches to slot 3's browser, slot 4 to slot 4's, and
 * a slot with nothing behind it launches one.
 */
export interface SwarmAcquireContext {
  /**
   * This member slot's affinity subject, `<swarm subject>#<index>`, or
   * `undefined` when the swarm was opened without one (the default: every
   * member launches a fresh browser). An `acquire()` that honours this
   * must put it on BOTH the acquire request's `subject` (which tags the
   * instance it creates, so a later call can find it) and its
   * `sticky.subject` (which is what finds it). Setting only one of the two
   * silently degrades to "always launch"; see `docs/scaling.md`'s
   * ownership section.
   */
  readonly subject: string | undefined;
  /** Passed straight through from {@link BrowserSwarmOptions.stickyWithinMs}: how stale a member's previous browser may be and still be reattached to. `undefined` means no window, i.e. any still-live instance for that subject qualifies. */
  readonly stickyWithinMs: number | undefined;
}

/**
 * Options for {@link BrowserSwarm.open}. `acquire` is the one required,
 * caller supplied piece: everything else `BrowserSwarm` does (connect,
 * bind a target, run callers against every member concurrently, tear
 * down) is generic over however the caller gets from "I want another
 * browser" to a `wsUrl`/`token` pair. See `packages/automation/README.md`
 * for a runnable example.
 */
export interface BrowserSwarmOptions {
  /** How many members `open()` opens. Must be a positive integer. */
  size: number;
  /**
   * If given, every member `open()`/`grow()` produces is navigated here
   * before the caller ever sees it: `BrowserSwarm` acquires a lease,
   * navigates, and releases the lease again, the same three calls a
   * caller would make by hand, so no member is left holding control it
   * never asked to keep. Omit it to bind a member to whatever page its
   * Instance already has open (a fresh Instance's `about:blank`,
   * typically) and navigate it yourself inside {@link BrowserSwarm.all}.
   */
  url?: string;
  /**
   * Informational, and about something narrower than swarm size: it does
   * NOT control how many Chrome processes a swarm runs. That is `size`
   * itself, one per `acquire()` call, and `acquire()` deciding whether
   * each call launches a genuinely new Instance or attaches to one
   * already running. `isolation` is about what happens WITHIN a single
   * already-acquired Instance if more than one of its targets needs to
   * stream live at the same time (several browser TABS in one Chrome
   * window vs. several Chrome WINDOWS); `BrowserSwarm` as built here
   * binds one target per member and never opens a second tab on a
   * member's own instance, so this rarely matters for the swarm itself.
   * It matters the moment anything else (a human viewer, a second
   * automation connection) watches more than one target on the same
   * acquired Instance concurrently.
   *
   * `BrowserSwarm` never launches a browser: `acquire()` is the caller's
   * own code, and asking the router for `BrowserSpec.isolation: 'window'`
   * is `acquire()`'s job, not this option's. Recorded as
   * {@link BrowserSwarm.isolation} so a caller has something concrete to
   * assert against in its own setup; see the parallelism guide
   * (`PARALLELISM.md`) for the measured numbers behind why it matters at
   * all.
   */
  isolation?: 'tab' | 'window';
  /**
   * Acquires one Instance's connection coordinates. Called once per
   * member, concurrently: `open()`/`grow()` never await one call before
   * starting the next (`Promise.allSettled` over every call, not a `for`
   * loop), so a caller minting a fresh `requestId` per call (from
   * `index`, or omitting `requestId` entirely) gets `size` genuinely
   * distinct instances. A caller reusing one `requestId` across every
   * call gets deduped inside the router's idempotency window instead, and
   * ends up with fewer live browsers than `size` asked for, every member
   * pointed at the same instance: the parallelism guide's first gotcha.
   *
   * Pass either this or {@link launch}, not both.
   */
  acquire?(index: number, ctx: SwarmAcquireContext): Promise<SwarmAcquireResult>;
  /**
   * The no plumbing alternative to {@link acquire}: every member is opened
   * with `AutomationClient.launch(launch)` against a running gateway, each
   * with its own fresh `requestId`, so `size: 10` means ten browsers.
   *
   * ```ts
   * const swarm = await BrowserSwarm.open({ size: 10, launch: { headless: true } });
   * ```
   *
   * The swarm then owns those browsers: `close()` and `shrink()` end them
   * (`AutomationClient.release()`), and a partially failed `open()` or
   * `grow()` ends the ones that did start. The one exception is a swarm
   * with a {@link subject}: there the point is getting the same browsers
   * back next run, so `close()` and `shrink()` only close the sockets and
   * leave the browsers running. The swarm's per member subject wins over
   * any `launch.subject`.
   */
  launch?: LaunchOptions;
  /**
   * Who this swarm's browsers belong to. Omitted (the default) every
   * member launches a brand new browser and abandons it at `close()`,
   * which is the right default for a batch job: two unrelated runs of the
   * same script must not fight over one set of Chromes, and a swarm that
   * silently adopted whatever was lying around would be a much worse
   * surprise than one that costs a few seconds of launch time.
   *
   * Given, every member slot asks for the browser that slot had last time,
   * and launches only if there is none: the same run repeated, or a second
   * process passing the same subject, lands on the same N browsers rather
   * than adding N more. Pick a value that names the OWNER, not the run:
   * `nightly-crawler`, `tenant-42`, `alice@example.com`. A value that
   * changes per run (a timestamp, a uuid) is the same as omitting this,
   * with extra steps.
   *
   * This is one concept, not a swarm-local one: it becomes
   * `AcquireRequest.sticky.subject` inside whatever `acquire()` does with
   * {@link SwarmAcquireContext}, identical to the CLI's `--sticky-subject`
   * and the REST body's `sticky.subject`. See that interface for the
   * per-member derivation and why it is not the bare value.
   */
  subject?: string;
  /** How stale a member's previous browser may be and still be reattached to, in milliseconds. Omitted means no window: any still-live instance for that member's subject qualifies. Only meaningful alongside {@link BrowserSwarmOptions.subject}. */
  stickyWithinMs?: number;
  /** Passed through to every member's `AutomationClient.connect()`; the same test-double injection point `AutomationClientOptions.transport` exposes for a scripted fake in place of a real socket. */
  transport?: { WebSocketImpl?: WebSocketConstructorLike };
}

/**
 * This swarm's per-member-slot affinity subject, or `undefined` when the
 * swarm was opened without one. Exported (rather than inlined at its one
 * call site) because the value has to be reproducible from outside: a
 * caller releasing what it acquired, or a second process deliberately
 * targeting the same browser set, needs the exact same string this swarm
 * would have produced for that slot.
 */
export function swarmMemberSubject(subject: string | undefined, index: number): string | undefined {
  return subject === undefined ? undefined : `${subject}#${index}`;
}

/**
 * One member of a {@link BrowserSwarm}. `index` is an identity assigned
 * once at acquisition, not a live array position: it stays with a member
 * across `grow()`/`shrink()` rather than being renumbered when the
 * swarm's size changes.
 */
export interface SwarmMember {
  readonly index: number;
  readonly instanceId: string;
  readonly targetId: string;
  /** The affinity subject this slot was acquired under, or `undefined` if the swarm has none. Reported so a caller can see, from the member itself, whether this browser is one it can expect back next time. */
  readonly subject: string | undefined;
  /** The bound client for this member. `swarm.all(m => m.client.navigate(url))` driving every member at once is the entire reason `SwarmMember` carries more than an id. */
  readonly client: AutomationClient;
}

/**
 * One member of a swarm stood down. Delivered to
 * {@link BrowserSwarm.onControlYield}.
 *
 * The whole point of surfacing this at the swarm level is the "twenty
 * browsers, a person looking over the shoulder of ONE of them" case. Each
 * member is its own connection with its own lease, so the yield is already
 * isolated: nineteen members keep driving, untouched, and no code here
 * makes them stop. What a caller cannot easily work out for itself is
 * WHICH one was taken, because a `Promise.allSettled` fan-out reports
 * failures by array position and says nothing about who did the taking.
 * That is what `member` is here for.
 */
export interface SwarmYieldEvent {
  readonly member: SwarmMember;
  readonly notice: ControlYieldEvent;
}

/** Closes every member's client. Best effort, one member at a time: a member whose socket already died must not stop its siblings from closing. `AutomationClient.close()` is itself synchronous and already best-effort internally (`AutomationCore.destroy()`), so this needs no `Promise.allSettled` of its own. */
function closeMembers(members: readonly SwarmMember[]): void {
  for (const m of members) {
    try {
      m.client.close();
    } catch {
      // best effort, see the doc comment above
    }
  }
}

/**
 * N browsers, opened, driven, and torn down through one documented entry
 * point (api-contract-diagnostics.md section 5), rather than a caller
 * reverse engineering `examples/nextjs-demo`'s React internals to work
 * out how to acquire N instances and connect N clients by hand.
 *
 * The framing does not change for a swarm: every member is an ordinary
 * `AutomationClient`, i.e. an ordinary Viewer on its own `bgls.v1` socket
 * (`index.ts`'s own module doc, `AutomationClient`'s own class doc). A
 * swarm is `size` of those, opened together and addressed together; there
 * is no separate multi-browser wire path underneath it, and no method
 * here does anything a caller could not already do by calling
 * `AutomationClient.connect()` `size` times itself. What this class buys
 * is doing that concurrently, correctly, and with one place to close it
 * all again.
 */
export class BrowserSwarm {
  /** See {@link BrowserSwarmOptions.isolation}: recorded, not enforced. */
  readonly isolation: 'tab' | 'window' | undefined;

  /** See {@link BrowserSwarmOptions.subject}. `undefined` means this swarm launches fresh browsers and reattaches to nothing. */
  readonly subject: string | undefined;

  private readonly opts: BrowserSwarmOptions;
  private _members: SwarmMember[];
  /** The next index `acquireMembers()` hands out in the subject-less case; monotonic across the swarm's lifetime so a member's `index` stays a stable identity through `grow()`/`shrink()` rather than becoming a renumbered array position. */
  private nextIndex: number;
  /**
   * Every index currently spoken for: live members, plus the ones an
   * in-flight `acquireMembers()` has reserved but not yet opened. Only
   * {@link reserveIndexes} reads it for its own decisions, and only in the
   * subject case, where "which slot is free" is a real question rather
   * than bookkeeping (see that method). Maintained in both cases anyway,
   * because a set that is only sometimes accurate is worse than no set.
   */
  private readonly claimed: Set<number>;

  /** Subscribers to {@link onControlYield}. Held at the swarm rather than per member so a caller registers once and keeps getting events for members `grow()` adds later. */
  private readonly yieldCbs = new Set<(ev: SwarmYieldEvent) => void>();

  private constructor(opts: BrowserSwarmOptions, members: SwarmMember[]) {
    this.opts = opts;
    this.isolation = opts.isolation;
    this.subject = opts.subject;
    this._members = members;
    this.nextIndex = members.length;
    this.claimed = new Set(members.map((m) => m.index));
  }

  /**
   * Opens `opts.size` members concurrently. `Promise.allSettled` over
   * every `acquire()`+connect, not a loop awaiting one before starting
   * the next: opening N browsers one at a time defeats the entire point
   * of a swarm before a caller even gets to drive one. If any member
   * fails to open, whichever siblings DID succeed are closed again before
   * this rethrows: a partially failed `open()` must not leak connections
   * the caller never received a handle to (the same contract `close()`
   * promises for connections it did hand back).
   */
  static async open(opts: BrowserSwarmOptions): Promise<BrowserSwarm> {
    if ((opts.acquire === undefined) === (opts.launch === undefined)) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        'BrowserSwarm.open(): pass exactly one of `acquire` or `launch`',
      );
    }
    if (!Number.isInteger(opts.size) || opts.size < 1) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `BrowserSwarm.open(): size must be a positive integer, got ${opts.size}`,
      );
    }
    const swarm = new BrowserSwarm(opts, []);
    swarm._members = await swarm.acquireMembers(opts.size);
    return swarm;
  }

  /** Every currently open member, in the order `open()`/`grow()` produced them. */
  get members(): readonly SwarmMember[] {
    return this._members;
  }

  /**
   * Fires when any member of this swarm stands down, with the member
   * attached. Registered once, it covers members `grow()` opens later too.
   * Returns its own unsubscribe.
   *
   * A yield on one member disturbs no other member: every member is a
   * separate `AutomationClient` on a separate socket holding a separate
   * lease, and this callback is a notification, not a coordination point.
   * Nothing in this class stops, pauses or re-plans the siblings, and that
   * is deliberate. A swarm of twenty crawling twenty sites does not want
   * nineteen of them to down tools because a person opened one of them to
   * look at something.
   *
   * ```ts
   * swarm.onControlYield(({ member, notice }) => {
   *   if (notice.human) log(`member ${member.index} (${member.instanceId}) taken over by ${notice.byLabel}`);
   * });
   * ```
   */
  onControlYield(cb: (ev: SwarmYieldEvent) => void): () => void {
    this.yieldCbs.add(cb);
    return () => {
      this.yieldCbs.delete(cb);
    };
  }

  /**
   * Every member currently stood down, with the notice that put it there.
   * The pull-based counterpart to {@link onControlYield}, for a caller
   * that wants to ask "which of my twenty is a person on right now"
   * rather than keep a running tally from callbacks. Empty when nobody has
   * taken anything.
   */
  yielded(): SwarmYieldEvent[] {
    const out: SwarmYieldEvent[] = [];
    for (const member of this._members) {
      const notice = member.client.yieldStatus(member.targetId);
      if (notice !== null) out.push({ member, notice });
    }
    return out;
  }

  private emitYield(ev: SwarmYieldEvent): void {
    for (const cb of this.yieldCbs) {
      try {
        cb(ev);
      } catch {
        // a caller's own handler throwing must not break the member that
        // is standing down, nor any sibling: same contract as
        // `AutomationClient.onControlYield`
      }
    }
  }

  /**
   * Runs `fn` against every member CONCURRENTLY and returns one result
   * per member, in member order. `Promise.allSettled`, never
   * `Promise.all` and never a `for...of` with an `await` inside it: a
   * swarm's whole point is driving unrelated browsers at once, so one
   * member's page throwing, timing out, or losing its lease must not
   * cancel or reject the call for every sibling still running. A caller
   * that wants the raw values back rather than settlement records can
   * wrap the result: `(await swarm.all(fn)).map(r => r.status === 'fulfilled' ? r.value : undefined)`.
   */
  async all<T>(
    fn: (member: SwarmMember, index: number) => Promise<T>,
  ): Promise<PromiseSettledResult<T>[]> {
    return Promise.allSettled(this._members.map((member, index) => fn(member, index)));
  }

  /** Opens `n` more members, appended after the current ones, and returns just the new ones. Same concurrency and same partial-failure cleanup as `open()`. */
  async grow(n: number): Promise<readonly SwarmMember[]> {
    if (!Number.isInteger(n) || n < 1) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `BrowserSwarm.grow(): n must be a positive integer, got ${n}`,
      );
    }
    const added = await this.acquireMembers(n);
    this._members = [...this._members, ...added];
    return added;
  }

  /**
   * Closes the `n` most recently added members (LIFO, the mirror of
   * `grow()` appending) and drops them from `members`. Throws
   * `INVALID_ARGUMENT` rather than silently clamping: a caller asking to
   * shrink by more than the swarm currently holds is a bug at the call
   * site, not a size this method should quietly round down to.
   */
  async shrink(n: number): Promise<void> {
    if (!Number.isInteger(n) || n < 1) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `BrowserSwarm.shrink(): n must be a positive integer, got ${n}`,
      );
    }
    if (n > this._members.length) {
      throw new AutomationError(
        'INVALID_ARGUMENT',
        `BrowserSwarm.shrink(): cannot shrink by ${n}, the swarm only holds ${this._members.length} member(s)`,
      );
    }
    const removed = this._members.slice(this._members.length - n);
    this._members = this._members.slice(0, this._members.length - n);
    for (const m of removed) this.claimed.delete(m.index);
    await this.dispose(removed);
  }

  /**
   * Closes every member and releases everything `open()`/`grow()` opened,
   * i.e. every `AutomationClient` connection this `BrowserSwarm` itself
   * created. With `acquire`, it does not, and cannot, release whatever
   * `acquire()` reserved on the router/gateway side (see
   * `SwarmAcquireResult`'s own doc comment): call your own release for
   * every `member.instanceId` first, or after, per your own admission
   * layer's contract. With `launch` (and no `subject`) it ends every
   * member's browser too. Idempotent: a second call closes an
   * already-empty member list.
   */
  async close(): Promise<void> {
    const members = this._members;
    this._members = [];
    this.claimed.clear();
    await this.dispose(members);
  }

  /** Whether this swarm started its members' browsers and so must end them: `launch` mode without a subject. */
  private get ownsBrowsers(): boolean {
    return this.opts.launch !== undefined && this.opts.subject === undefined;
  }

  /**
   * Closes `members`, and ends their browsers when this swarm owns them
   * (see {@link ownsBrowsers}). Every member is tried even if one fails;
   * a failed browser release is then reported, because a browser left
   * running is a leak the caller needs to hear about.
   */
  private async dispose(members: readonly SwarmMember[]): Promise<void> {
    if (!this.ownsBrowsers) {
      closeMembers(members);
      return;
    }
    const settled = await Promise.allSettled(members.map((m) => m.client.release()));
    const failed = settled.flatMap((r, i) =>
      r.status === 'rejected' ? [{ member: members[i] as SwarmMember, reason: r.reason }] : [],
    );
    const first = failed[0];
    if (first === undefined) return;
    const message = first.reason instanceof Error ? first.reason.message : String(first.reason);
    throw new AutomationError(
      'GATEWAY_ERROR',
      `BrowserSwarm: ${failed.length}/${members.length} browser(s) could not be ended; first failure (instance ${first.member.instanceId}): ${message}`,
      { instanceIds: failed.map((f) => f.member.instanceId) },
    );
  }

  /**
   * Reserves `n` member indexes, synchronously, before this swarm's first
   * `await` (see `acquireMembers()` for why that matters).
   *
   * Two strategies, and the split is deliberate. Without a subject an
   * index is pure bookkeeping, so it stays monotonic: `grow()` after
   * `shrink()` numbers the new members after every index this swarm has
   * ever used, which is what the existing contract promises and what
   * `SwarmMember.index`'s "identity, not array position" doc describes.
   *
   * WITH a subject an index is not bookkeeping any more: it selects which
   * browser this member gets, through `<subject>#<index>`. Monotonic
   * numbering there would mean `shrink(1); grow(1)` abandons slot 4's
   * still-running browser and launches a fresh one for slot 5, i.e. the
   * exact "why do I keep getting new browsers" failure this option exists
   * to remove, reproduced inside a single swarm. So the subject case
   * refills the lowest free slot first. Existing members are never
   * renumbered either way; only which index a NEW member receives differs.
   */
  private reserveIndexes(n: number): number[] {
    const reserved: number[] = [];
    if (this.opts.subject === undefined) {
      for (let offset = 0; offset < n; offset++) reserved.push(this.nextIndex + offset);
      this.nextIndex += n;
    } else {
      for (let candidate = 0; reserved.length < n; candidate++) {
        if (!this.claimed.has(candidate)) reserved.push(candidate);
      }
      const highest = reserved[reserved.length - 1] ?? -1;
      this.nextIndex = Math.max(this.nextIndex, highest + 1);
    }
    for (const index of reserved) this.claimed.add(index);
    return reserved;
  }

  /**
   * Acquires and connects `n` new members on freshly reserved indexes
   * (see {@link reserveIndexes}), concurrently; see `open()`'s own doc
   * comment for the partial-failure cleanup.
   *
   * The whole reservation happens BEFORE the first `await` in this
   * method, so two overlapping calls (`grow()` invoked again before an
   * earlier one has resolved) can never claim the same
   * index range: JS runs each call's synchronous prefix to completion
   * before yielding, so the reservation itself is atomic without a lock.
   * This sidesteps, by construction, the deadlock a sibling project's
   * browser pool (`browser-pool.mjs`) actually shipped and had to fix:
   * two concurrent launches each registered a promise and then awaited
   * the OTHER's promise, a two-node wait cycle that never resolved. Never
   * add a step here that awaits another in-flight `acquireMembers()`
   * call; the fix there was a per-resource promise chain precisely
   * because a mutual-await scheme is the trap.
   */
  private async acquireMembers(n: number): Promise<SwarmMember[]> {
    const indexes = this.reserveIndexes(n);
    const settled = await Promise.allSettled(indexes.map((index) => this.openOneMember(index)));

    const opened: SwarmMember[] = [];
    const failures: unknown[] = [];
    settled.forEach((result, offset) => {
      if (result.status === 'fulfilled') {
        opened.push(result.value);
      } else {
        failures.push(result.reason);
        // A member that never opened is holding a slot nothing can reach.
        // Release the reservation so the next `grow()` can retry that same
        // slot, which under a subject is the same browser, rather than
        // stepping over it for good.
        this.claimed.delete(indexes[offset] as number);
      }
    });
    if (failures.length === 0) return opened;

    for (const m of opened) this.claimed.delete(m.index);
    await this.dispose(opened).catch(() => {});
    const first = failures[0];
    const wrapped =
      first instanceof AutomationError
        ? first
        : new AutomationError(
            'PROTOCOL_ERROR',
            first instanceof Error ? first.message : String(first),
          );
    throw new AutomationError(
      wrapped.code,
      `BrowserSwarm: ${failures.length}/${n} member(s) failed to open; first failure: ${wrapped.message}`,
      {
        failedCount: failures.length,
        requested: n,
        firstError: { code: wrapped.code, message: wrapped.message },
      },
    );
  }

  /**
   * A connect that then fails its own post-connect setup (the `opts.url`
   * navigate below) must not leak the socket it just opened: that
   * `client` is not yet in `opened` for `acquireMembers()`'s own
   * partial-failure cleanup to find (this call has not returned yet), so
   * closing it is this method's own responsibility before the error
   * propagates. This is the concrete BrowserGlass shape of the general
   * lesson a sibling project's browser pool
   * (`browser-pool.mjs`'s prune-before-launch, release-on-failure path)
   * already learned the hard way: a failed acquisition must not strand
   * the resource it already reserved.
   */
  private async openOneMember(index: number): Promise<SwarmMember> {
    const subject = swarmMemberSubject(this.opts.subject, index);
    const { client, instanceId } = await this.connectMember(index, subject);
    try {
      if (this.opts.url !== undefined && client.holdsControl) {
        // A launched member already holds the lease (`launch.control`
        // defaults to true), and it keeps it: that is what the caller
        // asked `launch()` for.
        await client.navigate(this.opts.url);
      } else if (this.opts.url !== undefined) {
        // Acquire, navigate, release: exactly what a caller would do by
        // hand, so a member fresh out of `open()` is not left holding
        // control it never asked to keep (see `BrowserSwarmOptions.url`'s
        // own doc comment).
        const lease = await client.acquireControl();
        try {
          await client.navigate(this.opts.url);
        } finally {
          await lease.release();
        }
      }
      const member: SwarmMember = { index, instanceId, targetId: client.targetId, subject, client };
      // Wired unconditionally at open time, not when the first
      // `onControlYield()` subscriber appears. A takeover can land in the
      // gap between `open()` resolving and a caller getting round to
      // subscribing, and a swarm that silently missed the first yield
      // because of registration order would be a nasty thing to debug. The
      // per-member registration stays; `emitYield()` reads the current
      // subscriber set each time, so a late subscriber simply starts
      // receiving from then on.
      member.client.onControlYield((notice) => this.emitYield({ member, notice }));
      return member;
    } catch (err) {
      if (this.ownsBrowsers) await client.release().catch(() => {});
      else client.close();
      throw err;
    }
  }

  /** One member's connected client, through whichever of `acquire` or `launch` this swarm was opened with. */
  private async connectMember(
    index: number,
    subject: string | undefined,
  ): Promise<{ client: AutomationClient; instanceId: string }> {
    const transport = this.opts.transport !== undefined ? { transport: this.opts.transport } : {};
    if (this.opts.launch !== undefined) {
      const launch = this.opts.launch;
      const client = await AutomationClient.launch({
        ...launch,
        ...(subject !== undefined ? { subject } : {}),
        ...(this.opts.stickyWithinMs !== undefined
          ? { stickyWithinMs: this.opts.stickyWithinMs }
          : {}),
        ...(launch.transport === undefined ? transport : {}),
      });
      return { client, instanceId: client.instanceId ?? '' };
    }
    const acquire = this.opts.acquire;
    if (acquire === undefined) {
      throw new AutomationError('INVALID_ARGUMENT', 'BrowserSwarm: no `acquire` or `launch` given');
    }
    const { instanceId, wsUrl, token } = await acquire(index, {
      subject,
      stickyWithinMs: this.opts.stickyWithinMs,
    });
    const client = await AutomationClient.connect({
      endpoint: wsUrl,
      token,
      instanceId,
      ...transport,
    });
    return { client, instanceId };
  }
}
