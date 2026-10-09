/**
 * The one piece of glue a Next.js custom server needs: App Router route handlers under
 * app/api/** run inside Next's own module graph, not server.mjs's, so they
 * cannot close over the `bg` instance server.mjs constructs. server.mjs
 * calls `defineGlobalBg(bg)` once, right after `createBrowserGlass`; every
 * route handler in this app calls getBg() to read it back.
 *
 * `@browserglass/server` already ships this exact accessor pair
 * (`getBg`/`defineGlobalBg`, `packages/server/src/adapters/nextjs.ts`), so
 * this file is a thin, explicit re-export rather than a reimplementation:
 * an app is free to write its own version of this file, but there is no
 * reason to duplicate logic the SDK already tested.
 *
 * It is also where this demo's ownership model lives (see `resolveOwnerId`
 * and `stickySubjectFor` below), because "whose browsers are these" is an
 * application question, not an SDK one: the router only ever sees the
 * opaque string these helpers produce.
 */
export { getBg, defineGlobalBg } from '@browserglass/server';

import { randomUUID } from 'node:crypto';
import type { Capability, Principal } from '@browserglass/protocol';
import { getBg } from '@browserglass/server';
import type { NextRequest, NextResponse } from 'next/server';

/**
 * The fallback identity, used only when a request arrives with no owner
 * cookie and none can be set (a `sendBeacon` from a page loaded before
 * this feature existed, for instance). Every ordinary request resolves to
 * a real per visitor id instead, see `resolveOwnerId`.
 *
 * Kept exported and kept working on purpose: it is the identity every
 * instance launched by an older build of this demo carries in its
 * `subject` column, so dropping it would strand those rows.
 */
export const DEMO_USER_ID = 'demo-user';

/**
 * The cookie carrying one visitor's stable owner id.
 *
 * httpOnly because nothing on the client needs to read it: the page learns
 * its own mode from the JSON `POST /api/browser` returns, not from
 * `document.cookie`. `sameSite: 'lax'` so a shared workspace link followed
 * from another site still carries the visitor's own identity. Not
 * `secure`, because this demo is served over plain http on localhost and a
 * `secure` cookie would simply never be stored there; a real deployment
 * behind TLS should set it.
 */
export const OWNER_COOKIE = 'bgls_owner';

/** One year. The owner id is not a credential, it is a bookmark: losing it costs the visitor their browsers, nothing more. */
export const OWNER_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * How far back `sticky` is allowed to look for this owner's last instance.
 *
 * Four hours, matching `RouterConfig.maxDurationMs` (14_400_000,
 * `packages/router/src/router/config.ts`), which is the hard ceiling on
 * how long any instance can live at all: an instance older than this
 * window cannot exist, so the window is deliberately "as long as your
 * browsers can possibly still be alive". The real gate on reuse is not
 * this number, it is `findReusable`'s own status filter (only `live`,
 * `warm` or `recovering` rows are candidates) plus `canShare`, which
 * additionally refuses an instance with less than `shareMinRemainingMs`
 * (60s) left on its TTL. Picking a short window here would only mean
 * launching a second Chrome while the visitor's first one is still
 * running and still theirs, which is exactly the bug being fixed.
 */
export const STICKY_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Every capability the demo grants itself: viewing, driving, navigating,
 * managing tabs, capturing a still frame (`client.capture()`, exercised by
 * this demo's own UI), reading console/error/network diagnostics
 * (`devtools`, for the `useConsole`/`useNetwork` panels), and manually invoking `instance.restart` from a real,
 * unmodified client token, not just an internally minted elevated one.
 * `preserveProfile:false` additionally requires `profile.write` (the wire
 * layer's own `PARAMETER_DEPENDENT_CAPABILITY_RULES`), deliberately left
 * out of this demo's base grant since the demo never needs to wipe its own
 * profile.
 */
export const DEMO_CAPS: readonly Capability[] = [
  'view',
  'control',
  'navigate',
  'tabs.manage',
  'capture',
  'devtools',
  'instance.restart',
  // The rest of what an agent actually needs, and what this demo is
  // supposed to be the proof of. Without these the SDK looks broken from
  // the outside in a way that has nothing to do with the SDK: every
  // `evaluate()` came back `POLICY_DENIED evaluate() needs the 'evaluate'
  // capability`, which reads as "page evaluation is not implemented"
  // rather than "this particular token was not granted it". It is
  // implemented; the demo simply never asked for it.
  //
  // `evaluate` has to be named explicitly and cannot arrive any other
  // way: it is deliberately absent from every `ROLE_BUNDLES` entry,
  // `owner` included, so that no role name grants it by accident
  // (`packages/protocol/src/wire/capabilities.ts`).
  //
  // `probe` backs `inspectAt`/`rect`, `upload` backs `setInputFiles`,
  // `clipboard.*` backs copy and paste, and `automation` is what marks a
  // connection as a driver rather than a spectator.
  'evaluate',
  'probe',
  'automation',
  'upload',
  'download',
  'clipboard.read',
  'clipboard.write',
  // The outbound request gate. Granted here because this demo exercises
  // the whole SDK, and a capability nothing exercises is a
  // capability nobody finds out is broken. A real deployment should weigh
  // it deliberately: a holder can refuse ANY request the page makes,
  // including the operator's own telemetry or consent scripts. That is an
  // egress veto, it is real, and there is no way to offer a useful
  // request gate without it. Nothing enables `Fetch` unless a gate is
  // actually registered, so granting it costs nothing until used.
  'intercept',
];

/** What `resolveOwnerId` decided, and whether the caller still owes the response a `Set-Cookie`. */
export interface OwnerIdentity {
  ownerId: string;
  /** True on a visitor's very first request: the id was minted here and only exists in memory until `setOwnerCookie` runs. */
  isNew: boolean;
}

/**
 * Resolves the visitor behind this request to a stable id.
 *
 * Before this existed every request in the demo acted as the single
 * constant `DEMO_USER_ID`, which made "my browsers" literally
 * inexpressible: `sticky.subject` would have matched every visitor at
 * once, so the only honest thing the demo could do was launch a fresh
 * Chrome on every page load. That is the bug. A per visitor cookie is the
 * smallest thing that makes the question answerable without bolting a
 * login screen onto an example whose point is streaming, not auth.
 *
 * The id is minted here rather than in `middleware.ts` because every path
 * that needs it (`POST /api/browser`, the token refresh, release, the
 * instance list) is already a route handler, and a route handler can both
 * read the request cookie and stamp the response one. A real application
 * would read this from its session instead and delete this function.
 */
export function resolveOwnerId(req: NextRequest): OwnerIdentity {
  const existing = req.cookies.get(OWNER_COOKIE)?.value;
  if (typeof existing === 'string' && existing.length > 0)
    return { ownerId: existing, isNew: false };
  return { ownerId: `owner_${randomUUID()}`, isNew: true };
}

/** Stamps a freshly minted owner id onto the outgoing response. No-op for a visitor who already had one. */
export function setOwnerCookie(res: NextResponse, identity: OwnerIdentity): NextResponse {
  if (!identity.isNew) return res;
  res.cookies.set({
    name: OWNER_COOKIE,
    value: identity.ownerId,
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: OWNER_COOKIE_MAX_AGE_SECONDS,
  });
  return res;
}

/**
 * Normalises a `?workspace=` value into something safe to store as an
 * instance `subject`.
 *
 * The value arrives from a URL anybody can type, and it ends up in a
 * `WHERE created_by_sub = ?` comparison, so it is restricted to a short
 * ASCII alphabet rather than passed through. Returns null for anything
 * that does not fit, which the caller treats as "no workspace asked for"
 * rather than as an error: a mistyped share link should drop you into your
 * own browsers, not into a 400.
 */
export function normaliseWorkspaceId(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 64) return null;
  return /^[A-Za-z0-9_-]+$/.test(trimmed) ? trimmed : null;
}

/**
 * The string this demo puts in `AcquireRequest.sticky.subject` (and in
 * `AcquireRequest.subject`, so a launched instance is stamped with the
 * same value and the next acquire can find it again).
 *
 * Both modes ride one field; only the value differs. Solo mode uses the
 * visitor's own owner id, so a reload, a second tab, or a revisit next
 * morning all reattach to the same Chrome. A workspace uses the shared id
 * from the link, so everybody who follows that link lands on the same
 * Chrome and can collaborate on it.
 *
 * The `workspace:` prefix keeps the two namespaces from ever colliding: an
 * owner id is `owner_<uuid>` and a workspace id cannot contain a colon
 * (`normaliseWorkspaceId`), so no visitor can ever craft a workspace name
 * that resolves to somebody else's personal browsers.
 */
export function stickySubjectFor(ownerId: string, workspaceId: string | null): string {
  return workspaceId === null ? ownerId : `workspace:${workspaceId}`;
}

/**
 * Builds the server-side `Principal` every route handler in this app uses
 * to call `bg.router.*`. A real application resolves this from its own
 * session/cookie; this demo resolves it from the owner cookie
 * (`resolveOwnerId`), with every capability the router surface needs
 * (`instance.create`/`instance.destroy` in addition to the end user
 * capabilities the minted token itself carries, since the router call
 * happens with the server's own authority, not the browser's).
 *
 * `sub` is always the visitor's personal owner id, never a workspace id,
 * even when the acquire is for a shared workspace: `sub` answers "who is
 * asking" and `sticky.subject` answers "which browsers are they asking
 * for", and collapsing the two would make a workspace look like a user for
 * quota and audit purposes.
 */
export function demoPrincipal(ownerId: string = DEMO_USER_ID): Principal {
  const bg = getBg();
  return bg.principalFromClaims({
    tenantId: bg.config.tenantId,
    appId: bg.config.appId,
    sub: ownerId,
    subKind: 'user',
    caps: [...DEMO_CAPS, 'instance.create', 'instance.destroy'],
    scope: { kind: 'tenant' },
  });
}

/**
 * The live viewer count for one instance, or null when nothing is
 * connected to it in this process at all.
 *
 * Reads `bg.sessions` (the in-process `SessionRegistry`), deliberately,
 * NOT `bg.router.list()`: `BrowserRouter.list` maps every row to
 * `{ instance, live: null }` unconditionally
 * (`packages/router/src/router/BrowserRouter.ts`), so its `live.viewers`
 * is always absent and any release decision built on it would think every
 * instance had zero viewers. `SessionView.viewerCount` is the real count,
 * maintained by the socket layer as viewers connect and disconnect.
 */
export async function liveViewerCount(instanceId: string): Promise<number | null> {
  const bg = getBg();
  const sessions = await bg.sessions.list({ instanceId });
  const session = sessions.items[0];
  return session === undefined ? null : session.viewerCount;
}
