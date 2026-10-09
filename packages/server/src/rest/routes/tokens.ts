import { type Capability, ROLE_BUNDLES } from '@browserglass/protocol';
import type { IssueTokenRequest } from '../../auth/types.js';
import { compact } from '../../util/compact.js';
import { RestError, writeJson } from '../errors.js';
import type { RestHandler } from '../types.js';

/**
 * `POST /v1/tokens`, capability `admin` (`rest/router.ts`'s route table).
 * Mints a scoped access token for `body.sub`/`body.scope`, clamped so an
 * admitted caller can only ever hand out a capability, tenant, or app it
 * already holds itself.
 *
 * SECURITY, two independent gates, not one. `capability: 'admin'` on the
 * route table decides WHO may reach this handler at all. Everything below
 * decides WHAT an admitted caller may mint, and is load bearing on its
 * own: `capabilities.ts`'s own rule is "deny by default... `admin` does
 * not imply `view`", so holding `admin` is authority to operate sessions
 * and leases, never a blank cheque to grant a capability the caller does
 * not itself carry. Before this fix the route was `capability: null`
 * (resolves a Principal but skips the membership check, `router.ts`'s own
 * `dispatchRest`) and forwarded `rctx.body` to `ctx.tokens.issueWithMeta`
 * untouched, which clamps only against server wide
 * `auth.maxCaps`/`tenantAllowedCaps` (`ALL_CAPABILITIES` by default,
 * `config/resolve.ts`) and reads `tenantId`/`appId` from the body: any
 * bearer of any valid token, `view` only included, could mint itself
 * `admin`/`cdp`/`evaluate` for an arbitrary tenant (found in a security
 * audit).
 *
 * `bg.tokens.issueWithMeta` itself (the in-process `bg.tokens` SDK
 * surface `TokenApiImpl` implements) stays deliberately unbounded: that
 * is how the embedding host mints its OWN first, broad credential
 * (typically `role: 'owner'`), which is exactly the token this route then
 * lets it use, over the network, to mint narrower ones for end users. The
 * clamp belongs at this REST edge, never in `TokenApiImpl` itself.
 *
 * Both the `role` and the explicit `caps` paths are resolved to a plain
 * `Capability[]` and clamped BEFORE `issueWithMeta` ever sees them, and
 * `role` is never forwarded: passing it through unclamped would let
 * `issueWithMeta` re-expand the full bundle behind this clamp's back,
 * which is precisely the "role handling becomes the bypass" case the
 * audit named. `tenantId`/`appId` are likewise always taken from
 * `rctx.principal`, never `body`, closing the cross-tenant half of the
 * same hole.
 */
export const issueToken: RestHandler = async (ctx, rctx) => {
  const body = rctx.body as IssueTokenRequest | undefined;
  if (body === undefined || typeof body.sub !== 'string' || body.scope === undefined) {
    throw new RestError(400, 'E_MISSING_PARAM', 'sub and scope are required.');
  }

  let requested: readonly Capability[];
  if (body.role !== undefined) {
    const bundle = ROLE_BUNDLES[body.role];
    if (bundle === undefined) {
      throw new RestError(400, 'E_ROLE_UNKNOWN', `"${body.role}" is not a known role bundle.`);
    }
    requested = bundle;
  } else {
    requested = body.caps ?? [];
  }
  const callerCaps = new Set(rctx.principal.caps);
  const caps = requested.filter((cap) => callerCaps.has(cap));

  try {
    const issued = await ctx.tokens.issueWithMeta({
      sub: body.sub,
      caps,
      scope: body.scope,
      tenantId: rctx.principal.tenantId,
      appId: rctx.principal.appId,
      // `compact`: `IssueTokenRequest`'s remaining fields are all optional
      // with `exactOptionalPropertyTypes` on, which rejects an explicit
      // `undefined` for an unset one rather than treating it as "omitted".
      ...compact({
        iUnderstandAdmin: body.iUnderstandAdmin,
        subKind: body.subKind,
        name: body.name,
        ttlSeconds: body.ttlSeconds,
        refreshable: body.refreshable,
        refreshUntil: body.refreshUntil,
        policy: body.policy,
        metadata: body.metadata,
      }),
    });
    writeJson(rctx.res, rctx.requestId, issued, 201);
  } catch (err) {
    const code =
      err instanceof Error && 'code' in err
        ? String((err as { code: unknown }).code)
        : 'E_TOKEN_ISSUE_FAILED';
    throw new RestError(400, code, err instanceof Error ? err.message : 'Token issuance failed.');
  }
};
