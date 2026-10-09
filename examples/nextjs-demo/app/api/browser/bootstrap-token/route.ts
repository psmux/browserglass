import { type NextRequest, NextResponse } from 'next/server';
import { DEMO_CAPS, getBg } from '../../../../lib/bgls';

/**
 * Mints an App-level REST bearer token: the credential `RestClient`
 * (`clients/python/src/browserglass/rest.py`, `packages/automation`'s
 * TypeScript equivalent) sends as `Authorization: Bearer <token>` on
 * every `POST /v1/instances`, `DELETE /v1/instances/:id`, and
 * `POST /v1/instances/:id/attach` call.
 *
 * This route exists ONLY because this demo has no other way to hand one
 * out. `POST /v1/tokens` (`packages/server/src/rest/routes/tokens.ts`) is
 * the real, general purpose way to mint one, but it needs an ALREADY
 * resolved principal (`dispatchRest`'s `principalFor`), i.e. it mints a
 * token FOR a caller who already has one: a real deployment breaks that
 * circularity by provisioning its first App token out of band (an
 * operator's own key management, `bg.tokens.issue()` called from trusted
 * server code, or a secrets manager), never over an unauthenticated HTTP
 * route. This demo's signing key is freshly generated on every
 * `node server.mjs` start (`generateEd25519KeyMaterial()`, `server.mjs`)
 * rather than persisted, so there is no key an external script could
 * import to mint its own token offline either.
 *
 * Exists specifically so `clients/python/examples/quickstart_probe.py`
 * (and any other REST-only caller: curl, a fresh Python session with no
 * prior credential) can obtain the one thing the documented quickstart
 * assumes it already has (`APP_TOKEN` in `clients/python/README.md`)
 * without reading this demo's source or importing `@browserglass/server`
 * directly. `caps` intentionally does NOT include `admin`: the whole
 * point of the fix this route supports is that `RestClient.acquire()`
 * plus `AutomationClient.connect()` works with an ordinary, non-elevated
 * token, exactly as documented.
 */
export async function GET(_req: NextRequest): Promise<NextResponse> {
  const bg = getBg();
  try {
    const issued = await bg.tokens.issueWithMeta({
      sub: 'quickstart-probe',
      subKind: 'agent',
      caps: [...DEMO_CAPS, 'instance.create', 'instance.destroy'],
      scope: { kind: 'tenant' },
      // 900s: this demo's own `auth.maxTtlSeconds` ceiling
      // (`resolveConfig`'s default), not a value chosen for this route.
      ttlSeconds: 900,
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
