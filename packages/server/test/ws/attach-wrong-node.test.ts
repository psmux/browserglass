import { BglsError } from '@browserglass/protocol';
/**
 * A WS viewer connecting to a gateway that does not own the instance's
 * live CDP session used to get `bgls.error.instance.not_found`, exactly
 * the same wire error as an instance that genuinely does not exist
 * (`ws/connection.ts`'s `processHello` had one catch-all for every
 * `SessionRegistry.getOrCreate` failure). `session/factory.ts` now throws
 * a distinguishable `BglsError('E_INSTANCE_WRONG_NODE')` when
 * `BrowserRouter.driveInstance()` resolves `local: false` (see
 * `test/session/factory-wrong-node.test.ts` for that half in isolation);
 * this test proves `processHello` turns THAT specific shape into its own
 * wire code, `bgls.error.instance.wrong_node`, carrying `context.nodeId`
 * so a caller can tell "this instance is real, try a different gateway"
 * apart from "give up". There is no reachable address for that node on
 * the wire (see `factory.ts`'s comment on `Node.dataPlaneUrl` for why:
 * nothing in this build populates one), only the fact of which node owns
 * it.
 */
import { describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startTestGateway, waitOpen } from './support/test-gateway.js';

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

describe('WS attach to an instance owned by a different node', () => {
  it('replies bgls.error.instance.wrong_node with context.nodeId, then closes, instead of the generic instance.not_found', async () => {
    const gw = await startTestGateway({
      factoryError: () =>
        new BglsError(
          'E_INSTANCE_WRONG_NODE',
          'instance inst_x is driven by node nod_other, not this gateway',
          {
            context: { nodeId: 'nod_other' },
          },
        ),
    });
    try {
      const token = await gw.issueToken();
      const ws = gw.connect();
      await waitOpen(ws);

      const received: Record<string, unknown>[] = [];
      const done = new Promise<void>((resolve) => {
        ws.on('message', (raw) => {
          received.push(JSON.parse(raw.toString('utf8')));
        });
        ws.on('close', () => resolve());
      });

      ws.send(JSON.stringify({ ...hello(), auth: { scheme: 'bearer', token } }));
      await done;

      const errorMsg = received.find((m) => m['t'] === 'error');
      expect(errorMsg).toBeDefined();
      expect(errorMsg?.['code']).toBe('bgls.error.instance.wrong_node');
      expect(errorMsg?.['context']).toEqual({ nodeId: 'nod_other' });

      // Never the generic catch-all: that would tell a caller the
      // instance does not exist, when it does, just not here.
      expect(errorMsg?.['code']).not.toBe('bgls.error.instance.not_found');

      const goodbye = received.find((m) => m['t'] === 'goodbye');
      expect(
        goodbye,
        'the handshake still completes with a goodbye before the socket closes',
      ).toBeDefined();
    } finally {
      await gw.close();
    }
  });
});
