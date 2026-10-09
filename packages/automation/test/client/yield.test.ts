import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ControlYieldEvent } from '../../src/index.js';
import { connectFakeClient, tick } from '../helpers.js';

/**
 * The stand-down: an agent that yields must not silently keep sending
 * input; a half yielded agent is worse than no yield at all.
 *
 * Driven against the scripted fake gateway rather than a real one, for the
 * same reason the rest of this package's suites are: what is being checked
 * here is entirely client-side behaviour, "given this sequence of wire
 * messages, does this client stop", and a fake lets a test put the takeover
 * at an exact point mid-action, which no real gateway would let it do
 * reliably.
 *
 * Two flavours of takeover appear throughout, deliberately:
 *
 * - `reason: 'human_takeover'`, which is what the protocol DOCUMENTS a
 *   person taking over as, and what the engine is meant to send.
 * - `reason: 'priority'` from a requester the presence roster says is a
 *   `human`, which is what the engine sends TODAY: `beginPreempt` hardcodes
 *   `force ? 'force_claim' : 'priority'` and emits `'human_takeover'`
 *   nowhere at all.
 *
 * Both have to be read as "a person is taking over", or this client is
 * correct against the spec and wrong against the running system.
 */
describe('standing down when control is taken', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  /** Connects, primes the target generation (so interaction methods need no round trip), and takes the lease. */
  async function connectHolding() {
    const ctx = await connectFakeClient();
    await ctx.client.inspectAt(0, 0);
    const leasePromise = ctx.client.acquireControl({ waitMs: 5000 });
    await tick();
    const lease = await leasePromise;
    return { ...ctx, lease };
  }

  function inputCount(gateway: {
    ws: { sentJsonMessages(): Array<Record<string, unknown>> };
  }): number {
    return gateway.ws
      .sentJsonMessages()
      .filter((m) => typeof m['t'] === 'string' && (m['t'] as string).startsWith('input.')).length;
  }

  describe('the shared-mode yield notice', () => {
    it('shuts the dispatch gate and reports a human takeover, rather than falling through unhandled', async () => {
      const { client, gateway } = await connectHolding();

      await client.clickAt(10, 10);
      expect(inputCount(gateway)).toBeGreaterThan(0);
      const before = inputCount(gateway);

      const seen: Array<{ human: boolean; reason: string; byLabel: string; phase: string }> = [];
      client.onControlYield((ev) => {
        seen.push({ human: ev.human, reason: ev.reason, byLabel: ev.byLabel, phase: ev.phase });
      });

      gateway.sendYieldRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
        reason: 'taking this one',
      });

      // The event fired at all. Before the handler existed this message hit
      // `default: break` and nothing below here was true.
      expect(seen.length).toBeGreaterThan(0);
      expect(seen[0]).toMatchObject({ human: true, reason: 'human_takeover', byLabel: 'Alice' });

      // `human` and `reason` are true BY CONSTRUCTION, not by inspecting the
      // wire: the server refuses `control.yield` from an automation client
      // with `bgls.error.control.not_human`, so this message can only have
      // come from a person. Note the requester's free-text reason
      // ('taking this one') is deliberately NOT mapped onto the event's
      // `reason` union.
      expect(seen[0]?.reason).not.toBe('taking this one');

      // The gate is genuinely shut, which is the half that matters. Being
      // merely leaseless is what produced `LEASE_NOT_HELD` thrown at the
      // person who had just taken over.
      await expect(client.clickAt(20, 20)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });
      expect(inputCount(gateway)).toBe(before);
    });
  });

  describe('the dispatch gate', () => {
    it('refuses every interaction method the instant preemption step 1 arrives, before the grace window has run at all', async () => {
      const { client, gateway } = await connectHolding();

      await client.clickAt(10, 10);
      const beforeYield = inputCount(gateway);
      expect(beforeYield).toBeGreaterThan(0);

      // Step 1 only. The lease is still held and the server would still
      // dispatch this client's input for another 2000ms. It stops anyway.
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      for (const call of [
        () => client.clickAt(20, 20),
        () => client.moveTo(30, 30),
        () => client.type('nope'),
        () => client.insertText('nope'),
        () => client.pressKey('Enter'),
        () => client.scroll({ dy: 100 }),
        () => client.humanType('nope'),
        () => client.navigate('https://example.test/elsewhere'),
      ]) {
        await expect(call()).rejects.toMatchObject({
          code: 'LEASE_REVOKED',
          details: expect.objectContaining({ yielded: true, human: true }),
        });
      }

      // Not one more input frame reached the wire after the yield. This is
      // the whole point: the count is identical, not merely smaller.
      expect(inputCount(gateway)).toBe(beforeYield);

      client.close();
    });

    it('never splits a mouse down from its up: a yield arriving between two clicks stops the second one whole', async () => {
      const { client, gateway } = await connectHolding();

      await client.clickAt(10, 10);
      const sent = gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse');
      expect(sent.map((m) => m['kind'])).toEqual(['down', 'up']);

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      await expect(client.clickAt(20, 20)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });

      // Still exactly one balanced pair. A gate that checked per frame
      // rather than per atomic group could leave a button held down inside
      // a page a person has just taken over, which is worse than the frame
      // it saved.
      const after = gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'input.mouse');
      expect(after.map((m) => m['kind'])).toEqual(['down', 'up']);

      client.close();
    });

    it('stops a long type() partway through rather than at the next call', async () => {
      const { client, gateway } = await connectHolding();

      // A type() that yields mid-string is not directly reachable
      // synchronously, so this checks the other half of the same
      // guarantee: the per-character check exists and refuses the whole
      // call once the gate is closed, dispatching nothing.
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      const before = inputCount(gateway);
      await expect(client.type('a-very-long-string-of-characters')).rejects.toMatchObject({
        code: 'LEASE_REVOKED',
      });
      expect(inputCount(gateway)).toBe(before);

      client.close();
    });

    it('abandons a paced humanType() mid-string and still reports how far it got', async () => {
      const { client, gateway } = await connectHolding();

      const text = 'hello world';
      const typePromise = client.humanType(text, { delayMs: 80 });
      typePromise.catch(() => {});
      await tick(80);
      await tick(80);
      const midway = inputCount(gateway);

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      await tick(2000);

      await expect(typePromise).rejects.toMatchObject({
        code: 'LEASE_REVOKED',
        details: expect.objectContaining({
          partial: true,
          yielded: true,
          human: true,
          byLabel: 'Alice',
          charsTotal: text.length,
        }),
      });
      // Abandoned on step 1, not merely on step 2: no further keystroke
      // went out during the grace window it could have kept typing through.
      expect(inputCount(gateway)).toBe(midway);

      client.close();
    });

    it('stays closed after the lease is actually taken, so a stray call once the handle is gone still cannot dispatch', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 30000,
      });
      const after = inputCount(gateway);

      await expect(client.clickAt(1, 1)).rejects.toMatchObject({
        code: 'LEASE_REVOKED',
        details: expect.objectContaining({ yielded: true, phase: 'taken' }),
      });
      expect(inputCount(gateway)).toBe(after);

      client.close();
    });

    it('reopens on the same lease when the preemption is withdrawn, because nothing was ever taken', async () => {
      // `releaseOnYield: false` is what makes this case reachable at all:
      // with the default the client has already handed the lease back by
      // the time the requester withdraws, so there is nothing to resume
      // onto and the correct next step is a fresh acquire. This option is
      // for the agent that needs the grace window to finish cleaning up,
      // and the withdrawal path is where it pays off.
      const { client, gateway } = await connectFakeClient({
        yieldPolicy: { releaseOnYield: false },
      });
      await client.inspectAt(0, 0);
      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });

      gateway.sendPreemptCancelled(client.targetId);
      expect(client.yieldStatus()).toBeNull();

      // Straight back to work on the lease it never lost, with no
      // re-acquire needed.
      await client.clickAt(1, 1);

      client.close();
    });
  });

  describe('the hook an agent author uses', () => {
    it('fires connection-wide with who took over, whether they were a person, and what was in flight', async () => {
      const { client, gateway } = await connectHolding();

      const seen: ControlYieldEvent[] = [];
      client.onControlYield((ev) => seen.push(ev));

      const typePromise = client.humanType('hello world', { delayMs: 80 });
      typePromise.catch(() => {});
      await tick(80);

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      await tick(2000);

      expect(seen).toHaveLength(1);
      const ev = seen[0] as ControlYieldEvent;
      expect(ev.phase).toBe('requested');
      expect(ev.byLabel).toBe('Alice');
      expect(ev.human).toBe(true);
      expect(ev.reason).toBe('human_takeover');
      expect(ev.inFlight.map((a) => a.action)).toContain('humanType');

      client.close();
    });

    it("reads a today's-engine takeover (reason 'priority' from a human in presence) as a person, not as a rival agent", async () => {
      const { client, gateway } = await connectHolding();
      // This is the case that matters while the engine still sends it: the wire says
      // `priority`, and the ONLY thing distinguishing a person from another
      // agent is the presence roster.
      gateway.sendPresence([{ viewerId: 'vwr_human_1', label: 'Alice', kind: 'human' }]);

      const seen: ControlYieldEvent[] = [];
      client.onControlYield((ev) => seen.push(ev));
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
        reason: 'priority',
        byViewerId: 'vwr_human_1',
      });

      expect(seen[0]?.reason).toBe('priority');
      expect(seen[0]?.human).toBe(true);

      client.close();
    });

    it('reads another agent outranking this one as NOT a person, which is the distinction the whole reason field exists for', async () => {
      const { client, gateway } = await connectHolding();
      gateway.sendPresence([{ viewerId: 'vwr_agent_2', label: 'crawler-7', kind: 'agent' }]);

      const seen: ControlYieldEvent[] = [];
      client.onControlYield((ev) => seen.push(ev));

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'crawler-7',
        graceMs: 2000,
        deadlineInMs: 2000,
        reason: 'priority',
        byViewerId: 'vwr_agent_2',
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'crawler-7',
        released: true,
        requeueAfterMs: 30000,
        reason: 'priority',
        byViewerId: 'vwr_agent_2',
      });

      expect(seen[0]?.human).toBe(false);
      expect(seen[0]?.byKind).toBe('automation');

      client.close();
    });

    it('fires onRevoked with preempted_by_agent (not preempted_by_human) when a rival agent wins', async () => {
      const { client, gateway, lease } = await connectHolding();
      gateway.sendPresence([{ viewerId: 'vwr_agent_2', label: 'crawler-7', kind: 'agent' }]);

      const revoked: string[] = [];
      lease.onRevoked((r) => revoked.push(r));
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'crawler-7',
        graceMs: 2000,
        deadlineInMs: 2000,
        reason: 'priority',
        byViewerId: 'vwr_agent_2',
      });

      expect(revoked).toEqual(['preempted_by_agent']);

      client.close();
    });

    it('closes the gate before any listener runs, so no listener can observe a client that is notified but still dispatching', async () => {
      const { client, gateway } = await connectHolding();

      let dispatchAllowedInsideHandler: boolean | null = null;
      client.onControlYield(() => {
        // `yieldStatus()` being non-null inside the handler is the
        // observable form of "the gate is already shut".
        dispatchAllowedInsideHandler = client.yieldStatus() === null;
      });
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      expect(dispatchAllowedInsideHandler).toBe(false);

      client.close();
    });

    it('survives a listener that throws', async () => {
      const { client, gateway } = await connectHolding();
      client.onControlYield(() => {
        throw new Error('agent handler blew up');
      });
      const seen: ControlYieldEvent[] = [];
      client.onControlYield((ev) => seen.push(ev));

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      expect(seen).toHaveLength(1);
      expect(client.yieldStatus()?.human).toBe(true);

      client.close();
    });
  });

  describe('handing the lease back', () => {
    it('releases inside the grace window by default rather than making the person wait it out', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      // Synchronously on receipt: no timer, no microtask, no waiting for
      // the 2000ms deadline.
      expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(true);

      client.close();
    });

    it('fires onRevoked even though it released itself, so yielding promptly does not cost the agent the notification', async () => {
      const { client, gateway, lease } = await connectHolding();
      const revoked: string[] = [];
      lease.onRevoked((r) => revoked.push(r));

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      expect(revoked).toEqual(['preempted_by_human']);
      expect(lease.expiresAt).toBeGreaterThan(0);

      client.close();
    });

    it('holds the lease through the grace when releaseOnYield is false, but still dispatches nothing', async () => {
      const harnessCtx = await connectFakeClient({ yieldPolicy: { releaseOnYield: false } });
      const { client, gateway } = harnessCtx;
      await client.inspectAt(0, 0);
      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;

      const before = inputCount(gateway);
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });

      expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(false);
      await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });
      expect(inputCount(gateway)).toBe(before);

      client.close();
    });

    it('stops auto-renewing the moment it stands down: nothing asks to extend a lease being handed over', async () => {
      const harnessCtx = await connectFakeClient({ yieldPolicy: { releaseOnYield: false } });
      const { client, gateway } = harnessCtx;
      const leasePromise = client.acquireControl({ waitMs: 5000, durationMs: 60000 });
      await tick();
      await leasePromise;

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      await tick(120000);

      expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.renew')).toBe(false);

      client.close();
    });
  });

  describe('resuming', () => {
    it('applies the requeue backoff even when this client released inside the grace itself', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      // Released early, so by the time control.preempted lands this client
      // no longer has a lease handle. The backoff has to be stamped anyway:
      // keying it off a live handle used to exempt exactly the
      // well-behaved client from the window, letting the agent that
      // yielded fastest be the first one back fighting the person.
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 30000,
      });

      await expect(client.acquireControl({ waitMs: 0 })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: expect.objectContaining({ yielded: true, human: true, byLabel: 'Alice' }),
      });

      client.close();
    });

    it('refuses an acquire during the grace window, so an agent cannot hand over and take it straight back', async () => {
      const { client, gateway } = await connectHolding();

      // The gap this closes: on step 1 there is no `requeueAfterMs` yet
      // (it arrives one message later, with `control.preempted`), and
      // acquiring is the one thing that reopens dispatch. So without an
      // explicit refusal here, "yield then acquire" is a legal sequence
      // that undoes the yield entirely, and any acquire-do-release helper
      // walks into it by accident.
      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      const requestsBefore = gateway.ws
        .sentJsonMessages()
        .filter((m) => m['t'] === 'control.request').length;

      await expect(client.acquireControl({ waitMs: 0 })).rejects.toMatchObject({
        code: 'POLICY_DENIED',
        details: expect.objectContaining({
          yielded: true,
          phase: 'requested',
          human: true,
          byLabel: 'Alice',
        }),
      });
      // Refused locally: no second control.request went near the wire.
      expect(gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'control.request').length).toBe(
        requestsBefore,
      );
      expect(client.yieldStatus()).not.toBeNull();

      client.close();
    });

    it('never re-acquires on its own: after the backoff elapses the client is still stood down until it asks', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 30000,
      });
      const controlRequestsBefore = gateway.ws
        .sentJsonMessages()
        .filter((m) => m['t'] === 'control.request').length;

      await tick(120000);

      // Four times the backoff later: no control.request went out, and the
      // gate is still shut. An agent resumes because its own code decided
      // to, never because a timer expired.
      expect(gateway.ws.sentJsonMessages().filter((m) => m['t'] === 'control.request').length).toBe(
        controlRequestsBefore,
      );
      expect(client.yieldStatus()).not.toBeNull();
      await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });

      client.close();
    });

    it('waitForResume() waits out the backoff AND waits for the person to actually let go', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 30000,
      });
      gateway.sendControlState(client.targetId, {
        viewerId: 'vwr_00000000000000000000000099',
        label: 'Alice',
      });

      let resolved = false;
      const waiting = client.waitForResume().then(() => {
        resolved = true;
      });

      // The backoff elapses, and that is deliberately NOT enough: Alice
      // still holds the lease. Waiting out only the clock is exactly the
      // failure this method exists to prevent.
      await tick(31000);
      expect(resolved).toBe(false);

      gateway.sendControlState(client.targetId, null);
      await tick();
      await waiting;
      expect(resolved).toBe(true);

      client.close();
    });

    it('waitForResume() resolving still leaves the client stood down: only a fresh grant reopens dispatch', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 30000,
      });
      gateway.sendControlState(client.targetId, null);

      const waiting = client.waitForResume();
      await tick(31000);
      await waiting;

      await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });

      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;

      expect(client.yieldStatus()).toBeNull();
      await client.clickAt(1, 1);

      client.close();
    });

    it('waitForResume() throws TIMEOUT rather than resolving early while somebody else is still driving', async () => {
      const { client, gateway } = await connectHolding();

      gateway.sendPreemptRequest(client.targetId, {
        byLabel: 'Alice',
        graceMs: 2000,
        deadlineInMs: 2000,
      });
      gateway.sendPreempted(client.targetId, {
        byLabel: 'Alice',
        released: true,
        requeueAfterMs: 1000,
      });
      gateway.sendControlState(client.targetId, {
        viewerId: 'vwr_00000000000000000000000099',
        label: 'Alice',
      });

      const waiting = client.waitForResume({ timeoutMs: 5000 });
      const assertion = expect(waiting).rejects.toMatchObject({ code: 'TIMEOUT' });
      await tick(6000);
      await assertion;

      client.close();
    });
  });

  describe('yielding deliberately', () => {
    it('yieldControl() releases, stops dispatching, and imposes no backoff of its own', async () => {
      const { client, gateway } = await connectHolding();

      await client.yieldControl('handing back to the operator');

      expect(gateway.ws.sentJsonMessages().some((m) => m['t'] === 'control.release')).toBe(true);
      const ev = client.yieldStatus();
      expect(ev?.reason).toBe('voluntary');
      expect(ev?.human).toBe(false);
      expect(ev?.resumeNotBefore).toBeNull();
      await expect(client.clickAt(1, 1)).rejects.toMatchObject({ code: 'LEASE_REVOKED' });

      // Nobody imposed a window, so asking again is allowed immediately.
      // Asking is still required: dispatch stays shut until the grant.
      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;
      expect(client.yieldStatus()).toBeNull();

      client.close();
    });
  });
});
