import { describe, expect, it } from 'vitest';
import type {
  ConsoleEntry,
  DiagnosticsSubscribe,
  DiagnosticsSubscribed,
  DiagnosticsUnsubscribe,
  NetworkRequestEntry,
} from '../../src/wire/messages/diagnostics.js';

/**
 * Plain JSON fields on a `bgls.v1` control message (`envelope.ts`): there is
 * no separate wire schema layer to encode against, so a round trip here is
 * `JSON.stringify` then `JSON.parse`, exactly what the WebSocket text frame
 * does. `diagnostics.subscribe`'s three feed flags are optional and must
 * stay absent (not coerced to `false`) when the caller omits them, since
 * the server side default ("console and errors, not network") depends on
 * being able to tell "omitted" from "explicitly false".
 */
describe('diagnostics.subscribe feed flags', () => {
  it('round trips all three feeds set', () => {
    const msg: DiagnosticsSubscribe = {
      v: 1,
      t: 'diagnostics.subscribe',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      console: true,
      errors: true,
      network: true,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as DiagnosticsSubscribe;
    expect(roundTripped.console).toBe(true);
    expect(roundTripped.errors).toBe(true);
    expect(roundTripped.network).toBe(true);
  });

  it('stays absent, not false, when the caller omits every feed flag', () => {
    const msg: DiagnosticsSubscribe = {
      v: 1,
      t: 'diagnostics.subscribe',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as DiagnosticsSubscribe;
    expect('console' in roundTripped).toBe(false);
    expect('errors' in roundTripped).toBe(false);
    expect('network' in roundTripped).toBe(false);
  });
});

describe('diagnostics.unsubscribe', () => {
  it('round trips targetId', () => {
    const msg: DiagnosticsUnsubscribe = {
      v: 1,
      t: 'diagnostics.unsubscribe',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as DiagnosticsUnsubscribe;
    expect(roundTripped.targetId).toBe('tgt_00000000000000000000000001');
  });
});

describe('diagnostics.subscribed', () => {
  it('round trips the actually enabled feeds, all three required (not optional like the request)', () => {
    const msg: DiagnosticsSubscribed = {
      v: 1,
      t: 'diagnostics.subscribed',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      console: true,
      errors: false,
      network: false,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as DiagnosticsSubscribed;
    expect(roundTripped.console).toBe(true);
    expect(roundTripped.errors).toBe(false);
    expect(roundTripped.network).toBe(false);
  });
});

describe('console.entry coalesced count', () => {
  it('round trips a coalesced count greater than 1', () => {
    const msg: ConsoleEntry = {
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      level: 'warn',
      text: 'repeated warning',
      count: 7,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as ConsoleEntry;
    expect(roundTripped.count).toBe(7);
  });

  it('stays absent when never coalesced', () => {
    const msg: ConsoleEntry = {
      v: 1,
      t: 'console.entry',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      level: 'log',
      text: 'hello',
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as ConsoleEntry;
    expect('count' in roundTripped).toBe(false);
  });
});

describe('network.request in flight vs finished', () => {
  const base: Omit<NetworkRequestEntry, 'status' | 'errorText' | 'durationMs' | 'encodedBytes'> = {
    v: 1,
    t: 'network.request',
    ts: Date.now(),
    targetId: 'tgt_00000000000000000000000001',
    requestId: 'req-1',
    method: 'GET',
    url: 'https://example.test/',
    resourceType: 'Document',
    fromCache: false,
    startedAt: Date.now(),
  };

  it('round trips a still in flight request as three explicit nulls, not omitted fields', () => {
    const msg: NetworkRequestEntry = {
      ...base,
      status: null,
      errorText: null,
      durationMs: null,
      encodedBytes: null,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as NetworkRequestEntry;
    expect(roundTripped.status).toBeNull();
    expect(roundTripped.errorText).toBeNull();
    expect(roundTripped.durationMs).toBeNull();
    expect('durationMs' in roundTripped).toBe(true);
  });

  it('round trips a finished request', () => {
    const msg: NetworkRequestEntry = {
      ...base,
      status: 200,
      errorText: null,
      durationMs: 42,
      encodedBytes: 1024,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as NetworkRequestEntry;
    expect(roundTripped.status).toBe(200);
    expect(roundTripped.durationMs).toBe(42);
    expect(roundTripped.encodedBytes).toBe(1024);
  });

  it('round trips a failed request', () => {
    const msg: NetworkRequestEntry = {
      ...base,
      status: null,
      errorText: 'net::ERR_FAILED',
      durationMs: 10,
      encodedBytes: null,
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as NetworkRequestEntry;
    expect(roundTripped.status).toBeNull();
    expect(roundTripped.errorText).toBe('net::ERR_FAILED');
  });
});
