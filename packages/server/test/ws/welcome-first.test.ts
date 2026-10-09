import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Connection } from '../../src/ws/connection.js';

/** Just enough of a `ws` socket for `sendEnvelope()`: open, and recording every text frame. */
function fakeSocket() {
  const ws = Object.assign(new EventEmitter(), {
    OPEN: 1,
    readyState: 1,
    bufferedAmount: 0,
    sent: [] as string[],
    send(data: string) {
      ws.sent.push(data);
    },
    close() {},
    terminate() {},
  });
  return ws;
}

function connection() {
  const ws = fakeSocket();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  // biome-ignore lint/suspicious/noExplicitAny: only the socket and logger are touched before a hello arrives.
  const conn = new Connection(ws as any, { logger } as any, {} as any);
  const types = () => ws.sent.map((s) => (JSON.parse(s) as { t: string }).t);
  return { conn, types, ws };
}

describe('welcome is always the first envelope a viewer sees', () => {
  it('holds a broadcast that races the handshake until welcome has gone out', () => {
    const { conn, types } = connection();
    conn.sendEnvelope({ t: 'presence.state', viewers: [] });
    expect(types()).toEqual([]);
    conn.sendEnvelope({ t: 'welcome' });
    expect(types()).toEqual(['welcome', 'presence.state']);
    conn.sendEnvelope({ t: 'nav.state' });
    expect(types()).toEqual(['welcome', 'presence.state', 'nav.state']);
  });

  it('numbers welcome sq 1 even when something was held behind it', () => {
    const { conn, ws } = connection();
    conn.sendEnvelope({ t: 'presence.state', viewers: [] });
    conn.sendEnvelope({ t: 'welcome' });
    const sqs = ws.sent.map((s) => (JSON.parse(s) as { sq: number }).sq);
    expect(sqs).toEqual([1, 2]);
  });

  it('still sends an error or goodbye before welcome, since a refused handshake gets no welcome', () => {
    const { conn, types } = connection();
    conn.sendEnvelope({ t: 'error', code: 'bgls.error.auth.invalid_ticket' });
    conn.sendEnvelope({ t: 'goodbye' });
    expect(types()).toEqual(['error', 'goodbye']);
  });
});
