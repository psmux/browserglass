/**
 * The ephemeral Ed25519 signing key `bgls serve` generates for its `dev`
 * auth mode, and the local (no network round trip) minting helper the CLI
 * itself uses to authenticate its own REST calls against a gateway it (or
 * a sibling `bgls serve` invocation) started. Local development only.
 */

import { CAPABILITIES, type Capability } from '@browserglass/protocol';
import { InProcessJtiCache, TokenApiImpl, generateEd25519KeyMaterial } from '@browserglass/server';

/** One Ed25519 signing key, as stored (unencrypted, dev-only) in the session file `dev-key.ts`/`session-file.ts` cooperate on. */
export interface DevSigningKey {
  readonly kid: string;
  readonly alg: 'EdDSA';
  readonly publicKey: string;
  readonly privateKey: string;
  readonly status: 'active';
}

/** Generates a fresh, dev-only Ed25519 signing key. Never used for anything the operator did not explicitly opt into via `--auth dev` (the default). */
export function generateDevSigningKey(): DevSigningKey {
  const material = generateEd25519KeyMaterial();
  return {
    kid: `dev-${Date.now().toString(36)}`,
    alg: 'EdDSA',
    publicKey: material.publicKey,
    privateKey: material.privateKey,
    status: 'active',
  };
}

/** Everything {@link mintLocalAdminToken} needs to sign a token identical in shape to one the running gateway would issue itself. */
export interface LocalMintContext {
  readonly key: DevSigningKey;
  readonly tenantId: string;
  readonly appId: string;
  readonly issuer: string;
}

/**
 * Mints a short-lived, full-capability bearer token locally, without any
 * network round trip, by signing with the same dev key the target gateway
 * was started with. This is what lets `bgls doctor`/`bgls inspect` operate
 * against a long-running `bgls serve` process after its own first-boot
 * admin token (which is capped at `auth.maxTtlSeconds`, 900s) has expired:
 * every CLI invocation mints its own fresh one from the shared key on disk.
 *
 * Default TTL is 600s, not `JTI_REPLAY_CEILING_SEC`'s own 300s boundary
 * (`packages/server/src/auth/verify.ts`): the server only jti-replay-checks
 * a token whose own lifetime is `<= 300s`, on every authenticated request
 * that presents it, REST included. `resolveGatewayConnection()`
 * (`context.ts`) mints exactly one token per command invocation and
 * `restCall()` reuses it for every REST call that invocation makes,
 * exactly as this function's own doc comment above describes ("mints its
 * own fresh one" per invocation, not per call); any command issuing more
 * than one REST call against the same connection (`instances create`
 * polling for `ready`, `inspect`'s per-session viewer lookups, `swarm
 * run`'s acquire+release sequence) would have its second call rejected
 * `E_TOKEN_REPLAYED` at exactly 300s, confirmed directly against a real
 * `bgls serve`. 600s clears that ceiling with room to spare while staying
 * well under the 900s hard cap `maxTtlSeconds` enforces below.
 */
export async function mintLocalAdminToken(
  ctx: LocalMintContext,
  opts?: { readonly ttlSeconds?: number },
): Promise<string> {
  const jtiCache = new InProcessJtiCache(1000);
  const allCaps: readonly Capability[] = CAPABILITIES;
  const tokens = new TokenApiImpl({
    keys: [ctx.key],
    defaultTtlSeconds: opts?.ttlSeconds ?? 600,
    maxTtlSeconds: 900,
    maxCaps: allCaps,
    tenantAllowedCaps: allCaps,
    clock: { now: () => Date.now() },
    tenantId: ctx.tenantId,
    appId: ctx.appId,
    issuer: ctx.issuer,
    clockSkewSeconds: 30,
    jtiCache,
  });
  return tokens.issue({
    sub: 'bgls-cli',
    subKind: 'service',
    scope: { kind: 'tenant' },
    role: 'owner',
    iUnderstandAdmin: true,
    ttlSeconds: opts?.ttlSeconds ?? 600,
  });
}
