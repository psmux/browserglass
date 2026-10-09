import { type NextRequest, NextResponse } from 'next/server';
import {
  demoPrincipal,
  getBg,
  liveViewerCount,
  normaliseWorkspaceId,
  resolveOwnerId,
  setOwnerCookie,
  stickySubjectFor,
} from '../../../../lib/bgls';

/**
 * `GET`, proxying `bg.router.list()`. This is the six line replacement for
 * the `useBrowserInstances` hook that does not exist:
 * `@browserglass/react` ships hooks for the tabs inside one already
 * connected instance (`useTargets`), not for listing separate browser
 * instances across a whole deployment, which stays REST based app code.
 * This route exists so that absence is demonstrated, not merely asserted.
 *
 * Two things it does that the router cannot do for it:
 *
 * `mine` marks the rows whose `subject` matches this visitor's own sticky
 * subject, which is what "these are the browsers a reload will give you
 * back" means. `InstanceListFilter` does carry a `subject` field, but
 * `BrowserRouter.list` never reads it (it forwards only `state`, `poolId`
 * and `limit` to the store), so the match is done here.
 *
 * `viewers` comes from `bg.sessions`, not from the `InstanceView.live`
 * that `router.list` is typed to return: that field is hardcoded to `null`
 * for every row, so reading it would report every instance as having no
 * viewers. See `liveViewerCount` in lib/bgls.ts.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  if (bg.router === undefined) {
    return NextResponse.json(
      { error: { code: 'E_ROUTER_UNAVAILABLE', message: 'This gateway has no local router.' } },
      { status: 503 },
    );
  }

  const identity = resolveOwnerId(req);
  const workspaceId = normaliseWorkspaceId(req.nextUrl.searchParams.get('workspace'));
  const mySubject = stickySubjectFor(identity.ownerId, workspaceId);

  const rows = await bg.router.list({}, demoPrincipal(identity.ownerId));
  const items = await Promise.all(
    rows.map(async (r) => ({
      instanceId: r.instance.id,
      state: r.instance.state,
      acquiredAt: r.instance.acquiredAt,
      subject: r.instance.subject,
      mine: r.instance.subject === mySubject,
      viewers: (await liveViewerCount(r.instance.id)) ?? 0,
    })),
  );

  return setOwnerCookie(NextResponse.json({ subject: mySubject, items }), identity);
}
