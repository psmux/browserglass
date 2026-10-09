/**
 * `RemoteRuntime`-owned types: constructor options, plus the label key
 * `launch()` reads to select one operator-configured `RemoteEndpoint`
 * (a `LaunchRequest` carries no endpoint field of its own, so a label is
 * how it names which configured endpoint it targets).
 *
 * The label key's literal value now lives in `@browserglass/protocol`
 * (`REMOTE_ENDPOINT_LABEL_KEY`, `entities.ts`), not here: `router`'s
 * `LocalNode` is the only party trusted to set it (an app must never
 * supply one directly), and `router` depends only on `protocol`
 * (`scripts/check-deps.mjs`'s edge table has no `router -> runtime-remote`
 * edge), so the one shared literal has to live in the layer both packages
 * already depend on. Re-exported here under its original name so every
 * existing `runtime-remote` import site keeps working unchanged.
 */

import { REMOTE_ENDPOINT_LABEL_KEY, type RemoteEndpoint } from '@browserglass/protocol';
import type { MinimalFetch, RemoteWebSocketFactory } from './platform.js';

/**
 * The `LaunchRequest.labels` key naming which registered `RemoteEndpoint`
 * (by its `name`) a `launch()` call targets. Required: `runtime-remote`
 * cannot choose an endpoint on its own, and an app must never be able to
 * supply one directly, so the caller building the `LaunchRequest`
 * (`router`'s `LocalNode`) is the only party trusted to set it, from
 * `BrowserSpec.remoteEndpointName` (an operator's placement decision) plus
 * the operator's own endpoint registry.
 */
export const REMOTE_ENDPOINT_LABEL = REMOTE_ENDPOINT_LABEL_KEY;

/** Constructor options for {@link RemoteRuntime}. */
export interface RemoteRuntimeOptions {
  /** The operator-configured endpoint registry this runtime instance serves. Never sourced from an app request. */
  endpoints: readonly RemoteEndpoint[];
  fetchImpl?: MinimalFetch;
  wsFactory?: RemoteWebSocketFactory;
  /** Default 15000, matches `probeCdpIdentity`'s own default. */
  identityProbeTimeoutMs?: number;
}
