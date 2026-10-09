import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrowserGlass } from '../src/BrowserGlass.js';
import { createFakeWebSocketHarness } from './support/fake-websocket.js';
import { answerLatestSubscribe, completeHandshake, flushAsync } from './support/fixtures.js';

/**
 * Wheel over the canvas does not scroll the host page. Proven here by asserting `event.defaultPrevented` on a real
 * dispatched `wheel` event, which is only possible because the listener
 * was attached imperatively with `{passive:false}` (`@browserglass/client`'s
 * `InputCapture`, constructed inside `<BrowserGlass/>`'s layout effect): `<BrowserGlass/>` never has a JSX `onWheel`
 * prop at all, so there is no passive-listener path that could have
 * produced this result.
 */
describe('<BrowserGlass/> wheel handling', () => {
  it('preventDefaults a wheel event dispatched on the canvas once interactive input capture is attached', async () => {
    const harness = createFakeWebSocketHarness();
    const { container } = render(
      <BrowserGlass
        url="wss://example.test/browserglass/socket"
        ticket="tkt_initial"
        transport={{ WebSocketImpl: harness.Impl }}
      />,
    );

    await flushAsync();
    const ws = completeHandshake(harness);
    await flushAsync();
    answerLatestSubscribe(ws);
    await flushAsync();

    const canvas = container.querySelector('[data-bgls-part="browserglass-canvas"]');
    expect(canvas).toBeTruthy();

    const event = new WheelEvent('wheel', { deltaY: 100, cancelable: true, bubbles: true });
    canvas?.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
  });
});
