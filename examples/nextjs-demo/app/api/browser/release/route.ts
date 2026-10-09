import { type NextRequest, NextResponse } from 'next/server';
import { demoPrincipal, getBg, liveViewerCount, resolveOwnerId } from '../../../../lib/bgls';

/**
 * Releases an instance, by POST.
 *
 * It exists as a POST sibling of `DELETE /api/browser?instanceId=` because
 * it was originally reached from a `pagehide` handler through
 * `navigator.sendBeacon`, which can only issue a POST. `app/browser/page.tsx`
 * no longer releases on `pagehide` at all (its lifecycle comment explains
 * why: a reload and a close are indistinguishable from script, so an
 * automatic release there destroys the browsers a reload is supposed to
 * give back), and the two remaining callers, the "New browser set" and
 * "Close browsers" buttons, are ordinary fetches. The route is kept as it
 * is: it carries its argument in a body, which is what a beacon needs, and
 * removing it would break any page still running the old code.
 *
 * This route is VIEWER AWARE, which is the difference between "close
 * my browsers" and "close everyone's browsers". Since the demo grew sticky
 * reuse and shared workspaces, more than one page can legitimately be
 * looking at one instance at the same time: the visitor's own second tab,
 * or a colleague who followed a `?workspace=` link. A release issued by
 * any one of them used to destroy the browser under all of them.
 *
 * That property now lives in the router as well: `release()` returns a
 * `ReleaseResult` and terminates only when no viewers remain, reporting
 * `outcome: 'detached'` and a `remainingViewers` count otherwise. This
 * route passes that result straight through instead of the flat
 * `{ released: true }` it used to answer with, because "released" when the
 * server actually detached and left the browser up for two other people is
 * a lie the UI would act on. `force` is never passed from here; see the
 * comment on the release call.
 *
 * The pre-check below duplicates the router's own, deliberately and
 * temporarily. `BrowserRouter`'s viewer count arrives through an injected
 * `LiveViewerPort` that `packages/server` does not wire up yet, so today
 * the router counts zero viewers and terminates unconditionally. This
 * route can see the real number, because the in-process `SessionRegistry`
 * behind `bg.sessions` is the thing that maintains it. Delete this
 * pre-check once the port is wired: at that point the router's answer is
 * both correct and one layer closer to the browser.
 *
 * The count comes from `bg.sessions` and not from `bg.router.list()`:
 * `BrowserRouter.list` returns `live: null` for every row
 * unconditionally, so its viewer count is always absent. See
 * `liveViewerCount` in lib/bgls.ts.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  if (bg.router === undefined) {
    return NextResponse.json(
      { error: { code: 'E_ROUTER_UNAVAILABLE', message: 'This gateway has no local router.' } },
      { status: 503 },
    );
  }

  // Read as text and parsed here rather than through `req.json()`:
  // `sendBeacon` sends a Blob or a string and does not always stamp
  // `application/json`, and this route still has to accept a beacon from a
  // page loaded before the release-on-pagehide behaviour was removed.
  const raw = await req.text().catch(() => '');
  let instanceId: string | null = null;
  try {
    const parsed = JSON.parse(raw) as { instanceId?: unknown };
    if (typeof parsed.instanceId === 'string') instanceId = parsed.instanceId;
  } catch {
    // Fall through to the 400 below; a malformed body is not worth a 500,
    // and if it came from a beacon there is no page left to show it to.
  }

  if (instanceId === null) {
    return NextResponse.json(
      { error: { code: 'E_MISSING_PARAM', message: 'instanceId is required in the JSON body.' } },
      { status: 400 },
    );
  }

  try {
    // null means no live session in this process at all: nothing is
    // connected, so there is nobody to take the browser away from and the
    // release goes ahead. This is the ordinary case for an instance whose
    // last tab has already gone. Otherwise the count includes the caller,
    // so "more than one" means "somebody other than me is still watching".
    const viewers = await liveViewerCount(instanceId);
    if (viewers !== null && viewers > 1) {
      return NextResponse.json({
        released: false,
        outcome: 'detached',
        reason: 'viewers_remain',
        remainingViewers: viewers,
      });
    }

    // No `force`. Everything reaching this route is one viewer asking to
    // close the browsers they are looking at, and a viewer is never
    // entitled to end a session other viewers are still in. `force` is for
    // the router's own lifecycle sweeps and for an operator, neither of
    // which is a page.
    const result = await bg.router.release(
      instanceId,
      { reason: 'user_closed', profile: 'destroy' },
      demoPrincipal(resolveOwnerId(req).ownerId),
    );
    return NextResponse.json({
      released: result.outcome === 'terminated',
      outcome: result.outcome,
      remainingViewers: result.remainingViewers,
    });
  } catch (err) {
    const e = err as { httpStatus?: number; code?: string; message?: string };
    return NextResponse.json(
      { error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Unknown error.' } },
      { status: typeof e?.httpStatus === 'number' ? e.httpStatus : 500 },
    );
  }
}
