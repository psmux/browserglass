/**
 * The driving verbs: list/create/close targets, navigate, screenshot, and
 * click/type input, plus the capability-gated CDP passthrough. Every
 * handler here is real, request/response HTTP: a caller wanting a live
 * feed (frames, console, network) still needs the WebSocket transport or a
 * poll loop against these routes, never a push from here (`router.ts`'s
 * route docs say so; see each `RestRoute` registration).
 *
 * Every handler below resolves its instance through `resolveDrive`, which
 * calls `BrowserRouter.driveInstance` (the router's authority gate), never `ctx.store` directly. This file used to read
 * `store.getInstance()` itself, admitting in its own comment that "none of
 * these routes have a router handle to call `describe()` through": that
 * was wrong twice over, since it bypassed the router's admission check
 * (an instance mid launch or draining answered exactly like a ready one)
 * and never recorded activity, which is why `navigate`/`screenshotTarget`/
 * `sendCdp`/`clickTarget`/`typeTarget` used to be invisible to the idle
 * reaper (that handoff's defect 4). `resolveDrive`'s single call fixes
 * both: `driveInstance` throws an honest, state-specific error for
 * anything short of `ready`/`degraded`, and records activity on every
 * call, throttled router side, so a REST-only driven instance stays
 * `lastActivityAt`-current the same way a WS-driven one already did.
 */

import type { Principal } from '@browserglass/protocol';
import { compact } from '../../util/compact.js';
import { isCdpMethodAllowed } from '../cdp-passthrough-allowlist.js';
import { RestError, mapRouterError, requireRouter, writeJson } from '../errors.js';
import type {
  DrivingContext,
  RestCdpSender,
  RestContext,
  RestHandler,
  RestSessionDriver,
} from '../types.js';
import { mapUploadError } from './uploads.js';

function requireParam(params: Readonly<Record<string, string>>, name: string): string {
  const value = params[name];
  if (value === undefined) throw new RestError(400, 'E_MISSING_PARAM', `${name} is required.`);
  return value;
}

/**
 * 503, matching `routes/instances.ts`'s `requireRouter` pattern: a real
 * dependency this build has not wired, not a 404 or a blind 501.
 *
 * `ctx.driver` and `ctx.cdp` ARE set in this build, at
 * `packages/server/src/index.ts:300` to `:301`
 * (`createRestSessionDriver`/`createRestCdpSender`, both closures over
 * `sessionRegistry` and the same `() => wiring?.router` getter
 * `restContext.getRouter` itself uses), so `requireDriver`/`requireCdp`
 * below throw only for a composition root that genuinely omitted them
 * (a bespoke test harness, or a future build that intentionally strips
 * driving out), never for this one.
 */
function requireDriver(ctx: RestContext): RestSessionDriver {
  if (ctx.driver === undefined) {
    throw new RestError(
      503,
      'E_DRIVER_UNAVAILABLE',
      'This gateway has no live session driver wired (RestContext.driver is unset). The route exists and is capability-gated; it needs a live ManagedSession accessor plugged in at the composition root before it can actually drive a browser.',
    );
  }
  return ctx.driver;
}

function requireCdp(ctx: RestContext): RestCdpSender {
  if (ctx.cdp === undefined) {
    throw new RestError(
      503,
      'E_CDP_UNAVAILABLE',
      'This gateway has no CDP passthrough sender wired (RestContext.cdp is unset). The route exists, is capability-gated, and enforces its method allowlist; it needs a live CDP sender plugged in at the composition root before it can actually reach Chrome.',
    );
  }
  return ctx.cdp;
}

/**
 * Resolves `instanceId` through `BrowserRouter.driveInstance`, the
 * authority gate: throws `E_INSTANCE_NOT_FOUND` (404) for an unknown
 * instance, `E_INSTANCE_GONE` (410) for one already released or failed,
 * and `E_INSTANCE_NOT_READY` (409, retryable) for one that exists but is
 * not yet `ready`/`degraded`, exactly `mapRouterError`'s translation of
 * whatever `driveInstance` itself throws. Bundles the resolution with
 * `principal` into a {@link DrivingContext}, since `ctx.driver`/`ctx.cdp`
 * need both: `resolution` to pick a local or remote execution path,
 * `principal` for the `BrowserRouter.dispatchAction` call the remote path
 * makes on the caller's behalf.
 */
async function resolveDrive(
  ctx: RestContext,
  principal: Principal,
  instanceId: string,
): Promise<DrivingContext> {
  const router = requireRouter(ctx);
  try {
    const resolution = await router.driveInstance(instanceId, principal);
    return { resolution, principal };
  } catch (err) {
    return mapRouterError(err);
  }
}

function asRecord(body: unknown): Record<string, unknown> {
  if (body === undefined || body === null || typeof body !== 'object' || Array.isArray(body)) {
    throw new RestError(400, 'E_BAD_JSON', 'Request body must be a JSON object.');
  }
  return body as Record<string, unknown>;
}

/** `GET /v1/instances/:instanceId/targets`, capability `view`. A poll, not a feed: use the WebSocket transport's `target.list`/`target.updated` for live updates. */
export const listTargets: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const targets = await driver.listTargets(drive);
  writeJson(rctx.res, rctx.requestId, { items: targets });
};

/** `POST /v1/instances/:instanceId/targets`, capability `tabs.manage`. */
export const createTarget: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const body = rctx.body === undefined ? {} : asRecord(rctx.body);
  const url = typeof body['url'] === 'string' ? (body['url'] as string) : undefined;
  const target = await driver.createTarget(drive, compact({ url }));
  writeJson(rctx.res, rctx.requestId, target, 201);
};

/** `DELETE /v1/instances/:instanceId/targets/:targetId`, capability `tabs.manage`. */
export const closeTarget: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  await driver.closeTarget(drive, targetId);
  writeJson(rctx.res, rctx.requestId, { closed: true });
};

const NAV_KINDS = new Set(['goto', 'back', 'forward', 'reload', 'stop']);

/** `POST /v1/instances/:instanceId/targets/:targetId/navigate`, capability `navigate`. Body: `{kind?: 'goto'|'back'|'forward'|'reload'|'stop', url?, ignoreCache?}`, `kind` defaulting to `'goto'`. Answers once the navigation command is acknowledged, not once the page finishes loading; poll `GET .../targets` or use the WebSocket transport's `nav.state` for load completion. */
export const navigateTarget: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const body = asRecord(rctx.body);
  const kind = body['kind'] === undefined ? 'goto' : body['kind'];
  if (typeof kind !== 'string' || !NAV_KINDS.has(kind)) {
    throw new RestError(400, 'E_INVALID_BODY', `kind must be one of ${[...NAV_KINDS].join(', ')}.`);
  }
  if (kind === 'goto' && typeof body['url'] !== 'string') {
    throw new RestError(400, 'E_MISSING_PARAM', 'url is required when kind is "goto".');
  }
  const url = typeof body['url'] === 'string' ? (body['url'] as string) : undefined;
  const ignoreCache = body['ignoreCache'] === true;
  const state = await driver.navigate(
    drive,
    targetId,
    kind as 'goto' | 'back' | 'forward' | 'reload' | 'stop',
    compact({ url, ignoreCache }),
  );
  writeJson(rctx.res, rctx.requestId, state ?? { navigated: true });
};

/** `GET /v1/instances/:instanceId/targets/:targetId/screenshot`, capability `capture`. Query: `format` (`png`|`jpeg`, default `png`), `quality` (jpeg only), `fullPage` (`true`|`false`). One image, not a stream: for a live feed, subscribe to the target's stream over the WebSocket transport instead. */
export const screenshotTarget: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const formatParam = rctx.query.get('format');
  if (formatParam !== null && formatParam !== 'png' && formatParam !== 'jpeg') {
    throw new RestError(400, 'E_INVALID_QUERY', 'format must be "png" or "jpeg".');
  }
  const qualityParam = rctx.query.get('quality');
  const quality = qualityParam !== null ? Number(qualityParam) : undefined;
  if (quality !== undefined && (!Number.isFinite(quality) || quality < 1 || quality > 100)) {
    throw new RestError(400, 'E_INVALID_QUERY', 'quality must be between 1 and 100.');
  }
  const fullPage = rctx.query.get('fullPage') === 'true';
  const shot = await driver.screenshot(
    drive,
    targetId,
    compact({ format: formatParam ?? undefined, quality, fullPage }),
  );
  writeJson(rctx.res, rctx.requestId, shot);
};

/** `POST /v1/instances/:instanceId/targets/:targetId/input`, capability `control`. Body: `{action: 'click', x, y, button?}` or `{action: 'type', text}`. */
export const dispatchInput: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const driver = requireDriver(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const body = asRecord(rctx.body);
  const action = body['action'];
  if (action === 'click') {
    const x = body['x'];
    const y = body['y'];
    if (typeof x !== 'number' || typeof y !== 'number') {
      throw new RestError(400, 'E_MISSING_PARAM', 'x and y are required numbers for a click.');
    }
    const button = body['button'];
    if (button !== undefined && button !== 'left' && button !== 'middle' && button !== 'right') {
      throw new RestError(400, 'E_INVALID_BODY', 'button must be "left", "middle", or "right".');
    }
    await driver.click(drive, targetId, compact({ x, y, button }));
    writeJson(rctx.res, rctx.requestId, { dispatched: true });
    return;
  }
  if (action === 'type') {
    const text = body['text'];
    if (typeof text !== 'string') {
      throw new RestError(400, 'E_MISSING_PARAM', 'text is required for a type action.');
    }
    await driver.type(drive, targetId, text);
    writeJson(rctx.res, rctx.requestId, { dispatched: true });
    return;
  }
  throw new RestError(400, 'E_INVALID_BODY', 'action must be "click" or "type".');
};

/**
 * `POST /v1/instances/:instanceId/targets/:targetId/files`, capability
 * `upload`. Body: `{selector: string, uploadIds: string[]}`.
 *
 * The REST form of Playwright's `set_input_files`, and the route the
 * Python client calls: it stages bytes through
 * `/v1/upload/*`, then names the resulting ids here.
 *
 * There is no `path` field, no `localPath` field, and no option that
 * accepts one. A caller names ids; the gateway resolves each id against
 * its own staging registry, scoped to the caller's tenant, and hands CDP
 * paths that the registry composed from a root the gateway owns. That
 * boundary is the entire reason upload is a two-step operation instead of
 * a passthrough, because a route that took a path here would let any
 * holder of `upload` make the browser attach, and then POST to a site of
 * its choosing, any file the node can read. See `files/safe-name.ts` for
 * the sanitiser and containment check that protect the one caller-supplied
 * value that does become a path component (the filename), and
 * `files/upload-store.ts` for the symlink handling.
 *
 * `uploadIds` is an array so a `multiple` input can be filled in one call,
 * in the order given. Sending more than one to an input without the
 * `multiple` attribute is refused rather than silently truncated to the
 * first, which is what Chrome would otherwise do.
 */
export const setTargetFiles: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const driver = requireDriver(ctx);
  const body = asRecord(rctx.body);
  const selector = body['selector'];
  if (typeof selector !== 'string' || selector.length === 0) {
    throw new RestError(400, 'E_MISSING_PARAM', 'selector is required.');
  }
  const raw = body['uploadIds'];
  if (
    !Array.isArray(raw) ||
    raw.length === 0 ||
    !raw.every((id): id is string => typeof id === 'string')
  ) {
    throw new RestError(400, 'E_MISSING_PARAM', 'uploadIds must be a non-empty array of strings.');
  }
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  try {
    const result = await driver.setInputFiles(drive, targetId, {
      selector,
      uploadIds: raw,
      tenantId: rctx.principal.tenantId,
    });
    writeJson(rctx.res, rctx.requestId, { targetId, selector, files: result.files });
  } catch (err) {
    // The driver resolves ids through the `UploadStore`, so its refusals
    // arrive here as `UploadStoreError`, not `RestError`. Without this
    // they would fall through `dispatchRest`'s catch-all and become an
    // opaque 500 for the two most ordinary caller mistakes there are:
    // naming an id that expired (404) and attaching one that was never
    // completed (409).
    mapUploadError(err);
  }
};

/**
 * `POST /v1/instances/:instanceId/targets/:targetId/cdp`, capability `cdp`
 * (off by default, never folded into `devtools`/`automation`; see
 * `capabilities.ts`'s doc comment on the capability itself). Body:
 * `{method: string, params?: object}`. The allowlist check
 * (`isCdpMethodAllowed`) runs before `requireCdp` even looks for a sender,
 * so a disallowed method never reaches, or reveals whether there is, a
 * live CDP connection: refusal is the same 403 whether or not this build
 * has anything wired behind it.
 */
export const sendCdpCommand: RestHandler = async (ctx, rctx) => {
  const instanceId = requireParam(rctx.params, 'instanceId');
  const targetId = requireParam(rctx.params, 'targetId');
  const body = asRecord(rctx.body);
  const method = body['method'];
  if (typeof method !== 'string' || method.length === 0) {
    throw new RestError(400, 'E_MISSING_PARAM', 'method is required.');
  }
  const paramsRaw = body['params'];
  if (
    paramsRaw !== undefined &&
    (typeof paramsRaw !== 'object' || paramsRaw === null || Array.isArray(paramsRaw))
  ) {
    throw new RestError(400, 'E_INVALID_BODY', 'params must be a JSON object when given.');
  }
  if (!isCdpMethodAllowed(method)) {
    throw new RestError(
      403,
      'E_CDP_METHOD_NOT_ALLOWED',
      `CDP method "${method}" is not on the passthrough allowlist.`,
    );
  }
  const cdp = requireCdp(ctx);
  const drive = await resolveDrive(ctx, rctx.principal, instanceId);
  const result = await cdp.send(
    drive,
    targetId,
    method,
    (paramsRaw as Record<string, unknown> | undefined) ?? {},
  );
  writeJson(rctx.res, rctx.requestId, { result });
};
