/**
 * `diagnostics.subscribe`/`diagnostics.status.get` end to end, over a real
 * socket, proving the two load bearing properties:
 *
 *  1. SURFACING (point 1): a caller can learn, per target, whether the
 *     `Runtime` domain is on right now (`fingerprintActive`), both as a
 *     field echoed back on `diagnostics.subscribed` and as a dedicated,
 *     side-effect-free query (`diagnostics.status.get`), and the quiet ->
 *     loud transition that field reports.
 *
 *  2. THE STEALTH GATE (point 2): once `ManagedSessionOptions.stealthActive`
 *     is true (this harness's stand-in for `BrowserSpec.stealth !== 'off'`,
 *     resolved for real by `session/factory.ts`), a `console`/`errors`
 *     request is refused with `bgls.error.diagnostics.stealth_conflict`
 *     unless the caller passes `acknowledgeStealthRisk: true`, while a
 *     `network`-only request is never gated at all, matching
 *     `TargetDiagnostics.applyFeeds`'s independent `Network` domain.
 */
import { describe, expect, it } from 'vitest';
import type WebSocket from 'ws';
import {
  type TestGateway,
  nextMessageSkipping,
  startTestGateway,
  waitOpen,
} from './support/test-gateway.js';

const UNSOLICITED = ['target.updated', 'presence.state', 'stream.stats'] as const;

function hello(): Record<string, unknown> {
  return {
    v: 1,
    t: 'hello',
    id: 'h1',
    ts: Date.now(),
    versions: [1],
    minVersion: 1,
    client: { name: 'test', version: '1.0', runtime: 'node' },
    capabilities: { codecs: ['jpeg'], binaryFrames: true, input: ['mouse', 'key'] },
    viewport: { width: 1440, height: 900, dpr: 1, visible: true, fitMode: 'contain' },
  };
}

const DEFAULT_CAPS = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'probe',
  'admin',
  'devtools',
];
const RAW_TARGET_ID = 'cdp-a';
const OPEN_SOCKETS: WebSocket[] = [];

async function connectViewer(
  gw: TestGateway,
  caps: string[],
): Promise<{ ws: WebSocket; targetId: string }> {
  const token = await gw.issueToken({ caps });
  const ws = gw.connect();
  OPEN_SOCKETS.push(ws);
  await waitOpen(ws);
  ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
  const welcome = await nextMessageSkipping(ws, UNSOLICITED);
  const targetId = (welcome['targets'] as Array<{ targetId: string }>)[0]!.targetId;
  return { ws, targetId };
}

async function withGateway(
  opts: { readonly stealthActive?: boolean },
  fn: (gw: TestGateway) => Promise<void>,
): Promise<void> {
  const gw = await startTestGateway({ stealthActive: opts.stealthActive });
  gw.addTarget({
    targetId: RAW_TARGET_ID,
    type: 'page',
    title: 'A',
    url: 'https://a.example',
    attached: false,
    windowId: 1,
  });
  OPEN_SOCKETS.length = 0;
  try {
    await fn(gw);
  } finally {
    for (const ws of OPEN_SOCKETS) ws.close();
    OPEN_SOCKETS.length = 0;
    await gw.close();
  }
}

/** Sends a request-shaped message and returns the correlated reply. */
async function request(
  ws: WebSocket,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const id = `r${Math.random().toString(36).slice(2)}`;
  ws.send(JSON.stringify({ v: 1, id, ts: Date.now(), ...payload }));
  for (;;) {
    const msg = await nextMessageSkipping(ws, UNSOLICITED);
    if (msg['re'] === id) return msg;
  }
}

describe('diagnostics: fingerprintActive surfacing (point 1)', () => {
  it('diagnostics.status.get reports quiet before anything subscribes, with no side effect', async () => {
    await withGateway({}, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const status = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(status['t']).toBe('diagnostics.status.got');
      expect(status['fingerprintActive']).toBe(false);
      // No side effect: asking the question did not itself turn Runtime on.
      const statusAgain = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(statusAgain['fingerprintActive']).toBe(false);
    });
  });

  it('the quiet -> loud transition: diagnostics.subscribe({ console: true }) flips fingerprintActive true, both on the subscribe reply and on a subsequent status.get', async () => {
    await withGateway({}, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);

      const before = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(before['fingerprintActive']).toBe(false);

      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
      });
      expect(sub['t']).toBe('diagnostics.subscribed');
      expect(sub['console']).toBe(true);
      expect(sub['fingerprintActive']).toBe(true);

      const after = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(after['fingerprintActive']).toBe(true);
    });
  });

  it('network-only subscribe never flips fingerprintActive: Network.enable does not touch Runtime', async () => {
    await withGateway({}, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: false,
        errors: false,
        network: true,
      });
      expect(sub['network']).toBe(true);
      expect(sub['fingerprintActive']).toBe(false);
    });
  });

  it('diagnostics.status.get is refused without devtools', async () => {
    await withGateway({}, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, ['view']);
      const reply = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(reply['t']).toBe('error');
      expect(reply['code']).toBe('bgls.error.cap.missing');
    });
  });
});

describe('diagnostics: the stealth gate (point 2)', () => {
  it('a non-stealth instance needs no acknowledgement at all', async () => {
    await withGateway({ stealthActive: false }, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
      });
      expect(sub['t']).toBe('diagnostics.subscribed');
      expect(sub['fingerprintActive']).toBe(true);
    });
  });

  it('a stealth-active instance refuses console/errors without acknowledgeStealthRisk, naming the conflict', async () => {
    await withGateway({ stealthActive: true }, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
      });
      expect(sub['t']).toBe('error');
      expect(sub['code']).toBe('bgls.error.diagnostics.stealth_conflict');
      expect(sub['category']).toBe('diagnostics');
      expect(sub['retryable']).toBe(false);

      // Refused, so the automation fingerprint must genuinely still be off,
      // not merely unreported: the whole point of refusing is that nothing
      // was silently turned on.
      const status = await request(ws, { t: 'diagnostics.status.get', targetId });
      expect(status['fingerprintActive']).toBe(false);
    });
  });

  it('the same request succeeds once acknowledgeStealthRisk: true is set, and the fingerprint is now honestly reported true', async () => {
    await withGateway({ stealthActive: true }, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
        acknowledgeStealthRisk: true,
      });
      expect(sub['t']).toBe('diagnostics.subscribed');
      expect(sub['console']).toBe(true);
      expect(sub['errors']).toBe(true);
      expect(sub['fingerprintActive']).toBe(true);
    });
  });

  it('a stealth-active instance never gates network-only diagnostics: no acknowledgement needed', async () => {
    await withGateway({ stealthActive: true }, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: false,
        errors: false,
        network: true,
      });
      expect(sub['t']).toBe('diagnostics.subscribed');
      expect(sub['network']).toBe(true);
      expect(sub['fingerprintActive']).toBe(false);
    });
  });

  it('defaults ({} body) are console+errors on: a stealth-active instance refuses the bare default the same way', async () => {
    await withGateway({ stealthActive: true }, async (gw) => {
      const { ws, targetId } = await connectViewer(gw, DEFAULT_CAPS);
      const sub = await request(ws, { t: 'diagnostics.subscribe', targetId });
      expect(sub['t']).toBe('error');
      expect(sub['code']).toBe('bgls.error.diagnostics.stealth_conflict');
    });
  });

  it("a second viewer on the same target must acknowledge independently: the first viewer's ack does not cover it", async () => {
    await withGateway({ stealthActive: true }, async (gw) => {
      const first = await connectViewer(gw, DEFAULT_CAPS);
      const second = await connectViewer(gw, DEFAULT_CAPS);
      const targetId = first.targetId;

      const firstSub = await request(first.ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
        acknowledgeStealthRisk: true,
      });
      expect(firstSub['t']).toBe('diagnostics.subscribed');
      // Runtime is genuinely on for the target now, from the first viewer's
      // own acknowledged subscription.
      const status = await request(first.ws, { t: 'diagnostics.status.get', targetId });
      expect(status['fingerprintActive']).toBe(true);

      // The second viewer still must acknowledge its OWN request, even
      // though Runtime already happens to be on.
      const secondSub = await request(second.ws, {
        t: 'diagnostics.subscribe',
        targetId,
        console: true,
        errors: true,
      });
      expect(secondSub['t']).toBe('error');
      expect(secondSub['code']).toBe('bgls.error.diagnostics.stealth_conflict');
    });
  });
});
