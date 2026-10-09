/**
 * Which `NodeTransport` `buildRouterWiring` actually constructs.
 *
 * The same shape of gap `profile-maintenance.test.ts` calls out for
 * `sweepFilesystem`: `WebSocketNodeTransport` was written, tested at the
 * component level, and never constructed by the production entrypoint, so
 * cross node dispatch was a capability with no path to it. A test of the
 * transport alone passes just as happily against a gateway that only ever
 * builds a `LocalNodeTransport`.
 *
 * The single node case matters at least as much as the cluster one here.
 * Nearly every deployment has no `peer.sharedSecret`, and it must keep
 * getting the plain in-process transport with no sockets, no dialling, and
 * no behaviour change whatsoever.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrowserRuntime, Store } from '@browserglass/protocol';
import { LocalNodeTransport, WebSocketNodeTransport } from '@browserglass/router';
import { createProfileFs } from '@browserglass/runtime-host';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../../src/config/resolve.js';
import { buildRouterWiring } from '../../src/lifecycle/wiring.js';

function baseConfigInput(extra?: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'bgls-wiring-'));
  return {
    mode: 'embedded' as const,
    store: {
      registerNode: async (n: { id?: string }) => ({ id: n.id ?? 'nod_fake' }),
    } as unknown as Store,
    runtime: { list: async () => [] } as unknown as BrowserRuntime,
    profiles: { dir: root, fs: createProfileFs({ root }) },
    ...extra,
  };
}

async function wiringWith(extra?: Record<string, unknown>) {
  const config = resolveConfig(baseConfigInput(extra));
  const wiring = await buildRouterWiring(config);
  return {
    wiring,
    dispose: () => {
      wiring.profileMaintenance?.cancel();
      wiring.orphanSweep?.cancel();
      wiring.profileService.stopLeaseRenewal();
    },
  };
}

describe('buildRouterWiring: which NodeTransport it constructs', () => {
  it('builds a plain LocalNodeTransport when no peer secret is configured, which is nearly every deployment', async () => {
    const { wiring, dispose } = await wiringWith();
    try {
      expect(wiring.nodeTransport).toBeInstanceOf(LocalNodeTransport);
      // Stated as a negative too: a single node gateway must not be
      // holding something that can open sockets to other processes.
      expect(wiring.nodeTransport).not.toBeInstanceOf(WebSocketNodeTransport);
    } finally {
      dispose();
    }
  });

  it('builds a WebSocketNodeTransport once a peer shared secret is configured', async () => {
    const { wiring, dispose } = await wiringWith({
      peer: { sharedSecret: 'a-shared-secret-for-this-cluster' },
    });
    try {
      // The one line that turned cross node dispatch from a component that
      // existed into a component that runs.
      expect(wiring.nodeTransport).toBeInstanceOf(WebSocketNodeTransport);
    } finally {
      dispose();
    }
  });

  it('treats an empty shared secret as no secret, rather than arming a cluster on a blank string', async () => {
    // An unset environment variable read into config arrives as '' far more
    // often than it arrives absent, and a gateway that thinks it is
    // clustered because of a blank string would dial peers it cannot
    // authenticate to.
    const { wiring, dispose } = await wiringWith({ peer: { sharedSecret: '' } });
    try {
      expect(wiring.nodeTransport).toBeInstanceOf(LocalNodeTransport);
    } finally {
      dispose();
    }
  });
});
