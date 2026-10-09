/** Assembles a fully wired `BrowserRouter` against every fake in this directory, for router level integration tests. */

import { newId } from '@browserglass/protocol';
import type { Store } from '@browserglass/protocol';
import { NodeRegistry } from '../../src/node/NodeRegistry.js';
import { NULL_PLACEMENT_SIGNALS, ScoredPlacementPolicy } from '../../src/placement/policy.js';
import { BrowserRouter, type BrowserRouterOptions } from '../../src/router/BrowserRouter.js';
import type { RouterConfig } from '../../src/router/config.js';
import { DEFAULT_ROUTER_CONFIG } from '../../src/router/config.js';
import type { RouterLogger } from '../../src/router/logger.js';
import type { AttachCredentialIssuer, LiveViewerPort } from '../../src/router/types.js';
import type { FakeClock } from './fakeClock.js';
import { createFakeQuotaProvider, createRecordingAuditSink, noopMetricsSink } from './fakeMisc.js';
import { type FakeNodeTransport, createFakeNodeTransport } from './fakeNodeTransport.js';
import { type FakeProfileService, createFakeProfileService } from './fakeProfileService.js';
import { createMockStore } from './mockStore.js';

export interface TestRouter {
  router: BrowserRouter;
  store: ReturnType<typeof createMockStore>;
  nodes: FakeNodeTransport;
  profiles: FakeProfileService;
  audit: ReturnType<typeof createRecordingAuditSink>;
  nodeRegistry: NodeRegistry;
}

/** Builds a `BrowserRouter` wired to in memory fakes, driven by `clock`. */
export function createTestRouter(
  clock: FakeClock,
  opts?: {
    config?: Partial<RouterConfig>;
    store?: Store;
    viewers?: LiveViewerPort;
    logger?: RouterLogger;
    attachCredentials?: AttachCredentialIssuer;
    reachesPeerNodes?: boolean;
  },
): TestRouter {
  const store = (opts?.store as ReturnType<typeof createMockStore>) ?? createMockStore(clock);
  const nodes = createFakeNodeTransport();
  const profiles = createFakeProfileService();
  const audit = createRecordingAuditSink();
  const nodeRegistry = new NodeRegistry(clock, {
    nodeId: newId('nod'),
    capacity: {
      maxInstances: 100,
      maxMemoryMb: 64_000,
      cpuCores: 8,
      profileDiskMb: 1_000_000,
      maxConcurrentLaunches: 8,
    },
  });
  nodeRegistry.markReady();
  const placement = new ScoredPlacementPolicy(
    DEFAULT_ROUTER_CONFIG.placementWeights,
    DEFAULT_ROUTER_CONFIG.targetUtilisation,
    DEFAULT_ROUTER_CONFIG.scoreFloor,
    NULL_PLACEMENT_SIGNALS,
  );

  const options: BrowserRouterOptions = {
    store,
    nodes,
    nodeRegistry,
    placement,
    profiles,
    quotas: createFakeQuotaProvider(),
    audit,
    metrics: noopMetricsSink,
    clock,
    ...(opts?.config ? { config: opts.config } : {}),
    ...(opts?.viewers ? { viewers: opts.viewers } : {}),
    ...(opts?.logger ? { logger: opts.logger } : {}),
    ...(opts?.attachCredentials ? { attachCredentials: opts.attachCredentials } : {}),
    ...(opts?.reachesPeerNodes !== undefined ? { reachesPeerNodes: opts.reachesPeerNodes } : {}),
  };
  const router = new BrowserRouter(options);
  return { router, store, nodes, profiles, audit, nodeRegistry };
}
