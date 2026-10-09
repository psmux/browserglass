/**
 * `RemoteRuntime`: `@browserglass/runtime-remote`'s `BrowserRuntime`
 * implementation. Attaches to an operator-configured CDP endpoint. Cheap:
 * no spawn, no supervision, no profile locks, no orphan scan.
 */

import type {
  AttachRequest,
  BrowserRuntime,
  BrowserSpec,
  ExitInfo,
  InstanceId,
  LaunchPhase,
  LaunchRequest,
  LaunchedBrowser,
  RemoteEndpoint,
  RuntimeCapabilities,
  RuntimeInventoryEntry,
  RuntimeProbe,
  RuntimeStats,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import { LaunchError } from '@browserglass/protocol';
import { REMOTE_CAPABILITIES } from './capabilities.js';
import { type CdpVersionInfo, RemoteCdpClient, RemoteCdpError } from './cdp-client.js';
import {
  CdpProbeTimeoutError,
  type ProbeCdpIdentityMode,
  probeCdpIdentity,
} from './cdp-identity.js';
import { UnsupportedEndpointTransportError, deriveHttpOrigin } from './endpoint-url.js';
import { type MinimalFetch, monotonicNow, wallNow } from './platform.js';
import { type SpecIgnoredIncident, applyResolvedSpec } from './spec-apply.js';
import { REMOTE_ENDPOINT_LABEL, type RemoteRuntimeOptions } from './types.js';

/**
 * What this runtime believes about the browser it last saw at one
 * endpoint, and therefore what the next identity probe there should
 * insist on. This replaced a boolean called `endedByUs`, which could only
 * express two of the four states an endpoint is actually in and answered
 * the wrong question for two of them.
 *
 * * `'still-there'`: we saw a browser at `lastKnownGuid` and have no
 *   evidence it has stopped being that browser. The next probe expects the
 *   SAME guid back (`'adopt'`), which is what makes an idempotent relaunch
 *   of a live instance, and a node-restart reattach, land on the browser
 *   they meant rather than whatever is answering the port now.
 * * `'gone'`: the browser at `lastKnownGuid` is over. Either we ended it
 *   ourselves with `Browser.close`, or its websocket dropped without our
 *   asking, which for a browser we never supervised is the only exit
 *   notice we ever get. Anything answering this endpoint from now on is a
 *   different browser, so the next probe demands a DIFFERENT guid
 *   (`'reused'`). This is the stale CDP race guard: an endpoint can keep
 *   answering `/json/version` for a second or two after the browser behind
 *   it has died, and adopting that answer means attaching to a corpse.
 * * `'released-to-its-owner'`: we detached. The browser was never ours,
 *   we asked nothing of it, and we stopped watching. By the time anyone
 *   looks again it may be the same browser still running, or it may be a
 *   restarted one at a new guid, and BOTH are normal: people quit and
 *   reopen Chrome. Insisting on either answer breaks the other, so the
 *   next probe insists on neither and takes whatever is stably there
 *   (`'fresh'`).
 */
type EndpointGuidExpectation = 'still-there' | 'gone' | 'released-to-its-owner';

/** Bookkeeping kept per registered endpoint (keyed by its resolved HTTP origin), independent of which `InstanceId` currently occupies it. */
interface EndpointBinding {
  /** The most recently observed `browserGuid` at this origin, or `null` if we have never successfully attached here. */
  lastKnownGuid: string | null;
  /** The `InstanceId` currently occupying this endpoint, or `null` when free (per `REMOTE_CAPABILITIES.maxConcurrentBrowsers === 1`). */
  boundInstanceId: InstanceId | null;
  /** What we believe about {@link EndpointBinding.lastKnownGuid}. See {@link EndpointGuidExpectation}. */
  expectation: EndpointGuidExpectation;
}

/** Bookkeeping kept per live `InstanceId`. */
interface InstanceRecord {
  handle: LaunchedBrowser;
  client: RemoteCdpClient;
  /** The resolved HTTP origin this instance is attached at, the {@link EndpointBinding} lookup key. */
  originKey: string;
  auth: RemoteEndpoint['auth'];
  unsubscribeClose: () => void;
  exitCallbacks: Set<(info: ExitInfo) => void>;
  torn: boolean;
  lastCpuSample: { atMonotonicMs: number; totalCpuTimeSec: number } | null;
  incidents: readonly SpecIgnoredIncident[];
}

function authHeaders(auth: RemoteEndpoint['auth']): Record<string, string> | undefined {
  if (!auth) {
    return undefined;
  }
  return auth.scheme === 'bearer'
    ? { Authorization: `Bearer ${auth.value}` }
    : { Authorization: `Basic ${auth.value}` };
}

/** Best-effort channel inference from a `/json/version` product/user-agent string; `REMOTE_CAPABILITIES.channels` is `[]` precisely because this is not authoritative. */
function inferChannel(product: string, userAgent: string): BrowserSpec['channel'] {
  const text = `${product} ${userAgent}`.toLowerCase();
  if (text.includes('edg/') || text.includes('edge')) return 'msedge';
  if (text.includes('brave')) return 'brave';
  if (text.includes('chromium')) return 'chromium';
  return 'chrome';
}

/** Best-effort headless inference from a `/json/version` user-agent string; not authoritative, see {@link inferChannel}. */
function inferHeadless(userAgent: string): BrowserSpec['headless'] {
  return userAgent.includes('HeadlessChrome') ? 'new' : 'off';
}

function toLaunchError(
  err: unknown,
  phase: LaunchPhase,
  extraContext: Readonly<Record<string, string | number>> = {},
): LaunchError {
  if (err instanceof CdpProbeTimeoutError) {
    return new LaunchError({
      code: 'E_CDP_TIMEOUT',
      phase,
      message: err.message,
      remediation:
        'confirm the remote endpoint is reachable and its CDP HTTP port answers /json/version',
      retryable: true,
      context: {
        attempts: err.attempts,
        lastHttpStatus: err.lastHttpStatus ?? -1,
        anyGuidSeen: String(err.anyGuidSeen),
        ...extraContext,
      },
      cause: err,
    });
  }
  if (err instanceof RemoteCdpError) {
    return new LaunchError({
      code: 'E_CDP_TIMEOUT',
      phase,
      message: err.message,
      remediation: 'confirm the remote endpoint is reachable and accepts CDP websocket connections',
      retryable: true,
      context: { cdpErrorCode: err.code, ...extraContext },
      cause: err,
    });
  }
  if (err instanceof UnsupportedEndpointTransportError) {
    return new LaunchError({
      code: 'E_SPEC_CONFLICT',
      phase,
      message: err.message,
      remediation:
        'configure this RemoteEndpoint with an http(s):// or ws(s):// url; unix:// is not reachable from runtime-remote',
      retryable: false,
      context: { url: err.url, ...extraContext },
      cause: err,
    });
  }
  // Every call site feeding this catch-all (`deriveHttpOrigin` on a
  // malformed URL, or a raw `RemoteCdpClient` call in `postLaunch` that
  // threw something other than a `RemoteCdpError`) is a failure to talk to
  // this endpoint's CDP surface, never a mismatch between the requested
  // spec and what this runtime supports: `RemoteRuntime` throws
  // `E_SPEC_CONFLICT` directly, by name, for its one genuine spec
  // conflict axis (a missing or unregistered endpoint name, above in this
  // file), and this is not that axis. Reporting an unclassified failure
  // here as `E_SPEC_CONFLICT`/`retryable: false` told a caller a permanent
  // configuration problem existed and to stop retrying, when in practice
  // this was reached for things a retry routinely fixes: a websocket that
  // dropped mid-handshake, a CDP command the browser answered slowly
  // enough to look unhandled, a transient DNS or TCP failure resolving
  // the endpoint's origin. Classified the same honest way the sibling
  // `RemoteCdpError` branch above is instead: a CDP reachability problem,
  // retryable.
  const message = err instanceof Error ? err.message : String(err);
  return new LaunchError({
    code: 'E_CDP_TIMEOUT',
    phase,
    message,
    remediation:
      'confirm the remote endpoint is reachable and its CDP HTTP/websocket surface answers as expected; see the underlying error message for detail',
    retryable: true,
    context: extraContext,
    cause: err,
  });
}

/**
 * Resolves one `browserGuid` expectation, in the same three-case shape
 * every runtime uses:
 *
 * * `'reused'` when the caller supplied `excludeBrowserGuid` directly (an
 *   explicit `AttachRequest.endpoint.excludeBrowserGuid`), or when this
 *   runtime's own bookkeeping says the browser it last saw here is over:
 *   whatever answers now must be a different one.
 * * `'adopt'` when this runtime remembers a browser at this origin that it
 *   has no reason to think has stopped (a same-instance idempotent
 *   relaunch, or an attach to a browser this runtime already confirmed
 *   once): expect the SAME guid back.
 * * `'fresh'` when this runtime knows nothing about this origin, and also
 *   after a detach, where knowing nothing is the honest position. See
 *   {@link EndpointGuidExpectation}'s `'released-to-its-owner'`: a browser
 *   we let go of may or may not still be the same browser by the time
 *   somebody asks for this endpoint again, and demanding either answer
 *   guarantees failure whenever the other one is true.
 */
function chooseProbeMode(
  excludeBrowserGuid: string | null | undefined,
  binding: { lastKnownGuid: string | null; expectation: EndpointGuidExpectation } | undefined,
): { mode: ProbeCdpIdentityMode; excludeBrowserGuid?: string; expectBrowserGuid?: string } {
  if (excludeBrowserGuid) {
    return { mode: 'reused', excludeBrowserGuid };
  }
  if (!binding?.lastKnownGuid) {
    return { mode: 'fresh' };
  }
  switch (binding.expectation) {
    case 'gone':
      return { mode: 'reused', excludeBrowserGuid: binding.lastKnownGuid };
    case 'still-there':
      return { mode: 'adopt', expectBrowserGuid: binding.lastKnownGuid };
    case 'released-to-its-owner':
      return { mode: 'fresh' };
  }
}

/**
 * `runtime-remote`'s `BrowserRuntime`. One instance serves the operator
 * configured `RemoteEndpoint` registry passed to its constructor;
 * `LaunchRequest.labels[REMOTE_ENDPOINT_LABEL]` selects which registered
 * endpoint one `launch()` call targets (see `types.ts`'s decision note).
 */
export class RemoteRuntime implements BrowserRuntime {
  readonly kind = 'remote' as const;

  private readonly endpointsByName = new Map<string, RemoteEndpoint>();
  private readonly byOrigin = new Map<string, EndpointBinding>();
  private readonly byInstance = new Map<InstanceId, InstanceRecord>();
  private readonly inFlightLaunch = new Map<InstanceId, Promise<LaunchedBrowser>>();
  private readonly inFlightAttach = new Map<InstanceId, Promise<LaunchedBrowser>>();
  private readonly fetchImpl: MinimalFetch | undefined;
  private readonly identityProbeTimeoutMs: number;

  constructor(private readonly options: RemoteRuntimeOptions) {
    for (const endpoint of options.endpoints) {
      if (this.endpointsByName.has(endpoint.name)) {
        throw new Error(`RemoteRuntime: duplicate RemoteEndpoint name "${endpoint.name}"`);
      }
      this.endpointsByName.set(endpoint.name, endpoint);
    }
    this.fetchImpl = options.fetchImpl;
    this.identityProbeTimeoutMs = options.identityProbeTimeoutMs ?? 15000;
  }

  capabilities(): RuntimeCapabilities {
    return REMOTE_CAPABILITIES;
  }

  async probe(): Promise<RuntimeProbe> {
    const checkedAt = wallNow();
    if (this.endpointsByName.size === 0) {
      return {
        ok: false,
        status: 'unavailable',
        detail: 'no RemoteEndpoint is configured for this runtime-remote instance',
        engine: null,
        remediation: 'register at least one RemoteEndpoint in operator config',
        checkedAt,
      };
    }
    let reachable = 0;
    let firstVersion: CdpVersionInfo | null = null;
    for (const endpoint of this.endpointsByName.values()) {
      try {
        const origin = deriveHttpOrigin(endpoint.url);
        const version = await this.fetchVersionQuick(origin, endpoint.auth);
        reachable += 1;
        firstVersion ??= version;
      } catch {
        // Counted below; an unreachable endpoint is not fatal to the runtime as a whole.
      }
    }
    const total = this.endpointsByName.size;
    if (reachable === 0) {
      return {
        ok: false,
        status: 'unavailable',
        detail: `none of ${total} configured endpoint(s) answered /json/version`,
        engine: null,
        remediation:
          'confirm the configured RemoteEndpoint URLs are correct and reachable from this node',
        checkedAt,
      };
    }
    return {
      ok: reachable === total,
      status: reachable === total ? 'ready' : 'degraded',
      detail: `${reachable}/${total} configured endpoint(s) answered /json/version`,
      engine: firstVersion
        ? {
            name: firstVersion.product || 'unknown',
            version: firstVersion.protocolVersion,
            path: null,
          }
        : null,
      remediation:
        reachable === total
          ? null
          : 'one or more configured RemoteEndpoint URLs did not answer; check operator config',
      checkedAt,
    };
  }

  async launch(req: LaunchRequest): Promise<LaunchedBrowser> {
    const already = this.byInstance.get(req.instanceId);
    if (already) {
      return already.handle;
    }
    const inFlight = this.inFlightLaunch.get(req.instanceId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.doLaunch(req);
    this.inFlightLaunch.set(req.instanceId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightLaunch.delete(req.instanceId);
    }
  }

  private async doLaunch(req: LaunchRequest): Promise<LaunchedBrowser> {
    const launchStart = monotonicNow();
    const phaseStarts: Partial<Record<LaunchPhase, number>> = { preflight: launchStart };

    const endpointName = req.labels[REMOTE_ENDPOINT_LABEL];
    // Named once and reused by both checks below: whichever one fails, the
    // operator fixing the config (or the placement decision that produced
    // `endpointName`) needs to see what this runtime actually has
    // registered, not just that the request did not match it.
    const registeredNames = [...this.endpointsByName.keys()];
    const registeredNamesText =
      registeredNames.length > 0 ? registeredNames.join(', ') : '(none registered)';
    if (!endpointName) {
      throw new LaunchError({
        code: 'E_SPEC_CONFLICT',
        phase: 'preflight',
        message: `LaunchRequest.labels is missing the "${REMOTE_ENDPOINT_LABEL}" key; runtime-remote cannot choose an endpoint on its own`,
        remediation: `set labels["${REMOTE_ENDPOINT_LABEL}"] to one of this runtime's registered RemoteEndpoint names: ${registeredNamesText}`,
        retryable: false,
        context: { instanceId: req.instanceId, registeredEndpoints: registeredNames.join(',') },
      });
    }
    const endpoint = this.endpointsByName.get(endpointName);
    if (!endpoint) {
      throw new LaunchError({
        code: 'E_SPEC_CONFLICT',
        phase: 'preflight',
        message: `no RemoteEndpoint named "${endpointName}" is registered with this runtime; registered endpoint name(s): ${registeredNamesText}`,
        remediation: `register a RemoteEndpoint named "${endpointName}" in operator config, or set labels["${REMOTE_ENDPOINT_LABEL}"] to one of: ${registeredNamesText}`,
        retryable: false,
        context: {
          instanceId: req.instanceId,
          endpointName,
          registeredEndpoints: registeredNames.join(','),
        },
      });
    }

    let originKey: string;
    try {
      originKey = deriveHttpOrigin(endpoint.url);
    } catch (err) {
      throw toLaunchError(err, 'preflight', { instanceId: req.instanceId, endpointName });
    }

    const existingBinding = this.byOrigin.get(originKey);
    if (
      existingBinding?.boundInstanceId &&
      existingBinding.boundInstanceId !== req.instanceId &&
      this.byInstance.has(existingBinding.boundInstanceId)
    ) {
      throw new LaunchError({
        code: 'E_PORT_EXHAUSTED',
        phase: 'preflight',
        message: `RemoteEndpoint "${endpointName}" already hosts instance ${existingBinding.boundInstanceId}; runtime-remote allows one concurrent browser per configured endpoint`,
        remediation:
          'wait for the current instance on this endpoint to release, or register a second RemoteEndpoint',
        retryable: true,
        context: {
          instanceId: req.instanceId,
          endpointName,
          occupiedBy: existingBinding.boundInstanceId,
        },
      });
    }

    phaseStarts.reconcile = monotonicNow();
    phaseStarts.spawn = monotonicNow(); // No spawn on this runtime; phase recorded as zero-width for a consistent breakdown.
    phaseStarts.cdpWait = monotonicNow();

    const probeOpts = chooseProbeMode(null, existingBinding);
    const overallTimeoutMs = Math.max(
      1000,
      Math.min(this.identityProbeTimeoutMs, req.deadlineAt - wallNow()),
    );
    let identity: Awaited<ReturnType<typeof probeCdpIdentity>>;
    try {
      identity = await probeCdpIdentity({
        cdpUrl: originKey,
        ...probeOpts,
        headers: authHeaders(endpoint.auth),
        overallTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      throw toLaunchError(err, 'cdpWait', { instanceId: req.instanceId, endpointName });
    }

    phaseStarts.postLaunch = monotonicNow();
    const client = new RemoteCdpClient({
      fetchImpl: this.fetchImpl,
      wsFactory: this.options.wsFactory,
    });
    try {
      await client.connect(identity.webSocketDebuggerUrl, authHeaders(endpoint.auth));
      const sessionId = await client.attachFirstPage();
      const applyResult = await applyResolvedSpec(client, req.spec, sessionId !== null);

      const endAt = monotonicNow();
      const launchPhases: Record<LaunchPhase, number> = {
        preflight: (phaseStarts.reconcile ?? endAt) - launchStart,
        reconcile: (phaseStarts.spawn ?? endAt) - (phaseStarts.reconcile ?? endAt),
        spawn: (phaseStarts.cdpWait ?? endAt) - (phaseStarts.spawn ?? endAt),
        cdpWait: (phaseStarts.postLaunch ?? endAt) - (phaseStarts.cdpWait ?? endAt),
        postLaunch: endAt - (phaseStarts.postLaunch ?? endAt),
      };

      const startedAt = wallNow();
      const record: InstanceRecord = {
        handle: undefined as unknown as LaunchedBrowser, // set below, after the closure needs to reference `record`
        client,
        originKey,
        auth: endpoint.auth,
        unsubscribeClose: () => undefined,
        exitCallbacks: new Set(),
        torn: false,
        lastCpuSample: null,
        incidents: applyResult.incidents,
      };

      const handle: LaunchedBrowser = {
        instanceId: req.instanceId,
        runtimeKind: 'remote',
        transport: {
          kind: 'http',
          cdpUrl: originKey,
          host: hostOf(originKey),
          port: portOf(originKey),
        },
        cdpWsUrl: identity.webSocketDebuggerUrl,
        browserGuid: identity.browserGuid,
        pid: null,
        containerId: null,
        podName: null,
        profilePath: '',
        containerProfilePath: null,
        engineVersion: readString(identity.raw, 'Browser'),
        protocolVersion: readString(identity.raw, 'Protocol-Version'),
        nativeUserAgent: readString(identity.raw, 'User-Agent'),
        launchDurationMs: endAt - launchStart,
        launchPhases,
        startedAt,
        adopted: false,
        teardown: (mode: TerminateMode) => this.doTerminate(req.instanceId, mode),
        onUnexpectedExit: (cb) => {
          record.exitCallbacks.add(cb);
          return () => record.exitCallbacks.delete(cb);
        },
      };
      record.handle = handle;
      record.unsubscribeClose = client.onClose((unexpected) => {
        if (unexpected && !record.torn) {
          this.handleUnexpectedClose(req.instanceId, record);
        }
      });

      this.byOrigin.set(originKey, {
        lastKnownGuid: identity.browserGuid,
        boundInstanceId: req.instanceId,
        expectation: 'still-there',
      });
      this.byInstance.set(req.instanceId, record);
      return handle;
    } catch (err) {
      client.close();
      throw toLaunchError(err, 'postLaunch', { instanceId: req.instanceId, endpointName });
    }
  }

  async attach(req: AttachRequest): Promise<LaunchedBrowser> {
    const already = this.byInstance.get(req.instanceId);
    if (already) {
      return already.handle;
    }
    const inFlight = this.inFlightAttach.get(req.instanceId);
    if (inFlight) {
      return inFlight;
    }
    const promise = this.doAttach(req);
    this.inFlightAttach.set(req.instanceId, promise);
    try {
      return await promise;
    } finally {
      this.inFlightAttach.delete(req.instanceId);
    }
  }

  private async doAttach(req: AttachRequest): Promise<LaunchedBrowser> {
    const start = monotonicNow();
    const url = req.endpoint?.url ?? req.recovered?.cdpUrl ?? null;
    if (!url) {
      throw new LaunchError({
        code: 'E_SPEC_CONFLICT',
        phase: 'preflight',
        message:
          'AttachRequest carries neither endpoint.url nor recovered.cdpUrl; runtime-remote has nothing to attach to',
        remediation: 'supply either endpoint or recovered with a reachable CDP URL',
        retryable: false,
        context: { instanceId: req.instanceId },
      });
    }
    let originKey: string;
    try {
      originKey = deriveHttpOrigin(url);
    } catch (err) {
      throw toLaunchError(err, 'preflight', { instanceId: req.instanceId });
    }

    const registryEntry = [...this.endpointsByName.values()].find((e) => {
      try {
        return deriveHttpOrigin(e.url) === originKey;
      } catch {
        return false;
      }
    });
    const auth = req.endpoint?.auth ?? registryEntry?.auth ?? null;

    const probeOpts = chooseProbeMode(
      req.endpoint?.excludeBrowserGuid ?? null,
      this.byOrigin.get(originKey),
    );
    const overallTimeoutMs = Math.max(
      1000,
      Math.min(this.identityProbeTimeoutMs, req.deadlineAt - wallNow()),
    );
    let identity: Awaited<ReturnType<typeof probeCdpIdentity>>;
    try {
      identity = await probeCdpIdentity({
        cdpUrl: originKey,
        ...probeOpts,
        headers: authHeaders(auth),
        overallTimeoutMs,
        fetchImpl: this.fetchImpl,
      });
    } catch (err) {
      throw toLaunchError(err, 'cdpWait', { instanceId: req.instanceId });
    }

    const client = new RemoteCdpClient({
      fetchImpl: this.fetchImpl,
      wsFactory: this.options.wsFactory,
    });
    try {
      await client.connect(identity.webSocketDebuggerUrl, authHeaders(auth));
      await client.attachFirstPage();

      const endAt = monotonicNow();
      const launchPhases: Record<LaunchPhase, number> = {
        preflight: 0,
        reconcile: 0,
        spawn: 0,
        cdpWait: endAt - start,
        postLaunch: 0,
      };
      const startedAt = req.recovered?.startedAt ?? wallNow();
      const record: InstanceRecord = {
        handle: undefined as unknown as LaunchedBrowser,
        client,
        originKey,
        auth,
        unsubscribeClose: () => undefined,
        exitCallbacks: new Set(),
        torn: false,
        lastCpuSample: null,
        incidents: [],
      };
      const handle: LaunchedBrowser = {
        instanceId: req.instanceId,
        runtimeKind: 'remote',
        transport: {
          kind: 'http',
          cdpUrl: originKey,
          host: hostOf(originKey),
          port: portOf(originKey),
        },
        cdpWsUrl: identity.webSocketDebuggerUrl,
        browserGuid: identity.browserGuid,
        pid: null,
        containerId: null,
        podName: null,
        profilePath: req.recovered?.profilePath ?? '',
        containerProfilePath: null,
        engineVersion: readString(identity.raw, 'Browser') || (req.recovered?.chromeVersion ?? ''),
        protocolVersion: readString(identity.raw, 'Protocol-Version'),
        nativeUserAgent: readString(identity.raw, 'User-Agent'),
        launchDurationMs: endAt - start,
        launchPhases,
        startedAt,
        adopted: true,
        teardown: (mode: TerminateMode) => this.doTerminate(req.instanceId, mode),
        onUnexpectedExit: (cb) => {
          record.exitCallbacks.add(cb);
          return () => record.exitCallbacks.delete(cb);
        },
      };
      record.handle = handle;
      record.unsubscribeClose = client.onClose((unexpected) => {
        if (unexpected && !record.torn) {
          this.handleUnexpectedClose(req.instanceId, record);
        }
      });

      this.byOrigin.set(originKey, {
        lastKnownGuid: identity.browserGuid,
        boundInstanceId: req.instanceId,
        expectation: 'still-there',
      });
      this.byInstance.set(req.instanceId, record);
      return handle;
    } catch (err) {
      client.close();
      throw toLaunchError(err, 'postLaunch', { instanceId: req.instanceId });
    }
  }

  async stats(handle: LaunchedBrowser): Promise<RuntimeStats> {
    const record = this.byInstance.get(handle.instanceId);
    const at = wallNow();
    const empty: RuntimeStats = {
      instanceId: handle.instanceId,
      at,
      cpuPercent: null,
      rssBytes: null,
      memoryLimitBytes: null,
      memoryPressure: null,
      processCount: null,
      openFds: null,
      diskWrittenBytes: null,
      oomKilledSince: false,
    };
    if (!record || record.torn) {
      return empty;
    }
    try {
      const result = (await record.client.sendBrowser('SystemInfo.getProcessInfo')) as {
        processInfo: Array<{ cpuTime: number }>;
      };
      const processCount = result.processInfo.length;
      const totalCpuTimeSec = result.processInfo.reduce(
        (sum, p) => sum + (typeof p.cpuTime === 'number' ? p.cpuTime : 0),
        0,
      );
      const nowMs = monotonicNow();
      let cpuPercent: number | null = null;
      if (record.lastCpuSample) {
        const deltaWallSec = (nowMs - record.lastCpuSample.atMonotonicMs) / 1000;
        const deltaCpuSec = totalCpuTimeSec - record.lastCpuSample.totalCpuTimeSec;
        if (deltaWallSec > 0) {
          cpuPercent = Math.max(0, (deltaCpuSec / deltaWallSec) * 100);
        }
      }
      record.lastCpuSample = { atMonotonicMs: nowMs, totalCpuTimeSec };
      return { ...empty, processCount, cpuPercent };
    } catch {
      return empty;
    }
  }

  async terminate(handle: LaunchedBrowser, mode: TerminateMode): Promise<TerminateResult> {
    return this.doTerminate(handle.instanceId, mode);
  }

  private async doTerminate(instanceId: InstanceId, mode: TerminateMode): Promise<TerminateResult> {
    const start = monotonicNow();
    const record = this.byInstance.get(instanceId);
    if (!record || record.torn) {
      return {
        mode,
        effective: mode,
        exitCode: null,
        signal: null,
        durationMs: 0,
        locksCleared: [],
        warnings: [record ? 'already terminated' : 'no such instance'],
      };
    }
    record.torn = true;
    const warnings: string[] = [];

    if (mode === 'detach') {
      warnings.push(
        'detach: runtime-remote never launched this browser, so nothing was asked of it; it is still running and still whoever owned it before BrowserGlass attached',
      );
    } else {
      if (mode !== 'clean') {
        warnings.push(
          `requested '${mode}'; runtime-remote can only attempt Browser.close ('clean'), gracefulTerminate is false`,
        );
      }
      try {
        await record.client.sendBrowser('Browser.close');
      } catch (err) {
        warnings.push(`Browser.close failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    // A detach leaves the endpoint in a state we know nothing certain
    // about; every other mode leaves it holding a browser we just ended.
    // See `EndpointGuidExpectation` for why those are not the same thing
    // and why neither of them is `'still-there'`.
    this.forgetInstance(instanceId, record, mode === 'detach' ? 'released-to-its-owner' : 'gone');

    return {
      mode,
      effective: mode === 'detach' ? 'detach' : 'clean',
      exitCode: null,
      signal: null,
      durationMs: monotonicNow() - start,
      locksCleared: [],
      warnings,
    };
  }

  /**
   * The remote browser's websocket closed and we did not ask it to, which
   * for a process this runtime never spawned is the only exit notice it
   * will ever get: there is no pid to watch, no exit code, and no signal.
   * In practice this is somebody quitting their own Chrome.
   *
   * Before this method existed the close handler fired the exit callbacks
   * and did nothing else. That left the dead instance in `byInstance` and
   * left its `EndpointBinding.boundInstanceId` pointing at it, and the
   * one concurrent slot `REMOTE_CAPABILITIES.maxConcurrentBrowsers` allows
   * per endpoint is guarded by exactly that pair, so every subsequent
   * `launch()` onto the endpoint failed `E_PORT_EXHAUSTED` naming an
   * instance whose browser had been gone for hours. The endpoint was
   * poisoned for the lifetime of the process, and the user restarts Chrome
   * routinely, so the whole runtime worked exactly once per gateway boot.
   *
   * The bookkeeping is dropped BEFORE the callbacks run, and `torn` is set
   * first. A listener on `onUnexpectedExit` is very likely to react by
   * releasing the instance, which comes back through `doTerminate`, and
   * `doTerminate` on a still-registered record would try to send
   * `Browser.close` down a socket that has already closed. Ordering it
   * this way makes that call the idempotent "already terminated" no-op it
   * should be.
   */
  private handleUnexpectedClose(instanceId: InstanceId, record: InstanceRecord): void {
    record.torn = true;
    this.forgetInstance(instanceId, record, 'gone');
    const exitInfo: ExitInfo = {
      at: wallNow(),
      code: null,
      signal: null,
      cause: 'external',
      lastStderr: null,
    };
    for (const cb of [...record.exitCallbacks]) cb(exitInfo);
  }

  /**
   * Drops one instance from this runtime's bookkeeping and records what
   * the endpoint it occupied should expect next. The single place either
   * of those two things happens, because doing one without the other is
   * what produced both halves of the endpoint poisoning bug: a freed
   * instance whose endpoint still reads occupied, or a freed endpoint
   * whose stored guid expectation still describes a browser that has
   * stopped being there.
   *
   * The binding itself is kept, never deleted: `lastKnownGuid` plus
   * `expectation` is exactly the evidence the next identity probe needs to
   * tell a browser that is still there from a different one that has taken
   * its place, and deleting the row would throw that away and send every
   * reconnect through `'fresh'`.
   */
  private forgetInstance(
    instanceId: InstanceId,
    record: InstanceRecord,
    expectation: EndpointGuidExpectation,
  ): void {
    record.unsubscribeClose();
    record.client.close();
    this.byInstance.delete(instanceId);
    const binding = this.byOrigin.get(record.originKey);
    if (binding && binding.boundInstanceId === instanceId) {
      binding.boundInstanceId = null;
      binding.expectation = expectation;
    }
  }

  async list(): Promise<readonly RuntimeInventoryEntry[]> {
    const entries: RuntimeInventoryEntry[] = [];
    for (const endpoint of this.endpointsByName.values()) {
      let originKey: string;
      try {
        originKey = deriveHttpOrigin(endpoint.url);
      } catch {
        continue;
      }
      const binding = this.byOrigin.get(originKey);
      if (!binding?.boundInstanceId) {
        continue;
      }
      const record = this.byInstance.get(binding.boundInstanceId);
      if (!record || record.torn) {
        continue;
      }
      let status: RuntimeInventoryEntry['status'] = 'unknown';
      try {
        const version = await this.fetchVersionQuick(originKey, endpoint.auth);
        status = version.browserGuid === binding.lastKnownGuid ? 'live' : 'unknown';
      } catch {
        status = 'unknown';
      }
      entries.push({
        instanceId: record.handle.instanceId,
        runtimeKind: 'remote',
        pid: null,
        containerId: null,
        podName: null,
        cdpUrl: record.handle.transport.kind === 'http' ? record.handle.transport.cdpUrl : '',
        browserGuid: record.handle.browserGuid,
        profilePath: record.handle.profilePath,
        profileFence: 0,
        startedAt: record.handle.startedAt,
        engineVersion: record.handle.engineVersion,
        channel: inferChannel(record.handle.engineVersion, record.handle.nativeUserAgent),
        headless: inferHeadless(record.handle.nativeUserAgent),
        labels: {},
        status,
      });
    }
    return entries;
  }

  async dispose(): Promise<void> {
    for (const record of [...this.byInstance.values()]) {
      record.unsubscribeClose();
      record.client.close();
    }
    this.byInstance.clear();
    this.byOrigin.clear();
  }

  /**
   * The `SpecIgnoredIncident`s recorded for one instance's `launch()` call.
   * Not part of `BrowserRuntime`: `Instance.incidents` (the durable home for
   * these, per `protocol`'s `domain/entities.ts`) is router-owned, and this
   * package has no store access. Router side wiring can read this to
   * append to `Instance.incidents`.
   */
  listIncidents(instanceId: InstanceId): readonly SpecIgnoredIncident[] {
    return this.byInstance.get(instanceId)?.incidents ?? [];
  }

  private async fetchVersionQuick(
    origin: string,
    auth: RemoteEndpoint['auth'],
  ): Promise<CdpVersionInfo> {
    const client = new RemoteCdpClient({ fetchImpl: this.fetchImpl, commandTimeoutMs: 3000 });
    return client.fetchVersion(origin, authHeaders(auth));
  }
}

function readString(raw: Readonly<Record<string, unknown>>, key: string): string {
  const v = raw[key];
  return typeof v === 'string' ? v : '';
}

function hostOf(httpOrigin: string): string {
  const withoutScheme = httpOrigin.slice(httpOrigin.indexOf('://') + 3);
  return withoutScheme.split(':')[0] ?? withoutScheme;
}

function portOf(httpOrigin: string): number {
  const withoutScheme = httpOrigin.slice(httpOrigin.indexOf('://') + 3);
  const parts = withoutScheme.split(':');
  const portStr = parts[1];
  if (portStr) {
    const n = Number.parseInt(portStr, 10);
    if (!Number.isNaN(n)) return n;
  }
  return httpOrigin.startsWith('https://') ? 443 : 80;
}
