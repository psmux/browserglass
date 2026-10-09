/**
 * The demo's agent: a real `@browserglass/automation` client, running in
 * this Next server's own process, joining the session over the same
 * `bgls.v1` socket the browser in front of you is on.
 *
 * There is no animation here and nothing is faked. `AutomationClient`
 * opens a WebSocket to `/browserglass/socket` with a bearer token this file
 * mints, appears in `presence.state` as an ordinary viewer with
 * `kind: 'agent'` (the server derives that from the `automation`
 * capability on the token, `packages/server/src/ws/connection.ts`), asks
 * for a `ControlLease` exactly like a person does, and every click and
 * keystroke it sends goes through the same `InputDispatcher` and the same
 * fencing check a human's input goes through. If you kill this loop the
 * pane simply stops moving.
 *
 * WHY IT RUNS SERVER SIDE. An agent is a program with a job, not a widget.
 * Putting the loop in the page would have meant it died on a refresh and
 * would have made the demo's central claim ("software drives this browser,
 * you watch") depend on a tab staying open. It lives here, keyed by
 * instance, and the page is only a window onto it.
 *
 * HOW THE STAND DOWN WORKS, and which half of it is the SDK's.
 *
 * The SDK half is `client.onControlYield()`, registered once at connect
 * time and never re-registered. It fires for every target on the socket,
 * across acquires, and by the time a listener runs the client has ALREADY
 * stopped dispatching input on that target: nothing this loop does or
 * fails to do can let another keystroke through. `ev.human` is the flag to
 * branch on. So the whole of "the agent actually stands down" belongs to
 * the SDK, and this file only decides what the agent does NEXT.
 *
 * Standing down deliberately is `client.yieldControl()`, which releases the
 * lease and shuts dispatch off, and imposes no backoff (nobody asked, so
 * nobody is owed a cooling-off period).
 *
 * NOTHING HERE STANDS THE AGENT DOWN ANY MORE, and something used to.
 * Taking the tab off it is a protocol act: the wall page sends
 * `control.yield` with `client.yieldControl()`, the gateway routes it, and
 * the engine asks the agent holders of that shared target to stop. This
 * file's job is to LISTEN, which is what `onControlYield` above is for.
 *
 * There is one honest caveat, and the demo shows its cost rather than
 * hiding it. `@browserglass/automation`'s message switch has no case for
 * `control.yield.request` (it falls through `default: break`), so an agent
 * asked to stand down on a shared target is not notified and does not
 * release early. The engine still takes the lease when the grace expires,
 * so the takeover DOES happen and the agent does stop; it stops at
 * `agentPreemptGraceMs` rather than at once, and it learns about it through
 * `control.revoked` rather than through the yield. The `LEASE_REVOKED`
 * branch in `run()` below is what catches that. When the case is added,
 * `onControlYield` here already handles it and the number the page prints
 * drops on its own with nothing changed in this file.
 *
 * `humanType()` re-checks `hasControl(targetId)` before EVERY character,
 * so however the lease goes away, an in-flight typing call abandons itself
 * on the next keystroke rather than finishing the word.
 */

import { AutomationClient, AutomationError } from '@browserglass/automation';
import type { ControlLeaseHandle, ControlYieldEvent } from '@browserglass/automation';
import type { Capability } from '@browserglass/protocol';
import { getBg } from '@browserglass/server';
import type { AgentPhase, AgentStatus } from './agent-lab';
import { LAB_FIELD_CENTRE, LAB_PATH } from './agent-lab';

export type { AgentPhase, AgentStatus } from './agent-lab';

/**
 * What the agent's token carries.
 *
 * `automation` is the one that changes what the agent IS rather than what
 * it may do: the socket layer reads it to decide `kind: 'agent'` on the
 * presence roster, which is what every robot marking in the UI is derived
 * from. `probe` is needed because `ensureGen()` hit-tests the target once
 * to learn its generation number before the first click. No `tabs.manage`,
 * no `devtools`, no `instance.*`: this agent types into one tab and has no
 * business closing tabs or restarting browsers.
 */
const AGENT_CAPS: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'automation',
  'probe',
  'capture',
];

/** Thrown internally to unwind the loop the instant a stand down is asked for. Never escapes this module. */
class StoodDown extends Error {
  constructor() {
    super('stood down');
    this.name = 'StoodDown';
  }
}

const PHRASES = [
  'quarterly revenue by region',
  'open bugs tagged shared control',
  'who owns the lease on tab two',
  'shipping estimates for next week',
  'error rate since the deploy',
  'cost per session, last 30 days',
];

/** Resolves after `ms`. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

class DemoAgent {
  private client: AutomationClient | null = null;
  private lease: ControlLeaseHandle | null = null;
  private offYield: (() => void) | null = null;
  private loop: Promise<void> | null = null;

  private phase: AgentPhase = 'off';
  private step = 'Not running.';
  private cycles = 0;
  private error: string | null = null;
  private stoodDownFor: string | null = null;

  /**
   * Set when this agent is asked to stop, by the SDK's yield notice or by
   * its lease being taken; cleared by `handBack()`. Checked between every
   * step of the loop, with `humanType()`'s own per-character check
   * underneath it.
   */
  private paused = false;

  /**
   * The tab this agent drives. Null until `connect()` resolves when the
   * caller did not name one: `AutomationClient` binds to the instance's
   * active target in that case, and its own `targetId` is the answer.
   * An app that is showing a wall of tabs names one; an app that just
   * wants "the tab" should not have to know its id.
   */
  private targetId: string | null;

  constructor(
    readonly instanceId: string,
    readonly sessionId: string,
    targetId: string | null,
    private readonly origin: string,
  ) {
    this.targetId = targetId;
  }

  status(): AgentStatus {
    return {
      phase: this.phase,
      step: this.step,
      targetId: this.phase === 'off' ? null : this.targetId,
      viewerId: this.client?.viewerId ?? null,
      instanceId: this.instanceId,
      cycles: this.cycles,
      stoodDownFor: this.stoodDownFor,
      error: this.error,
    };
  }

  async start(): Promise<void> {
    if (this.loop !== null) return;
    this.phase = 'starting';
    this.step = 'Connecting to the session.';
    this.error = null;
    this.paused = false;
    this.loop = this.run().catch((err: unknown) => {
      this.phase = 'error';
      this.error = err instanceof Error ? err.message : String(err);
      this.step = 'Stopped after an error.';
      // Cleared so "Start the agent" can try again. Left set, `start()`
      // returns immediately for the rest of the process's life and the
      // button silently does nothing.
      this.loop = null;
    });
  }

  /** Puts the agent back to work. The loop is still running, parked on the paused flag. */
  handBack(): void {
    if (this.phase !== 'stood-down') return;
    this.paused = false;
    this.stoodDownFor = null;
    // Cleared with the rest of it. A stale error line under a running
    // agent reads as a fault happening now.
    this.error = null;
    this.phase = 'working';
    this.step = 'Picking the tab back up.';
  }

  async stop(): Promise<void> {
    this.paused = true;
    this.phase = 'off';
    this.step = 'Not running.';
    this.stoodDownFor = null;
    this.offYield?.();
    this.offYield = null;
    await this.releaseLease();
    this.client?.close();
    this.client = null;
    this.loop = null;
    this.cycles = 0;
  }

  // ── the loop ───────────────────────────────────────────────────────

  private async run(): Promise<void> {
    const bg = getBg();
    const issued = await bg.tokens.issueWithMeta({
      sub: `agent:${this.instanceId}`,
      subKind: 'agent',
      caps: AGENT_CAPS,
      scope: {
        kind: 'instance',
        instanceId: this.instanceId,
        targets: '*',
        sessionId: this.sessionId,
      },
      /*
       * 900 is the gateway's own ceiling, not a preference. Asking for an
       * hour is refused outright: `ttlSeconds 3600 exceeds
       * auth.maxTtlSeconds 900`, which is how this line was found.
       *
       * So this agent has fifteen minutes of socket and then its token
       * expires. That is fine for a demo and NOT fine for a real agent,
       * which should refresh. `AutomationClientOptions` has no
       * `credentials` callback of the kind `BrowserGlassClientOptions`
       * carries, so a long-running agent has to reconnect with a fresh
       * token rather than refresh in place. Recorded here rather than
       * papered over, and stated in `docs/agent-and-human.md`.
       */
      ttlSeconds: 900,
    });

    const client = await AutomationClient.connect({
      endpoint: `${this.origin}${bg.config.wsPath}`,
      token: issued.token,
      ...(this.targetId !== null ? { targetId: this.targetId } : {}),
      instanceId: this.instanceId,
    });
    this.client = client;
    this.targetId = client.targetId;
    // Once, here, and never again. See `onYield`.
    this.offYield = client.onControlYield((ev) => this.onYield(ev));

    const labUrl = `${this.origin.replace(/^ws/, 'http')}${LAB_PATH}`;

    while (this.phase !== 'off') {
      try {
        if (!(await this.waitWhilePaused())) break;
        this.phase = 'working';
        await this.cycle(client, labUrl);
        this.cycles += 1;
      } catch (err) {
        if (err instanceof StoodDown) continue;
        /*
         * Control going away underneath this loop is the SUCCESS case of a
         * takeover, not a fault. Park and wait to be handed back.
         *
         * BOTH codes, and the second one was found by running this rather
         * than by reading it. `LEASE_REVOKED` is what `humanType()` throws
         * when it notices mid word. `LEASE_NOT_HELD` is what the NEXT
         * action throws when the lease went away between actions instead,
         * which is what happens when the engine ends the tenure at the
         * grace deadline and the agent was between steps. Catching only the
         * first put a takeover on screen as
         * "navigate() requires a held ControlLease", in red, which reads as
         * a broken demo and is in fact the demo working.
         */
        if (
          err instanceof AutomationError &&
          (err.code === 'LEASE_REVOKED' || err.code === 'LEASE_NOT_HELD')
        ) {
          // Dropped, and this line matters more than it looks. `take()`
          // skips `acquireControl()` when it believes a lease is already
          // held, so a handle left behind after the ENGINE ended the tenure
          // makes the next hand-back a no-op: the loop resumes, asks for
          // nothing, and fails its first action again. Measured exactly
          // that way before this line existed.
          this.lease = null;
          this.paused = true;
          this.phase = 'stood-down';
          this.step =
            err.code === 'LEASE_REVOKED'
              ? 'Lease taken away mid-keystroke. Stopped typing.'
              : 'Lease gone between actions. Stopped.';
          this.stoodDownFor = this.stoodDownFor ?? 'a person';
          continue;
        }
        this.phase = 'error';
        this.error = err instanceof Error ? err.message : String(err);
        this.step = 'Stopped after an error.';
        await sleep(2000);
        this.error = null;
      }
    }
  }

  /** One visible unit of work: land on the page, put something in the field, file it, read down the list, come back up. */
  private async cycle(client: AutomationClient, labUrl: string): Promise<void> {
    const phrase = PHRASES[this.cycles % PHRASES.length] ?? PHRASES[0]!;

    await this.take(client);

    this.at('Opening the agent lab.');
    // `?run=` makes every cycle a genuine navigation rather than a silent
    // re-render, so the pane shows a page load and the address bar above it
    // changes. It also resets the scroll position, which is what makes the
    // fixed click coordinate below safe.
    await client.navigate(`${labUrl}?run=${this.cycles + 1}`, { waitUntil: 'load' });
    this.check();

    // Load is not readiness for a React page. The lab's field is a
    // CONTROLLED input, so anything typed between `load` and hydration
    // lands in the DOM and is then thrown away when React takes the field
    // over: measured as the first word of every phrase going missing, so
    // "error rate since the deploy" was filed as "te since the deploy".
    // `waitForSelector`/`waitForFunction` would be the right instrument
    // and neither is built in this pass (both throw NOT_IMPLEMENTED,
    // needing the locator engine and page evaluation), so this is a
    // deliberate, commented sleep rather than a poll on nothing.
    this.at('Waiting for the page to settle.');
    await this.pause(800);

    this.at('Clicking into the field.');
    await client.clickAt(LAB_FIELD_CENTRE.x, LAB_FIELD_CENTRE.y);
    this.check();

    // Typed a word at a time rather than in one call. Each word is its own
    // `humanType`, so a stand down between words unwinds here rather than
    // waiting out the rest of the sentence, and a stand down MID word is
    // caught by `humanType`'s own per-character check. Together they put
    // the worst case at one keystroke.
    for (const word of phrase.split(' ')) {
      this.check();
      this.at(`Typing: "${word}"`);
      await client.humanType(`${word} `, { delayMs: 70 });
    }

    this.check();
    this.at('Pressing Enter.');
    await client.pressKey('Enter');

    this.check();
    this.at('Reading down the page.');
    await client.scroll({ dy: 620 });
    await this.pause(900);
    await client.scroll({ dy: 620 });
    await this.pause(900);

    this.check();
    this.at('Scrolling back up.');
    await client.scroll({ dy: -1240 });

    // Control is given back between cycles, deliberately. An agent that
    // holds a lease around the clock is an agent nobody can share a tab
    // with even in shared mode, because the driver rail never stops saying
    // it is driving. Holding it only while it is actually doing something
    // is both more honest and more polite.
    this.at('Idle. Not holding the tab.');
    await this.releaseLease();
    await this.pause(2200);
  }

  /** Asks for the lease and wires the SDK's own yield signals to the stand down. */
  private async take(client: AutomationClient): Promise<void> {
    if (this.lease !== null) return;
    this.at('Asking for control of the tab.');
    const lease = await client.acquireControl({
      waitMs: 15_000,
      durationMs: 120_000,
      reason: 'Demo agent: filling in the agent lab',
    });
    this.lease = lease;
    this.at('Holding the tab.');
  }

  /** Ordinary end-of-cycle release: the agent has finished a loop, nobody asked it to stop. */
  private async releaseLease(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (lease === null) return;
    await lease.release().catch(() => undefined);
  }

  /**
   * The SDK's own stand-down notice, for every target on this socket.
   *
   * Registered once, at connect time. `ControlLeaseHandle`'s per-lease
   * `onPreemptionRequested` would have to be re-registered after every
   * `acquireControl()`, and it goes quiet exactly when the interesting
   * thing happens, since the handle it hangs off is the thing being
   * revoked.
   *
   * A voluntary yield, from an agent that decided by itself to hand over,
   * comes back through here too and is ignored: it carries an empty
   * `byLabel` and `human: false`, so recording it would replace a real
   * answer about who took the tab with a blank one. This agent never calls
   * `yieldControl()` on itself, so in this demo that branch is unreachable;
   * it is handled because an agent that grew a "give up" path later should
   * not have to remember to come back here.
   */
  private onYield(ev: ControlYieldEvent): void {
    if (ev.reason === 'voluntary') return;
    this.lease = null;
    this.paused = true;
    this.phase = 'stood-down';
    this.stoodDownFor = ev.human ? (ev.byLabel === '' ? 'a person' : ev.byLabel) : 'another agent';
    this.step = ev.human
      ? `Stood down mid ${ev.inFlight[0]?.action ?? 'idle'}. Not driving.`
      : `Outranked by ${this.stoodDownFor}. Not driving.`;
  }

  /**
   * Blocks until the agent is handed back, checking often enough that "hand
   * back" feels immediate. Returns false if it was stopped while parked,
   * which the caller uses to leave the loop: reading `this.phase` at the
   * call site would not work, because TypeScript narrows it off the `while`
   * condition and cannot see that an await in between changed it.
   */
  private async waitWhilePaused(): Promise<boolean> {
    while (this.paused && this.phase !== 'off') {
      await sleep(120);
    }
    return this.phase !== 'off';
  }

  /** Throws out of the current cycle if a stand down arrived while the last step was in flight. */
  private check(): void {
    if (this.paused || this.phase === 'off') throw new StoodDown();
  }

  /** A pause that a stand down cuts short rather than one that has to be waited out. */
  private async pause(ms: number): Promise<void> {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      this.check();
      await sleep(Math.min(100, until - Date.now()));
    }
  }

  private at(step: string): void {
    this.step = step;
  }
}

/**
 * One agent per instance, kept on `globalThis` for the same reason
 * `defineGlobalBg` is: Next's dev server re-evaluates route modules on
 * every edit, and a module-level `Map` would hand back an empty one after a
 * hot reload while the previous agent's socket was still open and still
 * typing.
 */
const demoAgentGlobal = globalThis as unknown as { __bglsDemoAgents?: Map<string, DemoAgent> };
demoAgentGlobal.__bglsDemoAgents ??= new Map();
const REGISTRY: Map<string, DemoAgent> = demoAgentGlobal.__bglsDemoAgents;

export interface StartAgentOptions {
  instanceId: string;
  sessionId: string;
  /** Which tab to drive, or null to take the instance's active one. */
  targetId: string | null;
  /** The `ws://host:port` this process is listening on. The agent dials back into its own gateway. */
  origin: string;
}

export async function startAgent(opts: StartAgentOptions): Promise<AgentStatus> {
  const existing = REGISTRY.get(opts.instanceId);
  if (existing) {
    existing.handBack();
    return existing.status();
  }
  const agent = new DemoAgent(opts.instanceId, opts.sessionId, opts.targetId, opts.origin);
  REGISTRY.set(opts.instanceId, agent);
  await agent.start();
  return agent.status();
}

export function agentStatus(instanceId: string): AgentStatus | null {
  return REGISTRY.get(instanceId)?.status() ?? null;
}

export function handBackAgent(instanceId: string): AgentStatus | null {
  const agent = REGISTRY.get(instanceId);
  if (!agent) return null;
  agent.handBack();
  return agent.status();
}

export async function stopAgent(instanceId: string): Promise<AgentStatus | null> {
  const agent = REGISTRY.get(instanceId);
  if (!agent) return null;
  await agent.stop();
  REGISTRY.delete(instanceId);
  return agent.status();
}
