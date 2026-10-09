import { render } from '@testing-library/react';
import { StrictMode } from 'react';
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
 * A StrictMode double mount produces one socket, one subscription, and no
 * `ticket_consumed` error surfacing to the app. Drives React 18's real StrictMode double-invoke behaviour
 * (`<StrictMode>` mount, effect cleanup, effect re-run) through an actual
 * `render()`, not a unit test of the ref logic in isolation. Uses real
 * timers throughout (see `support/fixtures.ts`'s `flushAsync`/`realDelay`
 * doc comments for why fake timers are avoided here).
 */
describe('<BrowserGlass/> under StrictMode', () => {
  it('opens exactly one socket, sends exactly one stream.subscribe, and surfaces no error', async () => {
    const harness = createFakeWebSocketHarness();
    const errors: Array<{ code: string; message: string }> = [];

    render(
      <StrictMode>
        <BrowserGlass
          url="wss://example.test/browserglass/socket"
          ticket="tkt_initial"
          onError={(e) => errors.push(e)}
          transport={{ WebSocketImpl: harness.Impl }}
        />
      </StrictMode>,
    );

    // Flush the microtask hop `connect()` takes before constructing a
    // socket (credential resolution), for both the first mount's connect
    // call and (if the StrictMode defence failed) a phantom second one.
    await flushAsync();

    expect(harness.instances.length).toBe(1);

    const ws = completeHandshake(harness);
    await flushAsync();

    const subscribeCalls = ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe');
    expect(subscribeCalls.length).toBe(1);

    answerLatestSubscribe(ws);
    await flushAsync();

    // The StrictMode second mount's teardown-cancellation defence means no
    // destroy() ever ran on the first mount's client, so there is still
    // exactly one socket and no reconnect/re-subscribe happened.
    expect(harness.instances.length).toBe(1);
    expect(ws.sentJsonMessages().filter((m) => m.t === 'stream.subscribe').length).toBe(1);
    expect(errors.some((e) => e.code === 'bgls.error.auth.ticket_consumed')).toBe(false);
    expect(errors).toEqual([]);
  });

  it('a real unmount does destroy the client on the 100ms teardown timer', async () => {
    const harness = createFakeWebSocketHarness();

    const { unmount } = render(
      <StrictMode>
        <BrowserGlass
          url="wss://example.test/browserglass/socket"
          ticket="tkt_initial"
          transport={{ WebSocketImpl: harness.Impl }}
        />
      </StrictMode>,
    );
    await flushAsync();
    const ws = completeHandshake(harness);
    await flushAsync();

    unmount();
    // Before the 100ms teardown window elapses, the socket must still be
    // open (a real unmount schedules destroy(), it does not destroy
    // synchronously).
    expect(ws.closeCalls.length).toBe(0);

    await realDelay(200);
    expect(ws.closeCalls.length).toBe(1);
  });
});
