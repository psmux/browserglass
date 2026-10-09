import type { BrowserSpec } from '@browserglass/protocol';
import { type NextRequest, NextResponse } from 'next/server';
import {
  DEMO_CAPS,
  STICKY_WINDOW_MS,
  demoPrincipal,
  getBg,
  normaliseWorkspaceId,
  resolveOwnerId,
  setOwnerCookie,
  stickySubjectFor,
} from '../../../lib/bgls';

interface RouterError {
  readonly httpStatus?: number;
  readonly code?: string;
  readonly message?: string;
}

function errorResponse(err: unknown): NextResponse {
  const e = err as RouterError;
  const status = typeof e?.httpStatus === 'number' ? e.httpStatus : 500;
  return NextResponse.json(
    { error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Unknown error.' } },
    { status },
  );
}

/**
 * Acquires a browser instance and mints a fresh credential for it.
 *
 * There are four ways in, and they differ only in what they put in
 * `AcquireRequest`'s selection fields:
 *
 * 1. No body at all: SOLO mode, the default. Acquires with
 *    `sticky: { subject: <this visitor's owner id> }`, so a reload, a
 *    second tab, or a visit tomorrow morning all reattach to the SAME
 *    Chrome instead of launching another one. This is the fix for "every
 *    time I open /browser, a new set of 3 windows appears": the old code
 *    named no selector at all, so `findReusable` had nothing to match on
 *    and every acquire past the 10 second idempotency bucket launched.
 *
 * 2. `{ workspace }`: SHARED mode. Identical, except the sticky subject is
 *    the workspace id from the `?workspace=` link rather than the personal
 *    owner id, so everyone holding that link collaborates on one set of
 *    browsers. `lib/bgls.ts`'s `stickySubjectFor` keeps the two namespaces
 *    apart.
 *
 * 3. `{ instanceId }`: attach to a known, already running instance and
 *    never launch (`AcquireRequest.instanceId`). This is the "join exactly
 *    what I am looking at right now" escape hatch behind the "Copy link
 *    for a second viewer" button, and it predates the workspace model.
 *
 * 4. `{ fresh: true }`: deliberately bypass reuse and launch a genuinely
 *    new instance, which is what the page's "New browser set" button
 *    calls. Reuse-by-default is only defensible if there is a visible way
 *    to opt out of it.
 *
 * `sticky` is sent alongside `profile: { mode: 'ephemeral' }`. Those two
 * used to be mutually exclusive: `BrowserRouter.doAcquire` counted ANY
 * `profile` as a selector, not just a `profile.key`, and threw
 * `E_CONFLICTING_SELECTORS`, so the single most obvious way to ask for
 * "a throwaway browser, but the same one as last time" was rejected. The
 * router now conflicts only on a PERSISTENT profile key, which is what
 * `AcquireRequest`'s own documented contract always said ("at most one of
 * instanceId, profile.key, sticky"): an ephemeral profile names no key and
 * therefore selects nothing.
 *
 * `subject` is passed EXPLICITLY, and not only inside `sticky.subject`.
 * That is load bearing. The stored `created_by_sub` comes from
 * `req.subject ?? principal.sub`, and while `principal.sub` is now the
 * visitor's own owner id rather than one shared constant, a workspace
 * acquire has a subject (`workspace:<id>`) that is deliberately NOT the
 * principal. Setting `sticky` alone would file the instance under the
 * launcher's personal id, and the next person through the same link would
 * find nothing to stick to: a failure mode that looks like correct code
 * and silently launches a second Chrome.
 *
 * `requestId` is bucketed to the current 10 second window, so a double
 * click on "Open Browser" inside one window is idempotent and never
 * launches two Chromes for the same click. The `fresh` path gets its own
 * bucket namespace: replaying the ordinary `open:` key would hand back the
 * cached result for the instance the user just asked to replace.
 *
 * Mints a bearer token (`bg.tokens.issueWithMeta`), not an opaque ticket:
 * `mintTicket()`/`TicketRegistry` (the real, atomic, single use `tkt_`
 * mechanism `@browserglass/server` builds) has no entry point reachable
 * from `createBrowserGlass()`'s exported `BrowserGlass` interface, and
 * `BrowserRouter.acquire()`'s own `AcquireResult.attach.ticket` is a
 * placeholder id (`newId('tkt')`) with a placeholder `wsUrl`
 * (`ws://local/...`), never redeemable against a real socket: confirmed
 * directly by reading `packages/router/src/router/BrowserRouter.ts`. The
 * bearer token path (`hello.auth = { scheme: 'bearer', token }`, verified
 * by the `auth.resolver` server.mjs wires up) is fully built and fully
 * wired end to end, so this demo uses it.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  if (bg.router === undefined) {
    return NextResponse.json(
      { error: { code: 'E_ROUTER_UNAVAILABLE', message: 'This gateway has no local router.' } },
      { status: 503 },
    );
  }

  const body = (await req.json().catch(() => ({}))) as {
    instanceId?: unknown;
    workspace?: unknown;
    fresh?: unknown;
    // Untyped passthrough to `AcquireRequest.browser` (`Partial<BrowserSpec>`,
    // `packages/router/src/router/types.ts`), forwarded verbatim to
    // `bg.router.acquire` below. Nothing in this demo's own UI sends it:
    // every route launches with the pool template's default spec, so this
    // stays optional and unvalidated rather than growing a real schema. It
    // is here so a script can ask for a per instance user agent or client
    // hints.
    browser?: unknown;
    // Untyped passthrough to `AcquireRequest.metadata`/`.lifetime`
    // (`packages/router/src/router/types.ts`), forwarded verbatim to
    // `bg.router.acquire` below, the same pattern `browser` above already
    // established. The demo UI sends neither; `bg.router.acquire`'s own
    // `validateAcquireMetadata` (`packages/router/src/router/instanceMetadata.ts`)
    // enforces the real caps (16 keys, 64/512 character key/value limits),
    // so this route does not duplicate that validation.
    metadata?: unknown;
    lifetime?: unknown;
  };
  const attachTo = typeof body.instanceId === 'string' ? body.instanceId : undefined;
  const workspaceId = normaliseWorkspaceId(body.workspace);
  const fresh = body.fresh === true;
  const browserSpec =
    body.browser !== null && typeof body.browser === 'object'
      ? (body.browser as Record<string, unknown>)
      : undefined;
  const metadata =
    body.metadata !== null && typeof body.metadata === 'object'
      ? (body.metadata as Record<string, string>)
      : undefined;
  const lifetime =
    body.lifetime === 'explicit' || body.lifetime === 'viewer-bound' ? body.lifetime : undefined;

  const identity = resolveOwnerId(req);
  const principal = demoPrincipal(identity.ownerId);
  const subject = stickySubjectFor(identity.ownerId, workspaceId);
  const mode = attachTo !== undefined ? 'attached' : workspaceId !== null ? 'workspace' : 'solo';

  try {
    const handle = await bg.router.acquire(
      attachTo !== undefined
        ? { instanceId: attachTo }
        : {
            requestId: fresh
              ? `new:${subject}:${Math.floor(Date.now() / 10_000)}`
              : `open:${subject}:${Math.floor(Date.now() / 10_000)}`,
            pool: 'demo',
            profile: { mode: 'ephemeral' },
            // Stamped onto the launched instance's `subject` column
            // (`BrowserRouter.doAcquire`: `subject: req.subject ??
            // principal.sub`). Without it a workspace acquire would be
            // filed under the launcher's personal id and the second person
            // to follow the same link would find nothing to stick to.
            subject,
            // Omitted entirely on the `fresh` path: naming a sticky
            // subject there would find the very instance the user is
            // trying to replace.
            ...(fresh ? {} : { sticky: { subject, withinMs: STICKY_WINDOW_MS } }),
            ...(browserSpec ? { browser: browserSpec as Partial<BrowserSpec> } : {}),
            ...(metadata ? { metadata } : {}),
            ...(lifetime ? { lifetime } : {}),
          },
      principal,
    );
    const result = handle.result;

    // The pool was full and `onFull` resolved to `queue` (`admit()`'s
    // default, `packages/router/src/admission/admit.ts`): `result` here
    // is a queue ticket, not a browser. `AcquireResult.instanceId` is
    // `null` for exactly this case (`packages/router/src/router/types.ts`);
    // the real id lives in `result.placementId`, a `placement_queue` row
    // id, never an instance id. This used to fall straight through to the
    // code below, which minted a bearer token scoped to
    // `instanceId: result.instanceId`, i.e. to a `plc_` id disguised as an
    // `inst_` one, and returned it with the exact same 200 shape as a real
    // acquire: a caller had no field to check and no reason to suspect
    // anything was wrong. Answered honestly instead: a distinct `202`
    // shape, no `instanceId`, no token (minting one for a browser that
    // does not exist yet is itself wrong, since nothing exists for it to
    // authorize access to). `result.queue` names how long this is likely
    // to take; a caller that wants the real instance once the placement
    // is filled has two options this build supports: retry this same POST
    // after `queue.pollAfterMs` (a fresh idempotency bucket every 10
    // seconds, `requestId` above, means a retry is never mistaken for the
    // original queued request), or reach for `BrowserRouter.acquire`'s
    // own `AcquireHandle.ready` directly from server side code, which
    // resolves once `processQueue` places this same request. No polling
    // endpoint keyed by `placementId` exists yet; adding one is a real
    // feature, not a one-line fix, and out of scope here.
    if (result.state === 'queued') {
      return setOwnerCookie(
        NextResponse.json(
          {
            state: 'queued',
            instanceId: null,
            placementId: result.placementId,
            queue: result.queue,
            mode,
            workspace: workspaceId,
          },
          { status: 202 },
        ),
        identity,
      );
    }

    // Every other `state` (`'ready'` or `'launching'`) is a real,
    // already-created instance row, so `buildResult`
    // (`packages/router/src/router/BrowserRouter.ts`) always sets
    // `instanceId` there; `null` is exclusively the queued case handled
    // above. Checked rather than asserted, matching the same guard this
    // fix adds server side (`packages/server/src/rest/routes/instances.ts`'s
    // `fireInstanceLaunched`), so a future change that makes this untrue
    // fails loudly here instead of minting a token for a non-instance.
    if (result.instanceId === null) {
      return errorResponse({
        code: 'E_INTERNAL',
        message: 'acquire returned no instanceId for a non-queued result.',
      });
    }
    const instanceId = result.instanceId;

    // `AcquireResult.sessionId` comes back empty here: `store-sqlite`'s
    // `instances` table has no `session_id` column at all (confirmed
    // directly against the real schema, `PRAGMA table_info(instances)`),
    // so `BrowserRouter.buildResult()`'s `instance.sessionId ?? ''`
    // (`packages/router/src/router/BrowserRouter.ts`) always reads back
    // empty even though the real session row (`store.createSession()`) was
    // genuinely created with a real id moments earlier in the same
    // `placeAndLaunch` call. So this route falls back to
    // `bg.sessions.list({ instanceId })`, which reads the session
    // registry directly rather than through the instance row.
    const sessionId =
      result.sessionId !== ''
        ? result.sessionId
        : ((await bg.sessions.list({ instanceId })).items[0]?.sessionId ?? '');

    const issued = await bg.tokens.issueWithMeta({
      // The visitor's own id, not the workspace id: the token says who is
      // connecting, and presence/audit read it that way.
      sub: identity.ownerId,
      caps: DEMO_CAPS,
      scope: {
        kind: 'instance',
        instanceId,
        targets: '*',
        sessionId,
      },
      // 120s default; the client refreshes continuously via
      // /api/browser/token, which is why that route exists at all.
      ttlSeconds: 120,
    });

    return setOwnerCookie(
      NextResponse.json({
        state: result.state,
        instanceId,
        sessionId,
        reused: result.reused,
        reuseReason: result.reuseReason,
        // Echoed back so the page can say, in words, which of the four
        // paths above it took and which browsers it is looking at.
        mode,
        workspace: workspaceId,
        wsPath: bg.config.wsPath,
        token: issued.token,
        caps: issued.caps,
        expiresAt: issued.expiresAt,
      }),
      identity,
    );
  } catch (err) {
    return errorResponse(err);
  }
}

/**
 * Releases an instance. `?instanceId=` names it; the profile is destroyed
 * since every instance this demo launches is ephemeral.
 *
 * Reports `BrowserRouter.release`'s own `ReleaseResult` rather than a flat
 * `{ released: true }`: the router terminates only when no viewers remain
 * and answers `outcome: 'detached'` with a `remainingViewers` count
 * otherwise, and a caller that is told "released" when the browser is
 * still running for two other people will act on it. No `force`: a viewer
 * asking to close its own view is never entitled to end a session other
 * viewers are still in.
 */
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  if (bg.router === undefined) {
    return NextResponse.json(
      { error: { code: 'E_ROUTER_UNAVAILABLE', message: 'This gateway has no local router.' } },
      { status: 503 },
    );
  }

  const instanceId = req.nextUrl.searchParams.get('instanceId');
  if (instanceId === null) {
    return NextResponse.json(
      { error: { code: 'E_MISSING_PARAM', message: 'instanceId query parameter is required.' } },
      { status: 400 },
    );
  }

  const principal = demoPrincipal(resolveOwnerId(req).ownerId);
  try {
    const result = await bg.router.release(
      instanceId,
      { reason: 'user_closed', profile: 'destroy' },
      principal,
    );
    return NextResponse.json({
      released: result.outcome === 'terminated',
      outcome: result.outcome,
      remainingViewers: result.remainingViewers,
    });
  } catch (err) {
    return errorResponse(err);
  }
}
