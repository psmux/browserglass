/**
 * `RestSessionDriver`/`RestCdpSender` (`packages/server/src/rest/types.ts`),
 * built over this process's live `SessionRegistry`. This is the wiring
 * `rest/routes/targets.ts`'s own module doc names as missing: every route
 * there resolves an instance through `BrowserRouter.driveInstance` (the
 * authority gate) into a `DrivingContext`, then hands it straight to
 * `ctx.driver`/`ctx.cdp`; this module is what makes those two objects
 * exist.
 *
 * `DrivingContext.resolution.local` decides everything below:
 *
 * - `local: true` means this process's own node launched the instance, so
 *   `SessionRegistry` (keyed by `instanceId`, see `ws/connection.ts`'s
 *   `getOrCreate(outcome.instanceId, ...)`) may already hold a live
 *   `ManagedSession` for it. `ManagedSession.sessionId` is the field that
 *   actually carries `Instance.sessionId` (`session/factory.ts` sets it
 *   from `view.instance.sessionId`), so `findLocalManaged` scans
 *   `registry.all()` for it, exactly the way `session-api.ts`'s own
 *   (unexported) `findManaged` already does for `SessionApi` (`bg.sessions`):
 *   a second, independent copy rather than an export from that module,
 *   since the two callers want different failure shapes: `SessionApi`
 *   throws its own `SessionApiError` for an in-process caller, this throws
 *   a `RestError` an HTTP response can carry directly. No live entry here
 *   (for example right after a gateway restart, before any viewer has
 *   reconnected and rebuilt one) is a real, honest 409, not a bug: the
 *   store/router say the session exists, this process just has not built
 *   its local half of it yet.
 * - `local: false` means a different node launched it. This used to be exactly the same 409 `findManaged`
 *   throws for "no live ManagedSession here", conflating "not live
 *   anywhere" with "not live in THIS process" and refusing a perfectly
 *   healthy instance. `forwardAction` now calls
 *   `BrowserRouter.dispatchAction`, which resolves the owning node again
 *   (a cache hit, since `routes/targets.ts` just resolved the same
 *   instance) and forwards through `NodeTransport.dispatch`.
 */

import type {
  NodeActionRequest,
  NodeActionResult,
  NodeActionTarget,
  TargetSummary,
} from '@browserglass/protocol';
import type { BrowserRouter } from '@browserglass/router';
import type { UploadStore } from '../files/upload-store.js';
import { RestError } from '../rest/errors.js';
import type { DrivingContext, RestCdpSender, RestSessionDriver } from '../rest/types.js';
import { compact } from '../util/compact.js';
import type { ManagedSession } from './managed-session.js';
import type { SessionRegistry } from './registry.js';

/** The honest 409 for "the store/router say this session is live, but this process holds no `ManagedSession` for it". Never thrown for a non local `drive`: that case forwards instead (see this file's own module doc). */
function sessionNotLive(sessionId: string): RestError {
  return new RestError(
    409,
    'E_SESSION_NOT_LIVE',
    `Session "${sessionId}" has no live ManagedSession on this gateway.`,
    { retryAfterMs: 1000 },
  );
}

function findLocalManaged(registry: SessionRegistry, sessionId: string): ManagedSession | null {
  return registry.all().find((m) => m.sessionId === sessionId) ?? null;
}

/**
 * Forwards `req` to `drive.resolution`'s owning node through
 * `BrowserRouter.dispatchAction`, the only path a non local instance can
 * be driven through in this build (there is no direct `NodeTransport`
 * handle on `RestContext`, by design: the router is the thing that is
 * allowed to know about other nodes). Two distinct failure shapes, both
 * already carrying the right HTTP status by the time they reach here:
 * `getRouter()` returning `undefined` is `E_ROUTER_UNAVAILABLE` (503,
 * matching every other "not wired" dependency in this package); the
 * owning node itself being unreachable is `E_NODE_LOST` (503, retryable),
 * thrown by `dispatchAction` itself and passed through unchanged, not
 * flattened into the same "no live ManagedSession" 409 a local miss gets.
 */
async function forwardAction(
  getRouter: () => BrowserRouter | undefined,
  drive: DrivingContext,
  req: NodeActionRequest,
): Promise<NodeActionResult> {
  const router = getRouter();
  if (router === undefined) {
    throw new RestError(
      503,
      'E_ROUTER_UNAVAILABLE',
      'This gateway has no local router (mode is "gateway" without a control plane connection).',
    );
  }
  try {
    return await router.dispatchAction(drive.resolution.instanceId, req, drive.principal);
  } catch (err) {
    if (err !== null && typeof err === 'object' && 'httpStatus' in err && 'code' in err) {
      const e = err as { httpStatus: number; code: string; message: string; retryAfterMs?: number };
      throw new RestError(
        e.httpStatus,
        e.code,
        e.message,
        compact({ retryAfterMs: e.retryAfterMs }),
      );
    }
    throw err;
  }
}

/**
 * `NodeActionTarget` (`extension-points.ts`) is deliberately narrower than
 * `TargetSummary`: only `targetId`/`url`/`title`, "what a cross node
 * caller needs to keep driving, not the full wire shape a viewer's own
 * target list carries" (that type's own doc comment). A forwarded
 * `target.list`/`target.create` therefore cannot report `kind`/`active`/
 * `audible`/... honestly, so this fills them with the same conservative,
 * clearly-false-not-fabricated defaults throughout: booleans `false`,
 * counters `0`, nullable fields `null`. A caller reading a forwarded
 * target's `active`/`viewers`/`createdAt` gets "unknown, reported as the
 * safe default", never a guessed value.
 */
function targetSummaryFromNodeAction(t: NodeActionTarget): TargetSummary {
  return {
    targetId: t.targetId,
    kind: 'page',
    title: t.title,
    url: t.url,
    faviconUrl: null,
    index: 0,
    windowId: null,
    active: false,
    audible: false,
    muted: false,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    openerTargetId: null,
    viewers: 0,
    createdAt: 0,
  };
}

/**
 * Builds a {@link RestSessionDriver} over `registry`, forwarding a non
 * local `drive` through `getRouter().dispatchAction`. One instance, reused
 * for every request, exactly like the rest of `RestContext`.
 *
 * `uploads` is optional so a hand built driver (this package's own tests)
 * may omit it; `setInputFiles` then answers the same honest 503 the REST
 * route does rather than pretending the feature is absent.
 */
export function createRestSessionDriver(
  registry: SessionRegistry,
  getRouter: () => BrowserRouter | undefined,
  uploads?: UploadStore,
): RestSessionDriver {
  return {
    async listTargets(drive): Promise<readonly TargetSummary[]> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        return managed.listTargets();
      }
      const result = await forwardAction(getRouter, drive, {
        kind: 'target.list',
        instanceId: drive.resolution.instanceId,
      });
      if (result.kind !== 'target.list')
        throw new Error(
          `unexpected NodeActionResult.kind "${result.kind}" for a target.list dispatch`,
        );
      return result.targets.map(targetSummaryFromNodeAction);
    },

    async createTarget(drive, opts): Promise<TargetSummary> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        return managed.newTarget(opts.url, undefined, undefined);
      }
      const result = await forwardAction(getRouter, drive, {
        kind: 'target.create',
        instanceId: drive.resolution.instanceId,
        ...(opts.url !== undefined ? { url: opts.url } : {}),
      });
      if (result.kind !== 'target.create')
        throw new Error(
          `unexpected NodeActionResult.kind "${result.kind}" for a target.create dispatch`,
        );
      return targetSummaryFromNodeAction(result.target);
    },

    async closeTarget(drive, targetId): Promise<void> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        await managed.closeTarget(targetId);
        return;
      }
      await forwardAction(getRouter, drive, {
        kind: 'target.close',
        instanceId: drive.resolution.instanceId,
        targetId,
      });
    },

    async navigate(drive, targetId, kind, params) {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        return managed.navigate(targetId, kind, params);
      }
      // Nothing in `NodeActionResult`'s `navigate` variant carries state
      // back (see that union's own doc: it is just `{kind: 'navigate'}`),
      // so a forwarded navigate answers `null`, the same "acknowledged,
      // not awaited to completion" contract `navigateTarget`'s own route
      // doc already documents for the local path's `back`/`forward` "at
      // the end of history" case.
      await forwardAction(getRouter, drive, {
        kind: 'navigate',
        instanceId: drive.resolution.instanceId,
        targetId,
        op: kind,
        ...(params.url !== undefined ? { url: params.url } : {}),
      });
      return null;
    },

    async screenshot(drive, targetId, opts) {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        return managed.screenshotTarget(targetId, opts);
      }
      const result = await forwardAction(getRouter, drive, {
        kind: 'screenshot',
        instanceId: drive.resolution.instanceId,
        targetId,
        ...(opts.format !== undefined ? { format: opts.format } : {}),
        ...(opts.quality !== undefined ? { quality: opts.quality } : {}),
        ...(opts.fullPage !== undefined ? { fullPage: opts.fullPage } : {}),
      });
      if (result.kind !== 'screenshot')
        throw new Error(
          `unexpected NodeActionResult.kind "${result.kind}" for a screenshot dispatch`,
        );
      return {
        format: result.format,
        data: result.data,
        width: result.width,
        height: result.height,
      };
    },

    async click(drive, targetId, opts): Promise<void> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        await managed.clickTarget(targetId, opts);
        return;
      }
      await forwardAction(getRouter, drive, {
        kind: 'click',
        instanceId: drive.resolution.instanceId,
        targetId,
        x: opts.x,
        y: opts.y,
        ...(opts.button !== undefined ? { button: opts.button } : {}),
      });
    },

    async type(drive, targetId, text): Promise<void> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        await managed.typeTarget(targetId, text);
        return;
      }
      await forwardAction(getRouter, drive, {
        kind: 'type',
        instanceId: drive.resolution.instanceId,
        targetId,
        text,
      });
    },

    /**
     * `RestSessionDriver.setInputFiles`. Local only, and the non local
     * case throws rather than forwarding, which is a real limit worth
     * stating precisely rather than papering over.
     *
     * Every other verb in this driver forwards through
     * `BrowserRouter.dispatchAction` when the instance lives on another
     * node, because a click is a message and a message can be relayed.
     * An upload is not a message: the staged FILE is on this gateway's
     * local disk (`UploadStore`'s root), and the owning node's Chrome can
     * only open paths on the owning node. Forwarding a `files.set` action
     * would hand that node a path that does not exist there, and Chrome
     * would attach an empty `FileList` while every layer above reported
     * success. That is a worse failure than a refusal, because it shows up
     * as a broken form submission rather than as an error.
     *
     * Making this work across nodes means staging the bytes ON the owning
     * node (a node-side upload endpoint the gateway streams through, or a
     * shared object store both can read), which is a transfer design, not
     * a dispatch kind, and is not built yet. Until then a caller uploading
     * to a multi node deployment must talk to the gateway that owns its
     * instance, and gets an error that says so.
     */
    async setInputFiles(drive, targetId, req): Promise<{ readonly files: readonly string[] }> {
      if (!drive.resolution.local) {
        throw new RestError(
          409,
          'E_UPLOAD_NOT_LOCAL',
          `Instance "${drive.resolution.instanceId}" runs on node "${drive.resolution.nodeId}", not on this gateway. Staged uploads live on the gateway's own disk and cannot be attached by a browser on another node; send the upload and the attach request to the gateway that owns this instance.`,
        );
      }
      const managed = findLocalManaged(registry, drive.resolution.sessionId);
      if (!managed) throw sessionNotLive(drive.resolution.sessionId);
      if (uploads === undefined) {
        throw new RestError(
          503,
          'E_UPLOADS_UNAVAILABLE',
          'This gateway has no upload staging area wired, so there is nothing to resolve uploadIds against.',
        );
      }

      // Resolved BEFORE the CDP call, all of them, so a request naming one
      // bad id among five fails without half-attaching the other four.
      // `pathFor` is also the only place a path is produced at all, and it
      // is given ids and a tenant, never anything a caller could shape
      // into a location.
      const paths: string[] = [];
      const names: string[] = [];
      for (const uploadId of req.uploadIds) {
        paths.push(await uploads.pathFor(uploadId, req.tenantId));
        names.push(uploads.status(uploadId, req.tenantId).name);
      }

      await managed.setInputFiles(targetId, req.selector, paths);

      // Chrome reads these files lazily, when the page submits the form,
      // which can be minutes from now. Pushing each deadline out here
      // means a successful attach is what keeps the bytes alive, rather
      // than the caller having to guess a TTL. See
      // `files/upload-store.ts`'s module doc.
      for (const uploadId of req.uploadIds) uploads.touch(uploadId, req.tenantId);
      return { files: names };
    },
  };
}

/** Builds a {@link RestCdpSender} over `registry`, forwarding a non local `drive` the same way {@link createRestSessionDriver} does. */
export function createRestCdpSender(
  registry: SessionRegistry,
  getRouter: () => BrowserRouter | undefined,
): RestCdpSender {
  return {
    async send(drive, targetId, method, params): Promise<unknown> {
      if (drive.resolution.local) {
        const managed = findLocalManaged(registry, drive.resolution.sessionId);
        if (!managed) throw sessionNotLive(drive.resolution.sessionId);
        return managed.sendCdp(targetId, method, params);
      }
      const result = await forwardAction(getRouter, drive, {
        kind: 'cdp',
        instanceId: drive.resolution.instanceId,
        targetId,
        method,
        params,
      });
      if (result.kind !== 'cdp')
        throw new Error(`unexpected NodeActionResult.kind "${result.kind}" for a cdp dispatch`);
      return result.result;
    },
  };
}
