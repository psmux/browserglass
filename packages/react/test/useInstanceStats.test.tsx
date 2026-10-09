import { BrowserGlassClient } from '@browserglass/client';
import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useInstanceStats } from '../src/useInstanceStats.js';
import { createFakeWebSocketHarness } from './support/fake-websocket.js';
import { answerLatestSubscribe, completeHandshake, nextSq } from './support/fixtures.js';

interface RenderCounter {
  count: number;
}

function Probe({ client, counter }: { client: BrowserGlassClient; counter: RenderCounter }) {
  counter.count += 1;
  const stats = useInstanceStats(client, { intervalMs: 1000 });
  return <div data-testid="fps">{stats.fps}</div>;
}

/**
 * useInstanceStats at 60fps causes at most one parent render per second,
 * asserted by counting renders (re-rendering on every frame froze a chat
 * input while typing in an earlier design).
 */
describe('useInstanceStats render rate', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders at most once per polling second, not once per stats message', async () => {
    const harness = createFakeWebSocketHarness();
    const client = new BrowserGlassClient({
      url: 'wss://example.test/browserglass/socket',
      ticket: 'tkt_1',
      transport: { WebSocketImpl: harness.Impl },
    });

    const connectPromise = client.connect();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    const ws = completeHandshake(harness);
    await connectPromise;

    const subscribePromise = client.subscribe('tgt_00000000000000000000000001');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    answerLatestSubscribe(ws);
    await subscribePromise;

    const counter: RenderCounter = { count: 0 };
    render(<Probe client={client} counter={counter} />);
    const initialCount = counter.count;

    // Three simulated seconds, each carrying a burst of 20 distinct
    // stats messages (a stand-in for a 20 to 60Hz underlying stream):
    // every value changes on every message, so if this hook re-rendered
    // its caller per message rather than per poll tick, this alone would
    // produce 60 renders.
    for (let second = 0; second < 3; second++) {
      for (let i = 0; i < 20; i++) {
        ws.simulateJson({
          v: 1,
          t: 'stream.stats',
          ts: Date.now(),
          sq: nextSq(ws),
          streamId: 1,
          fpsSent: second * 20 + i,
          fpsDropped: 0,
          bytesPerSec: 1000 + second * 20 + i,
          avgFrameBytes: 100,
          backlog: 0,
          bufferedBytes: 0,
          encodeMsP50: 1,
          encodeMsP95: 2,
          rttMs: 5,
          quality: 'auto',
          codec: 'jpeg',
        });
      }
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1000);
      });
    }

    const renders = counter.count - initialCount;
    // At most one render per elapsed second (3), plus one slack tick for
    // boundary timing; nowhere near the 60 a per-message re-render would
    // have produced.
    expect(renders).toBeLessThanOrEqual(4);

    client.destroy();
  });
});
