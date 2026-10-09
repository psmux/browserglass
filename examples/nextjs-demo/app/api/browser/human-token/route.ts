import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_CAPS, getBg, resolveOwnerId } from '../../../../lib/bgls';

/**
 * Mints a token with NO `automation` capability, scoped to one instance,
 * standing in for a genuine human viewer.
 *
 * Deliberately its own route rather than reusing `POST /api/browser/token`:
 * `DEMO_CAPS` (`lib/bgls.ts`) carries `automation` (needed for the demo's
 * own in-page agent feature), and `ws/connection.ts`'s `viewerIdentity()`
 * derives `kind` from that single bit (`this.granted.has('automation') ?
 * 'agent' : 'human'`, `docs/agent-and-human.md`'s own documented rule).
 * Every token this demo otherwise mints (`token`, `bootstrap-token`, and
 * `cdp-token` plus `automation`) therefore registers as `kind: 'agent'` on
 * the presence roster and, more importantly, at `DEFAULT_PRIORITY.agent`
 * (50) rather than `.human` (100): two `kind: 'agent'` holders never
 * preempt each other on priority alone (`EXCLUSIVE_POLICY.onRequestHeld`,
 * `packages/core/src/control/policies.ts`), so a scenario that needs an
 * ACTUAL human outranking an agent (`cdp-collab-probe.mjs`, proving a raw
 * CDP client's lease is preempted when a person takes over) cannot be
 * built from any of this demo's other token routes.
 *
 * `caps` is `DEMO_CAPS` minus `automation`, not a hand written list, so
 * this route only ever diverges from the demo's own ordinary human-facing
 * grant by the one bit that defines "human" at all.
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
  const humanCaps = DEMO_CAPS.filter((cap) => cap !== 'automation');

  try {
    const issued = await bg.tokens.issueWithMeta({
      sub: identity.ownerId,
      caps: humanCaps,
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
