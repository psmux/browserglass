import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_CAPS, getBg, resolveOwnerId } from '../../../../lib/bgls';

/**
 * Mints a token carrying the `cdp` capability, scoped to one instance, for
 * the raw CDP WebSocket attach proxy (`packages/server/src/ws/cdp-upgrade.ts`).
 *
 * Deliberately its own route rather than adding `cdp` to `DEMO_CAPS`
 * (`lib/bgls.ts`): `DEMO_CAPS` is what every ordinary visitor's token
 * carries, and `cdp` is the escape hatch that hands a caller Chrome's real,
 * unfiltered DevTools Protocol (`SecurityConfig.cdpProxyEnabled`'s own doc
 * comment). Granting it to every browser tab that loads this demo would
 * defeat the entire point of it being off by default; this route exists
 * only for `cdp-attach-probe.mjs`; nothing in the demo's own UI calls it.
 *
 * Body: `{ instanceId: string, sessionId: string }`, matching
 * `app/api/browser/token/route.ts`'s own shape exactly, since both mint a
 * token for an instance `POST /api/browser` already acquired.
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
      caps: [...DEMO_CAPS, 'cdp'],
      scope: { kind: 'instance', instanceId, targets: '*', sessionId },
      ttlSeconds: 120,
    });
    return NextResponse.json({
      token: issued.token,
      caps: issued.caps,
      expiresAt: issued.expiresAt,
    });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    return NextResponse.json(
      { error: { code: e?.code ?? 'E_INTERNAL', message: e?.message ?? 'Unknown error.' } },
      { status: 500 },
    );
  }
}
