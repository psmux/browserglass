import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrowserGlass } from '../src/BrowserGlass.js';
import { createFakeWebSocketHarness } from './support/fake-websocket.js';
import {
  answerLatestSubscribe,
  completeHandshake,
  flushAsync,
  realDelay,
} from './support/fixtures.js';

/**
 * Unmount emits control.release before the close (the cleanup order:
 * release any held lease explicitly, before the client this component owns is destroyed, which
 * is what sends the socket's own close frame).
 */
describe('<BrowserGlass/> unmount ordering', () => {
  it('sends control.release strictly before the socket close frame', async () => {
    const harness = createFakeWebSocketHarness();
    const { unmount } = render(
      <BrowserGlass
        url="wss://example.test/browserglass/socket"
        ticket="tkt_initial"
        autoControl="onMount"
        transport={{ WebSocketImpl: harness.Impl }}
      />,
    );

    await flushAsync();
    const ws = completeHandshake(harness);
    await flushAsync();
    answerLatestSubscribe(ws);
    await flushAsync();

    // autoControl="onMount" requested control as soon as input capture
    // attached; answer it so this component holds a real lease to release.
    const controlRequest = ws.sentJsonMessages().find((m) => m.t === 'control.request');
    expect(controlRequest).toBeTruthy();
    ws.simulateJson({
      v: 1,
      t: 'control.granted',
      re: controlRequest?.id as string,
      ts: Date.now(),
      targetId: controlRequest?.targetId as string,
      leaseId: 'lse_00000000000000000000000001',
      expiresAt: Date.now() + 60000,
      renewWithinMs: 5000,
      idleReleaseMs: 60000,
      mode: 'exclusive',
    });
    await flushAsync();

    // Record ordering of every send() and the close() call on the raw
    // socket, so "before the close" is asserted on actual call order
    // rather than inferred from a lack of a thrown "socket not open" error.
    const log: string[] = [];
    const originalSend = ws.send.bind(ws);
    const originalClose = ws.close.bind(ws);
    ws.send = (data) => {
      const parsed = typeof data === 'string' ? (JSON.parse(data) as { t?: string }) : null;
      if (parsed?.t) log.push(`send:${parsed.t}`);
      return originalSend(data);
    };
    ws.close = (code?: number, reason?: string) => {
      log.push('close');
      return originalClose(code, reason);
    };

    unmount();
    await realDelay(200);

    const releaseIndex = log.indexOf('send:control.release');
    const closeIndex = log.indexOf('close');
    expect(releaseIndex).toBeGreaterThanOrEqual(0);
    expect(closeIndex).toBeGreaterThanOrEqual(0);
    expect(releaseIndex).toBeLessThan(closeIndex);
  });
});
