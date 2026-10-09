import { Emitter, Transport } from '@browserglass/client';
import type {
  Capability,
  ControlGranted,
  ControlPreemptRequest,
  ControlPreempted,
  ControlRevoked,
  ControlYieldRequest,
  Envelope,
  ErrorMsg,
  LeaseState,
  NavState,
  PresenceState,
  TargetClosed,
  TargetCreated,
  TargetSummary,
  TargetUpdated,
  Welcome,
} from '@browserglass/protocol';
import { AutomationError } from '../errors.js';
import type {
  ActionRecord,
  AutomationClientOptions,
  AutomationEvents,
  ConfirmHook,
  ControlYieldEvent,
  InFlightAction,
  PreemptionRequest,
} from '../types.js';
import type { ControlLeaseHandleImpl } from './leaseHandle.js';

/** Minimal presence entry this module cares about, from the last `presence.state` broadcast. */
interface PresenceEntry {
  kind: 'human' | 'agent' | 'service';
  label: string;
}

/**
 * Shared internal state and wire plumbing for one `bgls.v1` connection,
 * owned by one {@link AutomationClient} tree: the default client returned by
 * `AutomationClient.connect()` and every `forTarget()` sub-client it spawns
 * share exactly one `AutomationCore` (and therefore one socket, one lease
 * table, one step budget). Not exported: callers only ever see
 * {@link AutomationClient}.
 */
export class AutomationCore {
  readonly transport: Transport;
  readonly defaultTimeoutMs: number;
  readonly dryRun: boolean;
  readonly stepBudget: number;
  private readonly onConfirm: ConfirmHook | undefined;
  private readonly onActionHook: ((rec: ActionRecord) => void) | undefined;

  viewerId: string | null = null;
  sessionId: string | null = null;
  instanceId: string | null = null;
  granted: ReadonlySet<Capability> = new Set();
  targets: TargetSummary[] = [];
  viewport: { width: number; height: number; dpr: number } = { width: 1280, height: 800, dpr: 1 };

  /** By `targetId`: the lease this client currently holds. */
  readonly leases = new Map<string, ControlLeaseHandleImpl>();
  /** By `targetId`: the full session lease table from the last `control.state` broadcast. */
  readonly leaseStateByTarget = new Map<string, LeaseState>();
  /** By `targetId`: an outstanding `control.preempt.request`, cleared on `control.preempted` or `control.preempt.cancelled`. Consulted between `humanType()` chunks. */
  readonly pendingPreempt = new Map<string, PreemptionRequest>();
  /** By `targetId`: the wall-clock time before which `acquireControl()` refuses to re-request, per the preemption contract's `requeueAfterMs`. */
  readonly requeueBlockedUntil = new Map<string, number>();
  /** By `targetId`: the last known target generation, learned from a `target.probe`/`target.capture` reply and used to stamp subsequent `input.*` messages. */
  readonly genByTarget = new Map<string, number>();
  /** By `targetId`: the last `nav.state` broadcast, used by `status()`. */
  readonly navStateByTarget = new Map<string, NavState>();
  /** By `viewerId`: the last known presence entry, used to resolve `PreemptionRequest.byKind`. */
  readonly viewersById = new Map<string, PresenceEntry>();
  /** Fires `console`/`pageerror`/`network`/`networksummary` for whatever targets this connection has `diagnostics.subscribe()`d to. See `AutomationClient.on()`. */
  readonly emitter = new Emitter<AutomationEvents>();

  /**
   * By `targetId`: this client has stood down on that target and every
   * `input.*`/`nav.*` dispatch for it is refused until control is granted
   * again. THE stand-down flag. Set by {@link standDown}, cleared by
   * {@link endStandDown} (preemption withdrawn) and by a fresh
   * `control.granted` for the same target.
   *
   * Deliberately keyed by target and not by lease: the whole point is that
   * it outlives the lease it started under, so a stray send between losing
   * the lease and noticing cannot get through, and so `yieldStatus()` can
   * still say who took over after the handle is gone.
   */
  readonly yieldByTarget = new Map<string, ControlYieldEvent>();
  /**
   * Targets on which, since this client's current stand-down began, a
   * viewer other than this one has held the lease. `waitForResume()` needs
   * this and cannot read it off the lease table alone: right after a
   * yield the table can still name this client as the holder (the release
   * and the broadcast that reflects it cross on the wire), and a moment
   * later it names nobody, so "nobody else holds it" is true before anyone
   * else has had the browser at all. Cleared when the stand-down ends.
   */
  readonly otherHolderSeen = new Set<string>();
  /** Subscribers to {@link AutomationClient.onControlYield}, connection-wide (not per lease, and not per target). */
  readonly yieldCbs = new Set<(ev: ControlYieldEvent) => void>();
  /**
   * Every in flight {@link awaitMessage} waiter, so {@link destroy} can
   * settle them rather than abandoning them to their own timers.
   */
  private readonly pendingWaiters = new Set<{ abandon: () => void }>();

  /** Actions currently running, i.e. started and not yet returned. Reported as `ControlYieldEvent.inFlight` so an agent can see what a takeover interrupted. */
  private readonly inFlightActions = new Set<InFlightAction>();
  /** See `YieldPolicy.releaseOnYield`. */
  readonly releaseOnYield: boolean;

  private stepsUsed = 0;
  private destroyed = false;

  /**
   * Turns a URL the gateway handed back (a download or large PDF URL,
   * which is root relative unless the gateway has `publicUrl` set) into an
   * absolute `http(s)` URL on the same origin this client's socket dialed.
   * Already absolute URLs pass through. A relative URL that cannot be
   * resolved (an endpoint that is not itself a URL) is returned unchanged.
   */
  resolveGatewayUrl(url: string): string {
    try {
      const base = new URL(this.endpoint);
      if (base.protocol === 'ws:') base.protocol = 'http:';
      else if (base.protocol === 'wss:') base.protocol = 'https:';
      return new URL(url, base).toString();
    } catch {
      return url;
    }
  }

  private readonly endpoint: string;

  constructor(options: AutomationClientOptions) {
    this.endpoint = options.endpoint;
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15000;
    this.dryRun = options.dryRun ?? false;
    this.stepBudget = options.stepBudget ?? Number.POSITIVE_INFINITY;
    this.onConfirm = options.onConfirm;
    this.onActionHook = options.onAction;
    this.releaseOnYield = options.yieldPolicy?.releaseOnYield ?? true;

    this.transport = new Transport({
      url: options.endpoint,
      token: options.token,
      hello: {
        client: { name: '@browserglass/automation', version: '0.0.0', runtime: 'agent' },
        capabilities: { codecs: [], binaryFrames: false, input: ['mouse', 'key', 'text'] },
        viewport: { width: 0, height: 0, dpr: 1, visible: false, fitMode: 'contain' },
      },
      ...(options.transport?.WebSocketImpl !== undefined
        ? { transport: { WebSocketImpl: options.transport.WebSocketImpl } }
        : {}),
    });

    this.transport.on('connected', (ev) => this.handleConnected(ev.welcome));
    this.transport.on('message', (msg) => this.handleMessage(msg));
  }

  private handleConnected(welcome: Welcome): void {
    this.viewerId = welcome.viewerId;
    this.sessionId = welcome.sessionId;
    this.instanceId = welcome.instance.instanceId;
    this.granted = new Set(welcome.granted);
    this.targets = welcome.targets;
    this.viewport = welcome.instance.viewport;
  }

  private handleMessage(msg: Envelope): void {
    switch (msg.t) {
      case 'presence.state': {
        const p = msg as unknown as PresenceState;
        for (const v of p.viewers)
          this.viewersById.set(v.viewerId, { kind: v.kind, label: v.label });
        break;
      }
      case 'target.created': {
        const t = msg as unknown as TargetCreated;
        this.targets = [...this.targets, t.target];
        break;
      }
      case 'target.updated': {
        const t = msg as unknown as TargetUpdated;
        this.targets = this.targets.map((x) =>
          x.targetId === t.targetId ? { ...x, ...t.changed } : x,
        );
        break;
      }
      case 'target.closed': {
        const t = msg as unknown as TargetClosed;
        this.targets = this.targets.filter((x) => x.targetId !== t.targetId);
        this.leases.get(t.targetId)?.markRevoked('instance_released');
        this.leases.delete(t.targetId);
        break;
      }
      case 'nav.state': {
        const n = msg as unknown as NavState;
        this.navStateByTarget.set(n.targetId, n);
        break;
      }
      case 'control.state': {
        this.leaseStateByTarget.clear();
        const leases = msg['leases'] as LeaseState[];
        for (const l of leases) this.leaseStateByTarget.set(l.targetId, l);
        for (const targetId of this.yieldByTarget.keys()) {
          if (this.someoneElseHolds(targetId)) this.otherHolderSeen.add(targetId);
        }
        break;
      }
      case 'control.preempt.request': {
        const p = msg as unknown as ControlPreemptRequest;
        const byKind = this.requesterKind(p.byViewerId);
        const req: PreemptionRequest = {
          targetId: p.targetId,
          byLabel: p.byLabel,
          byKind,
          reason: p.reason,
          graceMs: p.graceMs,
          deadline: p.deadline,
        };
        this.pendingPreempt.set(p.targetId, req);
        // The gate closes FIRST, before either callback surface runs. A
        // listener must never be able to observe a window in which this
        // client is notified but still dispatching, and the ordering is
        // the only thing that guarantees it: `enterStandDown()` shuts the
        // gate synchronously, so by the time any `onPreemptionRequested`
        // or `onControlYield` handler is entered, the next `clickAt()` on
        // this target already throws. The legacy per-lease callback then
        // runs before the release, so a handler using the old surface
        // still sees a live handle.
        const ev: ControlYieldEvent = {
          targetId: p.targetId,
          phase: 'requested',
          reason: p.reason,
          byLabel: p.byLabel,
          byKind,
          human: p.reason === 'human_takeover' || byKind === 'human',
          deadline: p.deadline,
          inFlight: this.inFlightFor(p.targetId),
          // Not known until `control.preempted` arrives with the wire's own
          // `requeueAfterMs`. Reporting the grace deadline here instead
          // would be a guess, and a low one: the backoff after a real
          // takeover is 30000 by default, fifteen times the grace.
          resumeNotBefore: null,
        };
        this.enterStandDown(ev);
        this.leases.get(p.targetId)?.firePreemptionRequested(req);
        this.completeStandDown(ev);
        break;
      }
      /**
       * The shared-mode counterpart of `control.preempt.request`: a person
       * driving a SHARED target asking the agent holders on it to stand
       * down, while every human holder keeps driving.
       *
       * This case was missing, and its absence is worth recording because
       * it made the whole feature nearly useless while looking built.
       * Everything around it shipped (`standDown`, `enterStandDown`,
       * `releaseOnYield`, `onControlYield`, `waitForResume`); only the one
       * inbound message that triggers them fell through `default: break`.
       * Measured end to end in the demo, a takeover went from an expected
       * few milliseconds to 2008ms, because the agent was never told and
       * the engine had to end its tenure at `agentPreemptGraceMs` instead.
       *
       * Slower was the lesser half. Because `standDown()` never ran, the
       * dispatch-refusal gate was never shut, so the agent was not stood
       * down in the sense this SDK's own types promise: it was merely
       * leaseless, and its next action threw `LEASE_NOT_HELD` at whoever
       * had just taken over. That is exactly the "half yielded agent is
       * worse than no yield" the design set out to avoid.
       *
       * Two deliberate differences from the preemption case above:
       *
       * - `reason` is `'human_takeover'` and `human` is `true`, both by
       *   construction rather than by inspection. The server refuses a
       *   `control.yield` from an automation client with
       *   `bgls.error.control.not_human`, so a `control.yield.request`
       *   reaching this client can only have come from a person. The wire
       *   message's own `reason` is free text the requester typed, not a
       *   member of the event's `reason` union, so it is deliberately NOT
       *   mapped onto it.
       * - `onPreemptionRequested` is NOT fired. A yield is not a
       *   preemption: nothing is queued, no lease is handed to a waiting
       *   requester, and the other human holders carry on driving. Firing
       *   the preemption surface would tell a handler a lease is being
       *   transferred when it is not. `onControlYield` is the surface for
       *   this, and it is connection wide, so it needs no live handle.
       */
      case 'control.yield.request': {
        const y = msg as unknown as ControlYieldRequest;
        const ev: ControlYieldEvent = {
          targetId: y.targetId,
          phase: 'requested',
          reason: 'human_takeover',
          byLabel: y.byLabel,
          byKind: 'human',
          human: true,
          deadline: y.deadline,
          inFlight: this.inFlightFor(y.targetId),
          // Same reasoning as the preemption path: the requeue window is
          // only known once the wire tells us, and guessing the grace
          // deadline here would understate it by an order of magnitude.
          resumeNotBefore: null,
        };
        // Gate shut first, then listeners, then the release. Identical
        // ordering to the preemption case, and for the identical reason:
        // no listener may ever observe a client that has been notified and
        // is still dispatching.
        this.enterStandDown(ev);
        this.completeStandDown(ev);
        break;
      }
      case 'control.preempt.cancelled': {
        const targetId = msg['targetId'] as string;
        this.pendingPreempt.delete(targetId);
        this.endStandDown(targetId);
        break;
      }
      case 'control.preempted': {
        const p = msg as unknown as ControlPreempted;
        this.pendingPreempt.delete(p.targetId);
        // Stamped unconditionally, NOT inside the `if (lease)` below.
        // A client that already released inside the grace (the well-behaved
        // path, and this SDK's own default) has deleted its lease handle by
        // the time this message lands, so keying the backoff off a live
        // handle meant the agent that stood down promptly was the one
        // exempted from the requeue window, free to re-acquire and start
        // fighting the person it had just yielded to. Backoff belongs to
        // the target, not to a handle that may be gone.
        this.requeueBlockedUntil.set(p.targetId, Date.now() + p.requeueAfterMs);
        const byKind = this.requesterKind(p.byViewerId);
        const human = p.reason === 'human_takeover' || byKind === 'human';
        this.standDown({
          targetId: p.targetId,
          phase: 'taken',
          reason: p.reason,
          byLabel: p.byLabel,
          byKind,
          human,
          deadline: null,
          inFlight: this.inFlightFor(p.targetId),
          resumeNotBefore: Date.now() + p.requeueAfterMs,
        });
        const lease = this.leases.get(p.targetId);
        if (lease && lease.leaseId === p.leaseId) {
          this.leases.delete(p.targetId);
          lease.markRevoked(
            p.reason === 'force_claim'
              ? 'force_claimed'
              : human
                ? 'preempted_by_human'
                : 'preempted_by_agent',
          );
        }
        break;
      }
      case 'control.revoked': {
        const r = msg as unknown as ControlRevoked;
        const lease = this.leases.get(r.targetId);
        if (lease && lease.leaseId === r.leaseId) {
          this.leases.delete(r.targetId);
          lease.markRevoked(
            r.reason === 'admin' || r.reason === 'capability_lost'
              ? 'admin_revoked'
              : r.reason === 'target_gone' || r.reason === 'session_ended'
                ? 'session_ended'
                : 'expired',
          );
        }
        break;
      }
      case 'instance.released': {
        for (const lease of this.leases.values()) lease.markRevoked('instance_released');
        this.leases.clear();
        break;
      }
      // The four diagnostics broadcasts (api-contract-diagnostics.md
      // section 1). Read with `as unknown as Envelope & {...}` rather than
      // an imported named type, matching `@browserglass/client`'s own
      // `BrowserGlassClient` handling of the same four messages: this
      // package cannot depend on the exact `@browserglass/protocol`
      // export names diagnostics wiring lands under without coupling this
      // file's compile to them. `diagnostics.subscribed`
      // needs no case here: it is consumed by `AutomationCore.request()`'s
      // own `re`-correlated listener, the same way `control.granted` is.
      // The gate's pause. `request.gate.enabled`/`disabled` need no case
      // here for the same reason `diagnostics.subscribed` does not: both
      // are `re`-correlated replies consumed by `request()`'s own
      // listener. `paused` is the one that arrives unprompted.
      case 'request.gate.paused': {
        const g = msg as unknown as Envelope & {
          targetId: string;
          gateId: string;
          url: string;
          method: string;
          resourceType: string;
          headers: Record<string, string>;
          postData?: string;
          deadlineAt: number;
        };
        this.emitter.emit('gatepaused', {
          targetId: g.targetId,
          gateId: g.gateId,
          url: g.url,
          method: g.method,
          resourceType: g.resourceType,
          headers: g.headers ?? {},
          deadlineAt: g.deadlineAt,
          ...(g.postData !== undefined ? { postData: g.postData } : {}),
        });
        break;
      }
      case 'console.entry': {
        const c = msg as unknown as Envelope & {
          targetId: string;
          level: string;
          text: string;
          url?: string;
          line?: number;
          column?: number;
          stack?: string;
          count?: number;
        };
        this.emitter.emit('console', {
          targetId: c.targetId,
          level: c.level,
          text: c.text,
          ...(c.url !== undefined ? { url: c.url } : {}),
          ...(c.line !== undefined ? { line: c.line } : {}),
          ...(c.column !== undefined ? { column: c.column } : {}),
          ...(c.stack !== undefined ? { stack: c.stack } : {}),
          ...(c.count !== undefined ? { count: c.count } : {}),
        });
        break;
      }
      case 'page.error': {
        const p = msg as unknown as Envelope & {
          targetId: string;
          name: string;
          message: string;
          stack?: string;
          url?: string;
        };
        this.emitter.emit('pageerror', {
          targetId: p.targetId,
          name: p.name,
          message: p.message,
          ...(p.stack !== undefined ? { stack: p.stack } : {}),
          ...(p.url !== undefined ? { url: p.url } : {}),
        });
        break;
      }
      case 'network.request': {
        const n = msg as unknown as Envelope & {
          targetId: string;
          requestId: string;
          method: string;
          url: string;
          resourceType: string;
          status: number | null;
          errorText: string | null;
          fromCache: boolean;
          durationMs: number | null;
          encodedBytes: number | null;
          startedAt: number;
        };
        this.emitter.emit('network', {
          targetId: n.targetId,
          requestId: n.requestId,
          method: n.method,
          url: n.url,
          resourceType: n.resourceType,
          status: n.status,
          errorText: n.errorText,
          fromCache: n.fromCache,
          durationMs: n.durationMs,
          encodedBytes: n.encodedBytes,
          startedAt: n.startedAt,
        });
        break;
      }
      case 'network.summary': {
        const s = msg as unknown as Envelope & {
          targetId: string;
          windowMs: number;
          requests: number;
          failed: number;
          bytesIn: number;
          bytesOut: number;
          slowest: Array<{ url: string; ms: number; status: number }>;
        };
        this.emitter.emit('networksummary', {
          targetId: s.targetId,
          windowMs: s.windowMs,
          requests: s.requests,
          failed: s.failed,
          bytesIn: s.bytesIn,
          bytesOut: s.bytesOut,
          slowest: s.slowest,
        });
        break;
      }
      /**
       * An `error` envelope with no `re`: a server-initiated PUSH, not the
       * reply to one of THIS client's own `request()` calls (those are
       * matched and thrown from `request()` itself via `awaitMessage`,
       * which listens independently and never routes through this
       * switch). Before this case existed, every uncorrelated `error` fell
       * through to `default: break` and vanished, no matter what the
       * server put on the wire.
       *
       * That mattered concretely for input: `type()`/`insertText()`/
       * `click()`/`scroll()` all dispatch via `AutomationCore.send()`,
       * fire-and-forget with no reply to await (`ws/connection.ts`'s own
       * doc: "input messages carry no id to correlate against"). The one
       * way a dropped keystroke could ever reach a caller is exactly this
       * push (`managed-session.ts`'s `reportInputSignal`, e.g.
       * `bgls.error.input.dispatch_failed` for an input message whose CDP
       * dispatch never completed). A server that reports the drop
       * correctly was still met with silence here, on the client, which is
       * the other half of "type() drops keystrokes and returns success":
       * fixing the server's under-reporting means nothing if the SDK
       * throws every uncorrelated error away.
       */
      case 'error': {
        const e = msg as unknown as ErrorMsg;
        if (e.re !== undefined) break; // consumed by the matching request()'s own awaitMessage instead.
        this.emitter.emit('protocolerror', AutomationError.fromErrorMsg(e));
        break;
      }
      default:
        break;
    }
  }

  // ==================================================================
  // Standing down. See `types.ts`'s `ControlYieldEvent` for the contract
  // this implements. Why it exists: a
  // person watching a browser an agent is driving has to be able to take
  // it, and the agent has to actually stop rather than merely be told.
  // ==================================================================

  /**
   * Resolves a requester's kind from the last `presence.state` roster.
   * Unknown viewers resolve to `'human'` deliberately, matching the
   * documented `PreemptionRequest.byKind` default: presence can lag a
   * preemption by a broadcast, and the safe direction to be wrong in is
   * "assume a person", which makes this client stand down harder, not
   * softer.
   */
  private requesterKind(byViewerId: string): 'human' | 'automation' {
    return this.viewersById.get(byViewerId)?.kind === 'agent' ? 'automation' : 'human';
  }

  /**
   * Stops this client driving `ev.targetId` and tells everyone watching.
   * Synchronous and idempotent-ish (a later notice for the same target
   * simply replaces the earlier one, which is what the `requested` ->
   * `taken` progression needs).
   *
   * Order matters and is the whole safety argument:
   *
   * 1. Close the dispatch gate. Everything after this point is
   *    bookkeeping and notification; no ordering below can let another
   *    input frame out.
   * 2. Stop auto-renew, so nothing asks to extend a lease being handed
   *    over.
   * 3. Carry the requeue backoff forward (never backwards: `Math.max`),
   *    so a second notice for the same target cannot shorten a window
   *    already granted.
   * 4. Notify. Listener exceptions are swallowed, per
   *    `ControlYieldEvent`'s own doc.
   * 5. Release, if `releaseOnYield` and the lease is still held. Last,
   *    because a listener reading `client.yieldStatus()` from inside its
   *    own callback must see the finished state, not a half-applied one.
   */
  standDown(ev: ControlYieldEvent): void {
    this.enterStandDown(ev);
    this.completeStandDown(ev);
  }

  /**
   * Step 1: close the gate. Split out from {@link completeStandDown} only
   * so `control.preempt.request` can slot the legacy per-lease
   * `onPreemptionRequested` callback between the two halves, and still
   * have the gate shut before either callback surface runs.
   */
  private enterStandDown(ev: ControlYieldEvent): void {
    // A fresh stand-down starts a fresh "has anybody else had it" record;
    // a second notice for one already in force (requested, then taken)
    // keeps what the first one saw.
    if (!this.yieldByTarget.has(ev.targetId)) this.otherHolderSeen.delete(ev.targetId);
    this.yieldByTarget.set(ev.targetId, ev);
    // A takeover is somebody else taking the lease by definition, even if
    // the broadcast showing them has not arrived yet.
    if (this.someoneElseHolds(ev.targetId) || (ev.phase === 'taken' && ev.reason !== 'voluntary')) {
      this.otherHolderSeen.add(ev.targetId);
    }
    this.leases.get(ev.targetId)?.suspendAutoRenew();
    if (ev.resumeNotBefore !== null) {
      // Never backwards: a second notice for the same target must not be
      // able to shorten a backoff window already granted.
      const prior = this.requeueBlockedUntil.get(ev.targetId) ?? 0;
      this.requeueBlockedUntil.set(ev.targetId, Math.max(prior, ev.resumeNotBefore));
    }
  }

  /** Step 2: notify, then hand the lease back. */
  private completeStandDown(ev: ControlYieldEvent): void {
    for (const cb of this.yieldCbs) {
      try {
        cb(ev);
      } catch {
        // an agent's own yield handler throwing must never break the
        // stand-down it is being notified about
      }
    }
    const lease = this.leases.get(ev.targetId);
    if (ev.phase === 'requested' && this.releaseOnYield && lease !== undefined) {
      // Synchronous: `releaseYielding()` puts `control.release` on the
      // wire before this method returns, so the handover is not waiting on
      // a microtask, and fires `onRevoked` with the honest reason on the
      // way out (see that method for why a yielding release notifies and a
      // plain one does not).
      lease.releaseYielding(
        ev.reason === 'force_claim'
          ? 'force_claimed'
          : ev.human
            ? 'preempted_by_human'
            : 'preempted_by_agent',
      );
    }
  }

  /** Preemption withdrawn (`control.preempt.cancelled`): the requester went away and this client may drive again on its existing lease. */
  endStandDown(targetId: string): void {
    if (!this.yieldByTarget.delete(targetId)) return;
    this.otherHolderSeen.delete(targetId);
    this.requeueBlockedUntil.delete(targetId);
    this.leases.get(targetId)?.resumeAutoRenew();
  }

  /** The current stand-down for `targetId`, or `undefined` if this client is free to drive it. */
  yieldFor(targetId: string): ControlYieldEvent | undefined {
    return this.yieldByTarget.get(targetId);
  }

  /**
   * Throws unless this client may still dispatch input on `targetId`.
   *
   * Called once per ATOMIC frame group, never per frame: a `mousedown`
   * and its `mouseup`, or a `keydown` and its `keyup`, go out together or
   * not at all. Refusing a group halfway would leave a mouse button or a
   * modifier key stuck down inside a page a person has just taken over,
   * which is a worse outcome than the extra frame it saved. Every group
   * in this package is dispatched synchronously with no `await` between
   * its frames, so a yield can never land inside one.
   */
  assertMayDispatch(targetId: string, action: string): void {
    const ev = this.yieldByTarget.get(targetId);
    if (ev === undefined) return;
    const who =
      ev.reason === 'voluntary'
        ? 'this client yielded control'
        : `${ev.byLabel || 'another viewer'} (${ev.human ? 'a person' : 'an agent'}) took control`;
    throw new AutomationError(
      'LEASE_REVOKED',
      `${action}() refused: ${who} on ${targetId}. This client has stood down and will not dispatch input until control is granted again.`,
      {
        yielded: true,
        phase: ev.phase,
        reason: ev.reason,
        human: ev.human,
        byLabel: ev.byLabel,
        ...(ev.resumeNotBefore !== null ? { resumeNotBefore: ev.resumeNotBefore } : {}),
      },
    );
  }

  /** Registers one running action, for `ControlYieldEvent.inFlight`. The returned entry is passed back to {@link endInFlight} in a `finally`. */
  beginInFlight(action: string, targetId: string): InFlightAction {
    const entry: InFlightAction = { action, targetId, startedAt: Date.now() };
    this.inFlightActions.add(entry);
    return entry;
  }

  endInFlight(entry: InFlightAction): void {
    this.inFlightActions.delete(entry);
  }

  /** Snapshot (a copy, not a live view) of what is running on `targetId` right now. */
  inFlightFor(targetId: string): InFlightAction[] {
    return [...this.inFlightActions].filter((e) => e.targetId === targetId);
  }

  /** Whether `targetId`'s lease is held by somebody who is not this client, per the last `control.state` broadcast. Consulted by `waitForResume()`. */
  someoneElseHolds(targetId: string): boolean {
    const holder = this.leaseStateByTarget.get(targetId)?.holderViewerId ?? null;
    return holder !== null && holder !== this.viewerId;
  }

  /** Whether `cap` is currently granted. */
  hasCapability(cap: Capability): boolean {
    return this.granted.has(cap);
  }

  /** Whether this client currently holds a live (unexpired, unrevoked) lease on `targetId`. */
  hasControl(targetId: string): boolean {
    const lease = this.leases.get(targetId);
    return lease?.isValid === true;
  }

  /** Decrements the step budget, throwing `BUDGET_EXHAUSTED` when exhausted. Called once per action attempt, before dispatch. */
  consumeStep(): void {
    if (this.stepsUsed >= this.stepBudget) {
      throw new AutomationError('BUDGET_EXHAUSTED', `step budget of ${this.stepBudget} exhausted`, {
        stepBudget: this.stepBudget,
      });
    }
    this.stepsUsed += 1;
  }

  /** Records one action attempt via `onAction`, if the caller supplied one. Never throws. */
  recordAction(rec: ActionRecord): void {
    try {
      this.onActionHook?.(rec);
    } catch {
      // an application's own onAction hook throwing must never break automation itself
    }
  }

  /**
   * Sends one already-built envelope. Throws if not connected.
   *
   * Also the last line of defence for a stand-down: an `input.*` message
   * aimed at a target this client has yielded is refused here, whatever
   * called it. The explicit `assertMayDispatch()` at the top of each
   * interaction method is the real gate (it fails before the round trip
   * and before a step is spent); this one exists so that a method added
   * later which forgets that call still cannot put a click into a browser
   * a person has taken over. It cannot split an atomic frame group for the
   * reason given on `assertMayDispatch()` itself: no group in this package
   * has an `await` between its frames, so no yield can land inside one.
   */
  send(t: string, payload: Record<string, unknown>): void {
    if (t.startsWith('input.')) {
      const targetId = payload['targetId'];
      if (typeof targetId === 'string') this.assertMayDispatch(targetId, t);
    }
    this.transport.send({ v: 1, t, ts: Date.now(), ...payload });
  }

  /**
   * Sends `t` with a fresh correlation id and awaits the first reply whose
   * `re` matches it, mapping a server `error` reply through
   * {@link AutomationError.fromErrorMsg}. Mirrors `BrowserGlassClient`'s own
   * `request()`/`awaitMessage()` pair (`packages/client/src/client/BrowserGlassClient.ts`),
   * duplicated rather than imported because that method is private to the
   * client-assembly task's own class.
   */
  request<T extends Envelope = Envelope>(
    t: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
  ): Promise<T> {
    const id = this.newId();
    // The waiter has to be registered BEFORE the send, or a reply that
    // arrives in the same tick is missed. That ordering is correct and
    // stays.
    let abandon: (() => void) | null = null;
    const promise = this.awaitMessage<T | ErrorMsg>(
      (m) => m.re === id,
      timeoutMs ?? this.defaultTimeoutMs,
      (a) => {
        abandon = a;
      },
    ).then((msg) => {
      if (msg.t === 'error') throw AutomationError.fromErrorMsg(msg as ErrorMsg);
      return msg as T;
    });

    try {
      this.transport.send({ v: 1, t, id, ts: Date.now(), ...payload });
    } catch (err) {
      // `Transport.send` THROWS on a destroyed or disconnected socket
      // (`packages/client/src/transport/transport.ts`: "cannot send:
      // Transport is destroyed" and "not connected"). Without this catch
      // the throw left this method synchronously, and the waiter
      // registered a few lines up was orphaned: nothing awaited it, so it
      // sat on its own 15 second timer and then rejected into nobody,
      // which Node reports as an unhandled rejection and which
      // `--unhandled-rejections=strict` treats as fatal.
      //
      // It is not a rare path. Any client whose socket goes away with work
      // in flight hits it, and the conformance suite (where viewers are
      // preempted and disconnected on purpose) produced over three hundred
      // of these per run, every one of them surfacing fifteen seconds
      // after the call that caused it and pointing at a timer rather than
      // at the send.
      //
      // `abandon()` settles the waiter now and clears its timer;
      // `promise.catch` marks the resulting rejection handled so it can
      // never be reported as unhandled. The caller still sees the REAL
      // failure, the send error, rethrown below, rather than a timeout
      // fifteen seconds later that says nothing about what went wrong.
      promise.catch(() => undefined);
      (abandon as (() => void) | null)?.();
      throw err;
    }
    return promise;
  }

  /** Awaits the next message satisfying `predicate`, or throws `TIMEOUT` after `timeoutMs`. Pass `Infinity` to wait forever. */
  awaitMessage<T extends Envelope>(
    predicate: (m: Envelope) => boolean,
    timeoutMs: number,
    /** Receives a function that settles this waiter early. For a caller that registers a waiter and then fails to send it, see {@link request}. */
    onRegister?: (abandon: () => void) => void,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = Number.isFinite(timeoutMs)
        ? setTimeout(() => {
            cleanup();
            reject(
              new AutomationError('TIMEOUT', `timed out after ${timeoutMs}ms waiting for a reply`),
            );
          }, timeoutMs)
        : null;
      timer?.unref?.();
      const off = this.transport.on('message', (msg) => {
        if (!predicate(msg)) return;
        cleanup();
        resolve(msg as T);
      });
      // Registered so `destroy()` can settle this waiter instead of
      // leaving it to time out against a socket that is already gone. See
      // `destroy()`'s own comment for what that cost.
      const entry = {
        abandon: () =>
          reject(
            new AutomationError(
              'INSTANCE_GONE',
              'the AutomationClient was closed while this request was still in flight, so no reply can arrive',
            ),
          ),
      };
      const cleanup = (): void => {
        if (timer) clearTimeout(timer);
        off();
        this.pendingWaiters.delete(entry);
      };
      entry.abandon = () => {
        cleanup();
        reject(
          new AutomationError(
            'INSTANCE_GONE',
            'the AutomationClient was closed while this request was still in flight, so no reply can arrive',
          ),
        );
      };
      this.pendingWaiters.add(entry);
      onRegister?.(() => entry.abandon());
    });
  }

  /** Mints an opaque correlation id for `Envelope.id`, never a `<prefix>_<ULID>` (those are minted server side). */
  newId(): string {
    return `c_${crypto.randomUUID().replace(/-/g, '')}`;
  }

  /**
   * Records a generation learned from a reply that carries one.
   *
   * Refuses to cache `0`, and that refusal is the whole point of routing
   * every writer through here rather than calling `genByTarget.set()`
   * directly. `Stream.gen` seeds at 1 (`packages/core/src/stream/stream.ts`)
   * and only ever increments, so `0` is not a generation any live target
   * can have: it is what a server side `?? 0` fallback produces for a
   * target with no per-target state, and what a reply that has simply not
   * been taught to report a real one sends.
   *
   * Caching a `0` is not a missed optimisation, it is a permanent, silent
   * break. This cache has no expiry, `resolveGenFencing` is pure equality,
   * and input is fire and forget with no reply to notice a refusal in, so
   * one `0` written here drops every subsequent `input.mouse` and
   * `input.key` for that target for the life of the client, with the only
   * evidence a coalesced line in the SERVER's log. That is exactly what
   * `target.capture`'s hardcoded `gen: 0` did: a screenshot anywhere
   * before the first click disabled input entirely, while `evaluate`,
   * `select` and `setInputFiles` all carried on working, which is about
   * the most confusing shape that failure could have taken.
   *
   * Discarding the `0` instead costs one extra `target.probe` round trip
   * on the next dispatch, and that probe asks the question again against a
   * target that by then certainly does have state.
   */
  rememberGen(targetId: string, gen: number): void {
    if (!Number.isInteger(gen) || gen < 1) return;
    this.genByTarget.set(targetId, gen);
  }

  /** Forgets the cached generation for `targetId`, so the next dispatch re-learns it. For a caller told its generation is stale. */
  forgetGen(targetId: string): void {
    this.genByTarget.delete(targetId);
  }

  /** Learns and caches the current generation for `targetId` via a cheap `target.probe`, if not already known. */
  async ensureGen(targetId: string): Promise<number> {
    const known = this.genByTarget.get(targetId);
    if (known !== undefined) return known;
    const reply = await this.request<Envelope & { gen: number }>('target.probe', {
      targetId,
      x: 0,
      y: 0,
      fw: this.viewport.width,
      fh: this.viewport.height,
      detail: 'hover',
    });
    this.rememberGen(targetId, reply.gen);
    return reply.gen;
  }

  /**
   * Tears down the connection. Best-effort releases every held lease on the
   * wire first (so the next queued viewer is served without waiting on a
   * socket timeout, mirroring `BrowserGlassClient.destroy()`), then marks
   * every lease revoked locally and closes the transport. Idempotent.
   */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const [targetId, lease] of this.leases) {
      try {
        this.transport.send({
          v: 1,
          t: 'control.release',
          ts: Date.now(),
          targetId,
          leaseId: lease.leaseId,
        });
      } catch {
        // not connected; nothing to send over a socket that no longer exists
      }
    }
    // Settle every in flight request BEFORE tearing the transport down.
    //
    // Without this each one sat on its own 15 second timer waiting for a
    // reply that could no longer arrive, and then rejected into nothing.
    // In the conformance suite that produced over three hundred unhandled
    // rejections per run; in a caller's process it is worse than noise,
    // because an unhandled rejection is fatal to Node under
    // `--unhandled-rejections=strict` and the failure surfaces fifteen
    // seconds after the call that actually caused it, pointing at a timer
    // rather than at the `close()`.
    //
    // Rejecting is the honest outcome, not resolving: the caller asked a
    // question that will never be answered, and `INSTANCE_GONE` says
    // exactly why.
    for (const waiter of [...this.pendingWaiters]) {
      try {
        waiter.abandon();
      } catch {
        // A waiter whose own rejection handler throws must not stop the
        // rest from being settled.
      }
    }
    this.pendingWaiters.clear();

    for (const lease of this.leases.values()) lease.markRevoked('session_ended');
    this.leases.clear();
    this.emitter.clear();
    this.yieldCbs.clear();
    this.transport.destroy();
  }
}
