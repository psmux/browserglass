/**
 * `BrowserRouter.resolveNode`: a public, read only lookup of the durable
 * `Node` record for a node id, added while building `WebSocketNodeTransport`
 * so a peer endpoint resolver has one real path to
 * consult instead of each caller (this transport, a future cross node
 * viewer handoff) re-deriving its own. See the method's own comment for
 * why this is read only: nothing in this build populates `dataPlaneUrl`
 * via `store.registerNode` yet.
 */

import { newId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { createTestRouter } from '../support/createTestRouter.js';
import { createFakeClock } from '../support/fakeClock.js';

describe('BrowserRouter.resolveNode', () => {
  it('returns null for a node id nothing has registered', async () => {
    const clock = createFakeClock();
    const { router } = createTestRouter(clock);
    expect(await router.resolveNode(newId('nod'))).toBeNull();
  });

  it("returns the store's Node record, dataPlaneUrl included, once one is registered", async () => {
    const clock = createFakeClock();
    const { router, store } = createTestRouter(clock);
    const node = await store.registerNode({
      name: 'peer-1',
      runtime: 'host',
      address: 'wss://peer-1.internal:9443/node',
      registrationSecretEnc: 'unused-in-this-test',
    });

    const resolved = await router.resolveNode(node.id);
    expect(resolved?.id).toBe(node.id);
    expect(resolved?.dataPlaneUrl).toBe('wss://peer-1.internal:9443/node');
  });
});
