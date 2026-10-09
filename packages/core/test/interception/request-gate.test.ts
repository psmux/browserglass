/**
 * `RequestGate` behaviour, driven through the same scripted `CdpBridge`
 * double the `TargetDiagnostics` suite uses.
 *
 * The tests that matter most here are not the happy paths. They are:
 *  * the escalation guards (no `fulfillRequest`, no rewritten
 *    `continueRequest`, no Response stage), because those are the entire
 *    security argument for exposing this at all; and
 *  * `rebind`, because a gate that misses a renderer swap fails OPEN and
 *    reports nothing anywhere.
 */

import { describe, expect, it, vi } from 'vitest';
import type { CdpSessionId } from '../../src/cdp/types.js';
import {
  type GatedRequest,
  RequestGate,
  type RequestVerdict,
} from '../../src/interception/request-gate.js';
import { FakeCdpBridge, asFakeBridge } from '../diagnostics/test-helpers.js';

const SID = 'sess-1' as CdpSessionId;
const SID2 = 'sess-2' as CdpSessionId;

function gateWith(
  handler: (req: GatedRequest) => RequestVerdict | Promise<RequestVerdict>,
  opts?: {
    verdictTimeoutMs?: number;
    onTimeoutVerdict?: RequestVerdict;
    onError?: (e: unknown, r: GatedRequest) => void;
  },
) {
  const bridge = new FakeCdpBridge();
  const gate = new RequestGate({
    bridge: asFakeBridge(bridge),
    targetId: 'tgt_1',
    sessionId: SID,
    handler,
    ...(opts?.verdictTimeoutMs !== undefined ? { verdictTimeoutMs: opts.verdictTimeoutMs } : {}),
    ...(opts?.onTimeoutVerdict !== undefined ? { onTimeoutVerdict: opts.onTimeoutVerdict } : {}),
    ...(opts?.onError !== undefined ? { onError: opts.onError } : {}),
  });
  return { bridge, gate };
}

function pausedEvent(over?: Record<string, unknown>): Record<string, unknown> {
  return {
    requestId: 'req-1',
    resourceType: 'XHR',
    request: {
      url: 'https://example.com/checkout',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Thing': 'v' },
      postData: '{"a":1}',
    },
    ...over,
  };
}

/** Lets the gate's own `await` chain settle; every verdict path is async. */
const settle = () => new Promise((r) => setTimeout(r, 0));

describe('RequestGate: enabling', () => {
  it('enables Fetch at the Request stage only, so response rewriting is unreachable rather than merely forbidden', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.start();
    const enable = bridge.sent.find((s) => s.method === 'Fetch.enable');
    expect(enable).toBeDefined();
    const patterns = (enable?.params as { patterns: Array<Record<string, unknown>> }).patterns;
    expect(patterns).toHaveLength(1);
    expect(patterns[0]?.requestStage).toBe('Request');
    // Never 'Response': at the Request stage `Fetch.getResponseBody` and
    // `Fetch.continueResponse` do not apply at all.
    expect(JSON.stringify(patterns)).not.toContain('Response');
  });

  it('is not armed until Fetch.enable actually succeeds, so isArmed answers "is it really on" and not "did somebody ask"', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    expect(gate.isArmed).toBe(false);
    bridge.rejectNext('Fetch.enable', new Error('session gone'));
    await expect(gate.start()).rejects.toThrow('session gone');
    expect(gate.isArmed).toBe(false);
  });

  it('start() is idempotent and does not stack a second Fetch.enable owner on one session', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.start();
    await gate.start();
    expect(bridge.sendCountFor('Fetch.enable')).toBe(1);
  });
});

describe('RequestGate: verdicts', () => {
  it('allows with a bare continueRequest carrying the request id and NOTHING else', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await settle();

    const cont = bridge.sent.find((s) => s.method === 'Fetch.continueRequest');
    expect(cont).toBeDefined();
    // This assertion IS the security property. Every one of these fields
    // is an egress rewrite, and the gate must never send any of them.
    expect(Object.keys(cont?.params ?? {})).toEqual(['requestId']);
    for (const forbidden of ['url', 'method', 'postData', 'headers', 'interceptHeaders']) {
      expect(cont?.params).not.toHaveProperty(forbidden);
    }
  });

  it('never sends Fetch.fulfillRequest on any path, because response forgery is the thing the deny list exists to stop', async () => {
    const { bridge, gate } = gateWith((r) => (r.url.includes('apply') ? 'deny' : 'allow'));
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    bridge.emit(
      'Fetch.requestPaused',
      pausedEvent({
        requestId: 'req-2',
        request: { url: 'https://cdn/x.js', method: 'GET', headers: {} },
      }),
      SID,
    );
    await settle();
    expect(bridge.sendCountFor('Fetch.fulfillRequest')).toBe(0);
  });

  it('denies with BlockedByClient, the reason Chrome itself reports for an extension blocked request', async () => {
    const { bridge, gate } = gateWith(() => 'deny');
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await settle();
    const failed = bridge.sent.find((s) => s.method === 'Fetch.failRequest');
    expect(failed?.params).toEqual({ requestId: 'req-1', errorReason: 'BlockedByClient' });
  });

  it('hands the handler the url, method, resourceType, lower cased headers and postData', async () => {
    const seen: GatedRequest[] = [];
    const { bridge, gate } = gateWith((r) => {
      seen.push(r);
      return 'allow';
    });
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await settle();
    expect(seen[0]?.url).toBe('https://example.com/checkout');
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.resourceType).toBe('XHR');
    expect(seen[0]?.postData).toBe('{"a":1}');
    expect(seen[0]?.headers['content-type']).toBe('application/json');
  });

  it('continues a Response stage pause untouched instead of deciding on it, since it only ever asked for the Request stage', async () => {
    const handler = vi.fn(() => 'allow' as const);
    const { bridge, gate } = gateWith(handler);
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent({ responseStatusCode: 200 }), SID);
    await settle();
    expect(handler).not.toHaveBeenCalled();
    expect(bridge.sendCountFor('Fetch.continueRequest')).toBe(1);
  });
});

describe('RequestGate: failure policy', () => {
  it('denies by default when the handler throws, because a gate that fails open is not a gate', async () => {
    const errors: unknown[] = [];
    const { bridge, gate } = gateWith(
      () => {
        throw new Error('handler exploded');
      },
      { onError: (e) => errors.push(e) },
    );
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await settle();
    expect(bridge.sendCountFor('Fetch.failRequest')).toBe(1);
    expect(errors).toHaveLength(1);
  });

  it('denies by default when the handler exceeds its verdict timeout, and says so through onError', async () => {
    const errors: unknown[] = [];
    const { bridge, gate } = gateWith(() => new Promise<RequestVerdict>(() => undefined), {
      verdictTimeoutMs: 10,
      onError: (e) => errors.push(e),
    });
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.sendCountFor('Fetch.failRequest')).toBe(1);
    expect(String(errors[0])).toContain('timed out');
  });

  it('honours an operator who would rather lose the gate than lose the page', async () => {
    const { bridge, gate } = gateWith(() => new Promise<RequestVerdict>(() => undefined), {
      verdictTimeoutMs: 10,
      onTimeoutVerdict: 'allow',
    });
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await new Promise((r) => setTimeout(r, 40));
    expect(bridge.sendCountFor('Fetch.continueRequest')).toBe(1);
    expect(bridge.sendCountFor('Fetch.failRequest')).toBe(0);
  });

  it('treats any non-deny return as an allow, so a handler returning something odd cannot read as a silent block', async () => {
    const { bridge, gate } = gateWith(() => 'whatever' as unknown as RequestVerdict);
    await gate.start();
    bridge.emit('Fetch.requestPaused', pausedEvent(), SID);
    await settle();
    expect(bridge.sendCountFor('Fetch.continueRequest')).toBe(1);
  });
});

describe('RequestGate: rebind, the fail open trap', () => {
  it('re-enables Fetch on the new session after a renderer swap, or every request on the new page is silently allowed', async () => {
    const { bridge, gate } = gateWith(() => 'deny');
    await gate.start();
    expect(bridge.sent.filter((s) => s.method === 'Fetch.enable')[0]?.sessionId).toBe(SID);

    await gate.rebind(SID2);

    const enables = bridge.sent.filter((s) => s.method === 'Fetch.enable');
    expect(enables).toHaveLength(2);
    expect(enables[1]?.sessionId).toBe(SID2);
    expect(gate.isArmed).toBe(true);
  });

  it('still gates after the swap: a request on the NEW session is denied, not waved through', async () => {
    const { bridge, gate } = gateWith(() => 'deny');
    await gate.start();
    await gate.rebind(SID2);

    bridge.emit('Fetch.requestPaused', pausedEvent(), SID2);
    await settle();

    const failed = bridge.sent.filter((s) => s.method === 'Fetch.failRequest');
    expect(failed).toHaveLength(1);
    expect(failed[0]?.sessionId).toBe(SID2);
  });

  it('ignores an event already in flight for the dead session, so it cannot mutate state belonging to the new one', async () => {
    const handler = vi.fn(() => 'deny' as const);
    const { bridge, gate } = gateWith(handler);
    await gate.start();
    const staleHandler = bridge.firstRegistration('Fetch.requestPaused', SID);
    await gate.rebind(SID2);

    // Simulates the real race: the bridge dispatch loop had already picked
    // this handler up before `rebind()` unsubscribed it.
    staleHandler(pausedEvent(), SID);
    await settle();
    expect(handler).not.toHaveBeenCalled();
  });
});

describe('RequestGate: teardown', () => {
  it('disables exactly the domain it enabled', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.start();
    await gate.stop();
    expect(bridge.sendCountFor('Fetch.disable')).toBe(1);
    expect(gate.isArmed).toBe(false);
  });

  it('does not send Fetch.disable when it never enabled anything', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.stop();
    expect(bridge.sendCountFor('Fetch.disable')).toBe(0);
  });

  it('is idempotent and survives a session that is already gone', async () => {
    const { bridge, gate } = gateWith(() => 'allow');
    await gate.start();
    bridge.rejectNext('Fetch.disable', new Error('session gone'));
    await expect(gate.stop()).resolves.toBeUndefined();
    await expect(gate.stop()).resolves.toBeUndefined();
    expect(bridge.sendCountFor('Fetch.disable')).toBe(1);
  });

  it('refuses to start again after stop, rather than half reviving onto a dead session', async () => {
    const { gate } = gateWith(() => 'allow');
    await gate.start();
    await gate.stop();
    await expect(gate.start()).rejects.toThrow('cannot start() after stop()');
  });
});

describe('RequestGate: load', () => {
  it('applies the timeout verdict without asking once too many requests are held, and reports that it did', async () => {
    const errors: unknown[] = [];
    let release: (() => void) | null = null;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const { bridge, gate } = gateWith(
      async () => {
        await blocked;
        return 'allow';
      },
      { onError: (e) => errors.push(e), verdictTimeoutMs: 60_000 },
    );
    await gate.start();

    // 70 concurrent, over the 64 ceiling.
    for (let i = 0; i < 70; i += 1) {
      bridge.emit('Fetch.requestPaused', pausedEvent({ requestId: `req-${i}` }), SID);
    }
    await settle();

    expect(gate.stats.held).toBeLessThanOrEqual(64);
    expect(errors.some((e) => String(e).includes('ceiling'))).toBe(true);
    // The overflow was answered rather than left hanging: a held request
    // occupies a real Chrome network slot.
    expect(bridge.sendCountFor('Fetch.failRequest')).toBeGreaterThan(0);
    release?.();
  });
});
