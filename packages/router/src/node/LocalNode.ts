/**
 * `LocalNode`: the translation point between the router's
 * `nodes.launch(nodeId, {...})` payload (`protocol`'s `NodeLaunchRequest`)
 * and the runtime's `LaunchRequest` (`protocol`'s `LaunchRequest`, what a
 * `BrowserRuntime` receives). It receives the router's launch payload, asks
 * the profile service for the already leased profile's materialised directory,
 * builds a real `LaunchRequest`, and calls an injected `BrowserRuntime`.
 *
 * `runtime-host`'s `ProfileFs` implementation, and the runtime itself, are
 * both injected: this package must not import `core` or `runtime-host`,
 * and referencing `BrowserRuntime`'s *type* from `protocol` is
 * not the same as depending on the package that implements it.
 */

import { REMOTE_ENDPOINT_LABEL_KEY } from '@browserglass/protocol';
import type {
  AbortSignalLike,
  BrowserRuntime,
  InstanceId,
  LaunchRequest,
  LaunchedBrowser,
  NodeActionRequest,
  NodeActionResult,
  NodeLaunchRequest,
  RuntimeInventoryEntry,
  RuntimeKind,
  TerminateMode,
  TerminateResult,
} from '@browserglass/protocol';
import type { Clock } from '../router/clock.js';
import type { ProfileServicePort } from '../router/types.js';

/**
 * Builds `LaunchRequest.labels` from `req.spec`. Today this carries
 * exactly one thing: `BrowserSpec.remoteEndpointName`, forwarded under
 * `REMOTE_ENDPOINT_LABEL_KEY`, the one channel `runtime-remote`'s
 * `RemoteRuntime.launch` accepts for choosing which of its
 * operator-registered endpoints this launch targets (see that field's own
 * doc comment, `entities.ts`). Every other runtime kind ignores this key
 * entirely, so setting it costs nothing when the launch lands on a
 * `'host'`/`'docker'`/`'k8s'` node instead.
 *
 * Deliberately does NOT validate `remoteEndpointName` against a registry
 * of known endpoints: this node has no such registry to check it against
 * (only the injected `BrowserRuntime` does, and which concrete runtime is
 * injected here is exactly what this package must stay agnostic to). An
 * unknown name is `RemoteRuntime.launch`'s own
 * preflight to reject, with a message naming every endpoint it actually
 * has registered.
 */
function labelsFor(spec: NodeLaunchRequest['spec']): Readonly<Record<string, string>> {
  return spec.remoteEndpointName
    ? Object.freeze({ [REMOTE_ENDPOINT_LABEL_KEY]: spec.remoteEndpointName })
    : Object.freeze({});
}

/** An `AbortSignalLike` that never aborts, for the launch requests this build never cancels mid flight. */
const NEVER_ABORTED: AbortSignalLike = Object.freeze({ aborted: false });

/**
 * The runtime kinds whose browsers BrowserGlass did NOT create, and which
 * may therefore be asked for `TerminateMode`'s `'detach'`.
 *
 * Deliberately an allowlist rather than a denylist of the kinds that do
 * create their browsers. A fifth runtime kind added later is, until
 * somebody thinks about it and puts it here, treated as one that spawns
 * its own Chrome, so an unconsidered kind gets a real teardown instead of
 * a leaked process. The failure this guard exists to prevent is
 * asymmetric: refusing a legitimate detach costs one browser window
 * closing that did not have to, and honouring an illegitimate one leaks a
 * process, its profile lock, and the quota slot behind it, forever, with
 * nothing left holding a handle to it.
 *
 * `'remote'` is the one entry today. `runtime-remote` has no spawn path at
 * all: both `launch()` and `attach()` connect to a CDP endpoint an
 * operator registered, so every browser it hands back was already running
 * before BrowserGlass arrived and will still be somebody's, running, after
 * BrowserGlass leaves.
 */
const RUNTIME_KINDS_THAT_NEVER_CREATE_THE_BROWSER: readonly RuntimeKind[] = Object.freeze([
  'remote',
]);

/**
 * The seam a driving surface fills with real CDP execution for a
 * `NodeActionRequest` dispatched to THIS node. `LocalNode` holds no CDP
 * driving logic of its own: `InputDispatcher`/`CdpBridge` live in `core`,
 * and this package must never import `core`, so it cannot call
 * them directly the way `server/src/session/managed-session.ts` does.
 * Injected exactly like `BrowserRuntime`/`ProfileServicePort`: optional,
 * since most of this package's own tests exercise launch/terminate only
 * and never need to dispatch an action at all.
 */
export interface NodeActionExecutor {
  execute(req: NodeActionRequest): Promise<NodeActionResult>;
}

/** `LocalNode` construction options. */
export interface LocalNodeOptions {
  runtime: BrowserRuntime;
  profiles: ProfileServicePort;
  clock: Clock;
  /** See `NodeActionExecutor`'s own doc. Omitted in a build with no local action dispatch wired yet; `dispatch()` throws in that case rather than silently doing nothing. */
  actions?: NodeActionExecutor;
}

/**
 * The in process node agent for the embedded single node build. Holds the
 * `LaunchedBrowser` handle for every instance it has launched, since
 * `NodeTransport.terminate(nodeId, instanceId, mode)` carries only the
 * instance id, not the handle.
 */
export class LocalNode {
  private readonly handles = new Map<string, LaunchedBrowser>();

  /**
   * instanceIds this node has already torn down. `NodeTransport.terminate`
   * is called from more than one place in a single `bg.stop()` run:
   * `server/src/lifecycle/stop.ts`'s phase 5 calls it directly for every
   * live instance, and `BrowserRouter.stop()` (`router.stop()`, called
   * right after phase 5 in the same run) walks the store's own rows via
   * `drainNode`/`release()` and, since neither of those direct calls
   * transitions the instance's DB state itself, very likely finds the
   * same still-`ready` row and calls `terminate` again. Without this set,
   * the second call finds no handle (deleted by the first call, below)
   * and throws "no launched handle", which `BrowserRouter.release()` now
   * treats as a genuine terminate failure
   * and puts the instance back in `live` instead of `released`, even
   * though the browser really is dead. Tracking "already torn down"
   * separately from "never had a handle at all" (a real caller error,
   * still worth throwing on) is what makes the second call an idempotent
   * no-op instead.
   */
  private readonly terminated = new Set<string>();

  constructor(private readonly opts: LocalNodeOptions) {}

  /** Translates `req` into a `LaunchRequest` and calls `runtime.launch`. */
  async launch(req: NodeLaunchRequest): Promise<LaunchedBrowser> {
    const materialised = await this.opts.profiles.materialisedPathFor(req.profile.storedKey);
    const launchRequest: LaunchRequest = {
      instanceId: req.instanceId as InstanceId,
      spec: req.spec,
      profile: {
        profileId: null,
        path: materialised.path,
        containerPath: materialised.containerPath,
        mode: req.profile.mode,
        lease: { fence: req.profile.fence, expiresAt: this.opts.clock.now() + req.leaseMs },
      },
      deadlineAt: this.opts.clock.now() + req.spec.launchTimeoutMs,
      labels: labelsFor(req.spec),
      signal: NEVER_ABORTED,
    };
    const handle = await this.opts.runtime.launch(launchRequest);
    this.handles.set(req.instanceId, handle);
    return handle;
  }

  /** Adopts a browser this node did not launch (a restart reattach), via `runtime.attach`. */
  async attach(instanceId: string, handle: LaunchedBrowser): Promise<void> {
    this.handles.set(instanceId, handle);
  }

  /**
   * Terminates the browser this node launched for `instanceId`. Idempotent
   * against a second call for an instance this node already tore down
   * (see `terminated`'s own comment): returns a synthetic already-gone
   * result rather than calling `teardown` twice.
   *
   * For an instance this node holds no handle for and has not torn down
   * itself, the runtime's inventory decides (see `inventoryVerdictFor`):
   * a browser the runtime does not report running is treated as already
   * gone and reported as a clean termination, and a browser that IS still
   * running, which this node can no longer reach without a handle, still
   * throws.
   *
   * `gracePeriodMs`, when supplied, is threaded through via
   * {@link callTeardown} rather than the plain `handle.teardown(mode)`
   * this method used to call. See that
   * function's own comment for why this indirection exists: `teardown`'s
   * fixed two argument shape comes from `protocol/domain/runtime.ts`'s
   * `LaunchedBrowser` interface, which is deliberately left unwidened.
   *
   * `mode: 'detach'` is the one mode this method may refuse. See
   * {@link RUNTIME_KINDS_THAT_NEVER_CREATE_THE_BROWSER} for why the
   * decision lives here rather than with the caller, and
   * {@link refuseDetachFor} for what a refusal does instead.
   */
  async terminate(
    instanceId: string,
    mode: TerminateMode,
    gracePeriodMs?: number,
  ): Promise<TerminateResult> {
    if (mode === 'detach') {
      const refusal = this.refuseDetachFor(instanceId, gracePeriodMs);
      if (refusal) return refusal;
    } else {
      const refusal = this.refuseKillFor(instanceId, mode);
      if (refusal) return refusal;
    }
    const handle = this.handles.get(instanceId);
    if (!handle) {
      if (this.terminated.has(instanceId)) {
        return {
          mode,
          effective: mode,
          exitCode: null,
          signal: null,
          durationMs: 0,
          locksCleared: [],
          warnings: [`instance ${instanceId} was already terminated by this node`],
        };
      }
      // No handle, and not something this node tore down earlier in its
      // own lifetime. Before this check the method simply threw here, and
      // that had a real cost: `handles` is an in memory Map filled only
      // by `launch()` and `attach()`, so a gateway restart empties it for
      // every instance the store still remembers. The reaper then reaches
      // such a row every tick, `release()` catches this throw and reverts
      // the row from `draining` back to `live` with
      // `stateReason: 'terminate_failed'` (BrowserRouter's own terminate
      // catch, the single writer of that string), and the whole thing
      // repeats 30 seconds later, forever. Five of the seven `live` rows
      // in the demo store were stuck in exactly that loop, their
      // `status_since` advancing at exact 30 second intervals.
      //
      // The revert itself is right and stays: a terminate that failed
      // against a browser that IS still running must never leave the row
      // claiming `released` while Chrome keeps burning memory. What was missing is the ability to tell that case apart
      // from "the browser died with a previous process and only the row
      // outlived it". The runtime's own inventory is the authority on
      // that: `BrowserRuntime.list()` is built from durable state plus a
      // live scan (`runtime.ts`'s own doc), so it survives the restart that
      // wiped `handles`.
      const verdict = await this.inventoryVerdictFor(instanceId);
      if (verdict === 'not-running') {
        this.terminated.add(instanceId);
        return {
          mode,
          effective: mode,
          exitCode: null,
          signal: null,
          durationMs: 0,
          locksCleared: [],
          warnings: [
            `instance ${instanceId} has no handle on this node and the runtime does not report it running; treating as already terminated`,
          ],
        };
      }
      if (verdict === 'unreadable') {
        throw new Error(
          `LocalNode: no launched handle for instance ${instanceId}, and the runtime inventory could not be read to confirm whether it is still running`,
        );
      }
      throw new Error(
        `LocalNode: instance ${instanceId} is still running in this node's runtime inventory but this node holds no handle for it, so it cannot be terminated`,
      );
    }
    const result = await callTeardown(handle, mode, gracePeriodMs);
    this.handles.delete(instanceId);
    this.terminated.add(instanceId);
    return result;
  }

  /**
   * The detach ownership guard. Returns `null` when the runtime behind
   * this node never creates the browsers it hands back, meaning the
   * `'detach'` may proceed untouched; otherwise runs the teardown that
   * SHOULD have happened and returns its result, corrected so the caller
   * can see both what it asked for and what it got.
   *
   * The substitute mode is `'clean'`, not `'force'`. A caller reaching for
   * `'detach'` was asking for the gentlest possible ending, so when it
   * cannot have the gentlest one it gets the next gentlest that still
   * guarantees the process is gone: a CDP `Browser.close` first, so Chrome
   * flushes cookies and local storage, then the ordinary ladder.
   *
   * The returned `mode` stays `'detach'` while `effective` carries whatever
   * the ladder actually managed, which is the same "never escalate
   * silently" rule the runtime applies to the Windows `'graceful'` collapse,
   * applied to a downgrade rather than an escalation. A caller that reads
   * only `mode` learns nothing new and is not misled; a caller that reads
   * `effective` (`BrowserRouter.release` does) learns that the browser is
   * in fact dead and can report that instead of claiming it left one
   * running.
   */
  /**
   * The mirror image of {@link refuseDetachFor}, and the more important
   * half of the pair.
   *
   * `refuseDetachFor` stops this node LEAKING a browser it created.
   * This stops it KILLING one it did not. Both read the same
   * {@link RUNTIME_KINDS_THAT_NEVER_CREATE_THE_BROWSER} allowlist, so
   * there is one fact about ownership and two guards derived from it,
   * rather than two places that can come to disagree.
   *
   * Why the decision has to live here and not at the call site. Asking
   * callers to pass `ReleaseOptions.leaveBrowserRunning` makes safety
   * depend on every caller remembering, and the callers that matter most
   * CANNOT remember, because they do not know and could not know which
   * runtime backs the row they are sweeping. Every one of these is a real
   * call site in `BrowserRouter`, and every one passes `force: true`:
   *
   *   * capacity eviction (`:595`)
   *   * node draining (`:1652`)
   *   * TTL expiry (`:1779`)
   *   * max duration (`:1783`)
   *   * idle timeout (`:1792`)
   *
   * An idle timeout firing against a `runtime-remote` instance would send
   * `Browser.close` to a person's own signed in Chrome, unattended, with
   * no human in the loop to have forgotten anything. That is not a caller
   * discipline problem and no amount of required parameters fixes it: the
   * reaper has no opinion to express about somebody's browser, it just
   * knows a row went idle.
   *
   * So the flag stops being the safety mechanism and becomes what it
   * should always have been: an explicit statement of intent for the
   * case where a caller DOES know. Safety comes from ownership, which is
   * a property of the runtime and is known here.
   *
   * The asymmetry argument from the allowlist's own doc applies unchanged
   * and in the same direction: an unconsidered new runtime kind is not on
   * the list, so it is treated as one that spawns its own Chrome and
   * still gets a real teardown. This guard only ever fires for a kind
   * somebody has positively declared BrowserGlass did not create.
   */
  private refuseKillFor(instanceId: string, mode: TerminateMode): Promise<TerminateResult> | null {
    const kind = this.opts.runtime.capabilities().kind;
    if (!RUNTIME_KINDS_THAT_NEVER_CREATE_THE_BROWSER.includes(kind)) return null;
    const warning = `instance ${instanceId} runs on a '${kind}' runtime, which never created this browser: it was already running when BrowserGlass attached and belongs to whoever owned it then. '${mode}' would have closed somebody else's browser, so it was refused and a detach ran instead. Pass ReleaseOptions.leaveBrowserRunning to say so deliberately and avoid this warning.`;
    return this.terminate(instanceId, 'detach').then((result) => ({
      ...result,
      // `mode` echoes what was ASKED for and `effective` what happened,
      // which is the same split `refuseDetachFor` uses and the same one
      // `BrowserRouter.release` reads to decide whether it may report
      // `outcome: 'browser_detached'`. A caller that assumed the browser
      // is gone can therefore find out that it is not.
      mode,
      effective: 'detach' as const,
      warnings: [warning, ...result.warnings],
    }));
  }

  private refuseDetachFor(
    instanceId: string,
    gracePeriodMs: number | undefined,
  ): Promise<TerminateResult> | null {
    const kind = this.opts.runtime.capabilities().kind;
    if (RUNTIME_KINDS_THAT_NEVER_CREATE_THE_BROWSER.includes(kind)) return null;
    const warning = `instance ${instanceId} runs on a '${kind}' runtime, which launched this browser itself; 'detach' would leak the process, its profile lock, and its quota slot, so it was refused and a 'clean' teardown ran instead`;
    return this.terminate(instanceId, 'clean', gracePeriodMs).then((result) => ({
      ...result,
      mode: 'detach' as const,
      warnings: [warning, ...result.warnings],
    }));
  }

  /**
   * What the runtime's own inventory says about an instance this node
   * holds no handle for, `terminate()`'s only way to tell "already dead,
   * only the store row outlived it" from "still running, and now
   * unkillable from here".
   *
   * `'not-running'` is a positive conclusion and the only verdict that
   * lets `terminate()` report success: either the runtime does not list
   * the instance at all, or it lists it with `status: 'unknown'`, which is
   * what `runtime-host`'s `HostRuntime.list()` reports for a state file
   * entry whose pid is no longer alive (`pidAlive(e.pid) ? 'live' :
   * 'unknown'`). That second case is precisely the post restart shape this
   * whole check exists for: the durable state file remembers the browser,
   * the process itself is long gone.
   *
   * `'live'`, `'orphan'`, and `'foreign'` all mean a real browser is out
   * there, so they come back `'running'` and `terminate()` throws, which
   * is what keeps `BrowserRouter.release()` reverting the row to `live`
   * rather than marking a browser that is still burning memory as
   * `released`.
   *
   * A `list()` that throws is `'unreadable'`, never `'not-running'`: an
   * inventory this node could not read is not evidence of anything, and
   * guessing in the optimistic direction would leak exactly the process
   * this method is supposed to account for.
   */
  private async inventoryVerdictFor(
    instanceId: string,
  ): Promise<'not-running' | 'running' | 'unreadable'> {
    let inventory: readonly RuntimeInventoryEntry[];
    try {
      inventory = await this.opts.runtime.list();
    } catch {
      return 'unreadable';
    }
    const entry = inventory.find((e) => e.instanceId === instanceId);
    if (!entry) return 'not-running';
    return entry.status === 'unknown' ? 'not-running' : 'running';
  }

  /** This node's live inventory, from the runtime. */
  async list(): Promise<readonly RuntimeInventoryEntry[]> {
    return this.opts.runtime.list();
  }

  /**
   * Executes one `NodeActionRequest` against an instance this node holds,
   * via the injected `NodeActionExecutor` (see that interface's own doc
   * for why this node cannot run CDP commands itself). Throws a plain
   * `Error`, not a `RouterError`: a missing executor is a wiring mistake
   * in whatever process constructed this `LocalNode`, not a runtime
   * condition `BrowserRouter.dispatchAction`'s caller needs to branch on
   * the way it branches on "not found" vs "unreachable node".
   */
  async dispatch(req: NodeActionRequest): Promise<NodeActionResult> {
    if (!this.opts.actions) {
      throw new Error(
        `LocalNode: no NodeActionExecutor configured, cannot dispatch '${req.kind}' for instance ${req.instanceId}`,
      );
    }
    return this.opts.actions.execute(req);
  }

  /** The `LaunchedBrowser` handle for `instanceId`, if this node launched or adopted it. */
  handleFor(instanceId: string): LaunchedBrowser | null {
    return this.handles.get(instanceId) ?? null;
  }
}

/**
 * Calls `handle.teardown(mode)`, or, when `gracePeriodMs` is supplied and
 * the handle exposes the richer `teardownWithGrace` a runtime adapter may
 * optionally add, that instead. `LaunchedBrowser.teardown` in
 * `protocol/domain/runtime.ts` takes only `(mode)`; that interface is
 * deliberately left unwidened, so a runtime that wants to honour a
 * caller supplied grace period (`runtime-host`'s `HostRuntime` does, see
 * its own `buildHandle`) attaches `teardownWithGrace` onto the same handle
 * object as an extra property beyond what `LaunchedBrowser` requires, and
 * this function reaches it through a structural cast, the same technique
 * `core/src/cdp/platform.ts` and this package's own `nodeSocket.ts` use for
 * a capability their declared type does not name. A runtime kind that has
 * not added it (docker/k8s/remote, none of which implement this yet)
 * falls back to the plain `teardown(mode)` call and therefore to its own
 * static grace default: a caller supplied grace period this runtime
 * cannot honour is a degraded outcome, never a hard failure.
 */
function callTeardown(
  handle: LaunchedBrowser,
  mode: TerminateMode,
  gracePeriodMs: number | undefined,
): Promise<TerminateResult> {
  if (gracePeriodMs !== undefined) {
    const rich = handle as LaunchedBrowser & {
      teardownWithGrace?: (mode: TerminateMode, gracePeriodMs?: number) => Promise<TerminateResult>;
    };
    if (typeof rich.teardownWithGrace === 'function') {
      return rich.teardownWithGrace(mode, gracePeriodMs);
    }
  }
  return handle.teardown(mode);
}
