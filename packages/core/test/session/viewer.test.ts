import { InvalidStateTransition } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_STREAM_ID,
  StreamIdSpaceExhaustedError,
  type Viewer,
  createViewer,
} from '../../src/session/viewer.js';

function makeViewer(): Viewer {
  return createViewer({
    id: 'vwr_1',
    sessionId: 'sess_1',
    tenantId: 'tnt_1',
    appId: 'app_1',
    subject: 'user@example.com',
    capabilities: ['view'],
    kind: 'human',
    isAdmin: false,
    connectedAtMs: 0,
  });
}

describe('Viewer state machine', () => {
  it('starts connecting and moves through the happy path', () => {
    const viewer = makeViewer();
    expect(viewer.state).toBe('connecting');
    expect(viewer.applyEvent('ticketValid', { ticketChecksPass: true })).toEqual({
      kind: 'ok',
      to: 'handshaking',
    });
    expect(viewer.state).toBe('handshaking');
    expect(viewer.applyEvent('helloReceived', { versionNegotiable: true })).toEqual({
      kind: 'ok',
      to: 'attached',
    });
    expect(viewer.state).toBe('attached');
  });

  it('illegal from a terminal state is ignored, not thrown', () => {
    const viewer = makeViewer();
    viewer.applyEvent('ticketInvalid');
    expect(viewer.state).toBe('expired');
    const outcome = viewer.applyEvent('subscribe', { limitsPass: true });
    expect(outcome.kind).toBe('ignored');
    expect(viewer.state).toBe('expired');
  });

  it('illegal from a live, non-terminal state throws InvalidStateTransition', () => {
    const viewer = makeViewer();
    viewer.applyEvent('ticketValid', { ticketChecksPass: true });
    viewer.applyEvent('helloReceived', { versionNegotiable: true });
    expect(viewer.state).toBe('attached');
    // A second `hello` (helloReceived again from `attached`) is not in the
    // transition table for `attached` and `attached` is not terminal.
    expect(() => viewer.applyEvent('helloReceived', { versionNegotiable: true })).toThrow(
      InvalidStateTransition,
    );
    expect(viewer.state).toBe('attached'); // unchanged: the throw happens before any mutation.
  });

  it('a guard failure is ignored, not thrown, and does not change state', () => {
    const viewer = makeViewer();
    const outcome = viewer.applyEvent('ticketValid', { ticketChecksPass: false });
    expect(outcome.kind).toBe('ignored');
    expect(viewer.state).toBe('connecting');
  });
});

describe('Viewer.allocateStreamId', () => {
  it('allocates a monotonic u16 id starting at 1, per viewer socket', () => {
    const viewer = makeViewer();
    expect(viewer.allocateStreamId()).toBe(1);
    expect(viewer.allocateStreamId()).toBe(2);
    expect(viewer.allocateStreamId()).toBe(3);
  });

  it('two viewers allocate independently, never sharing a counter', () => {
    const a = makeViewer();
    const b = createViewer({
      id: 'vwr_2',
      sessionId: 'sess_1',
      tenantId: 'tnt_1',
      appId: 'app_1',
      subject: 'x',
      capabilities: [],
      kind: 'human',
      isAdmin: false,
      connectedAtMs: 0,
    });
    a.allocateStreamId();
    a.allocateStreamId();
    expect(b.allocateStreamId()).toBe(1);
  });

  it('throws StreamIdSpaceExhaustedError at exhaustion rather than wrapping around', () => {
    const viewer = makeViewer();
    for (let i = 0; i < MAX_STREAM_ID; i += 1) {
      viewer.allocateStreamId();
    }
    expect(() => viewer.allocateStreamId()).toThrow(StreamIdSpaceExhaustedError);
  });
});

describe('Viewer.setCapabilities', () => {
  it('updates the granted capability set', () => {
    const viewer = makeViewer();
    expect(viewer.capabilities).toEqual(['view']);
    viewer.setCapabilities(['view', 'control']);
    expect(viewer.capabilities).toEqual(['view', 'control']);
  });
});
