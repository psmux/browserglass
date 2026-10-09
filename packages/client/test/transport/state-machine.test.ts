import { describe, expect, it } from 'vitest';
import {
  ALLOWED_TRANSITIONS,
  ConnectionStateMachine,
  InvalidConnectionTransition,
} from '../../src/transport/state-machine.js';
import type { ConnectionState } from '../../src/transport/types.js';

const ALL_STATES: ConnectionState[] = [
  'idle',
  'connecting',
  'handshaking',
  'live',
  'degraded',
  'reconnecting',
  'resuming',
  'fatal',
];

describe('ALLOWED_TRANSITIONS', () => {
  it('has exactly one row per connection state', () => {
    expect(Object.keys(ALLOWED_TRANSITIONS).sort()).toEqual([...ALL_STATES].sort());
  });

  it('matches the transition table, including the handshaking and degraded to fatal rows', () => {
    expect(ALLOWED_TRANSITIONS.idle).toEqual(new Set(['connecting']));
    expect(ALLOWED_TRANSITIONS.connecting).toEqual(
      new Set(['handshaking', 'reconnecting', 'fatal', 'idle']),
    );
    // handshaking -> fatal is reachable (the full permanent set, not just the five handshake codes), and
    // handshaking -> reconnecting fills the structural gap noted in state-machine.ts.
    expect(ALLOWED_TRANSITIONS.handshaking).toEqual(
      new Set(['live', 'resuming', 'fatal', 'reconnecting', 'idle']),
    );
    expect(ALLOWED_TRANSITIONS.live).toEqual(
      new Set(['degraded', 'reconnecting', 'fatal', 'idle']),
    );
    // degraded -> fatal covers a permanent close arriving while degraded.
    expect(ALLOWED_TRANSITIONS.degraded).toEqual(
      new Set(['live', 'reconnecting', 'fatal', 'idle']),
    );
    expect(ALLOWED_TRANSITIONS.reconnecting).toEqual(new Set(['connecting', 'fatal', 'idle']));
    expect(ALLOWED_TRANSITIONS.fatal).toEqual(new Set(['idle']));
  });
});

describe('ConnectionStateMachine', () => {
  it('starts at the given initial state', () => {
    const fsm = new ConnectionStateMachine('idle', () => {});
    expect(fsm.state).toBe('idle');
  });

  it('performs every legal transition and notifies with {from, to, reason}', () => {
    const events: Array<{ from: ConnectionState; to: ConnectionState; reason: string }> = [];
    const fsm = new ConnectionStateMachine('idle', (from, to, reason) =>
      events.push({ from, to, reason }),
    );

    fsm.transition('connecting', 'connect()');
    expect(fsm.state).toBe('connecting');
    fsm.transition('handshaking', 'ws_open');
    expect(fsm.state).toBe('handshaking');
    fsm.transition('live', 'welcome');
    expect(fsm.state).toBe('live');

    expect(events).toEqual([
      { from: 'idle', to: 'connecting', reason: 'connect()' },
      { from: 'connecting', to: 'handshaking', reason: 'ws_open' },
      { from: 'handshaking', to: 'live', reason: 'welcome' },
    ]);
  });

  it('rejects every illegal transition with InvalidConnectionTransition, for every (from, to) pair not in the table', () => {
    for (const from of ALL_STATES) {
      for (const to of ALL_STATES) {
        if (from === to) continue; // same-state is a no-op, not illegal
        if (ALLOWED_TRANSITIONS[from].has(to)) continue;
        const fsm = new ConnectionStateMachine(from, () => {});
        expect(() => fsm.transition(to, 'test'), `${from} -> ${to} should be illegal`).toThrow(
          InvalidConnectionTransition,
        );
      }
    }
  });

  it('accepts every legal transition, for every (from, to) pair in the table', () => {
    for (const from of ALL_STATES) {
      for (const to of ALLOWED_TRANSITIONS[from]) {
        const fsm = new ConnectionStateMachine(from, () => {});
        expect(() => fsm.transition(to, 'test'), `${from} -> ${to} should be legal`).not.toThrow();
        expect(fsm.state).toBe(to);
      }
    }
  });

  it('treats a same-state request as a silent no-op: no error, no notification', () => {
    let calls = 0;
    const fsm = new ConnectionStateMachine('live', () => {
      calls++;
    });
    expect(() => fsm.transition('live', 'noop')).not.toThrow();
    expect(calls).toBe(0);
    expect(fsm.state).toBe('live');
  });

  it('fatal can only go back to idle (via disconnect()), never directly to connecting', () => {
    const fsm = new ConnectionStateMachine('fatal', () => {});
    expect(() => fsm.transition('connecting', 'bad')).toThrow(InvalidConnectionTransition);
    expect(() => fsm.transition('idle', 'disconnect()')).not.toThrow();
  });
});
