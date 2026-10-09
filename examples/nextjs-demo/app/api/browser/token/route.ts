import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_CAPS, getBg, resolveOwnerId, setOwnerCookie } from '../../../../lib/bgls';

/**
 * Refreshes the credential for an already acquired instance. Required
 * because the token minted by `POST /api/browser` expires in 120 seconds
 * (`ttlSeconds`, the token lifetime, is the revocation mechanism: stop
 * refreshing and access ends within two minutes); `<BrowserGlass
 * onTicketExpired>` (wired through `useBrowserGlass`'s `credentials`
 * option in `app/browser/page.tsx`) calls this on every expiry, forever,
 * for as long as the tab stays open.
 *
 * `sub` is the visitor's own owner id (`resolveOwnerId`), the same one
 * `POST /api/browser` minted the first token with, rather than the single
 * shared constant this demo used before it had an ownership model. It
 * stays the personal id even when the instance belongs to a shared
 * workspace: the token says who is connecting, not which browsers they
 * are connecting to.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  const body = (await req.json().catch(() => ({}))) as {
    instanceId?: unknown;
    sessionId?: unknown;
  };
  const instanceId = typeof body.instanceId === 'string' ? body.instanceId : undefined;
  const sessionId = typeof body.sessionId === 'string' ? body.sessionId : undefined;

  if (instanceId === undefined || sessionId === undefined) {
    return NextResponse.json(
      {
        error: { code: 'E_MISSING_PARAM', message: 'instanceId and sessionId are both required.' },
      },
      { status: 400 },
    );
  }

  const identity = resolveOwnerId(req);

  try {
    const issued = await bg.tokens.issueWithMeta({
      sub: identity.ownerId,
      caps: DEMO_CAPS,
      scope: { kind: 'instance', instanceId, targets: '*', sessionId },
      ttlSeconds: 120,
    });
    return setOwnerCookie(
      NextResponse.json({ token: issued.token, caps: issued.caps, expiresAt: issued.expiresAt }),
      identity,
    );
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return NextResponse.json(
      { error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Unknown error.' } },
      { status: 500 },
    );
  }
}
