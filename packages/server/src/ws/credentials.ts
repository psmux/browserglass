/**
 * Credential resolution for the `bgls.v1` handshake: the four-carrier
 * precedence, ticket redemption (Mode A) and
 * JWT verification (Modes B/C) unified into one outcome, and the
 * conflicting-credentials detection the precedence rule requires.
 *
 * None of this runs before the WS
 * handshake completes: a bad credential of any kind closes `4200` (or
 * `4104`/`4202` for version/hello problems) *after* the socket is open, it
 * never fails the HTTP upgrade. The only pre-socket HTTP failures are a
 * missing subprotocol (400), a rejected Origin (403), and shutdown phase 1
 * (503); `ws/upgrade.ts` owns those.
 */

import type { IncomingMessage } from 'node:http';
import type {
  AppId,
  AuthResolver,
  Capability,
  Principal,
  Scope,
  Store,
  TenantId,
} from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import { bearerTokenFromRequest } from '../auth/resolver.js';
import { type TicketRegistry, redeemTicket } from '../auth/tickets.js';

/** The three carriers extractable from the HTTP upgrade request itself, before any socket exists. */
export interface PreUpgradeCarriers {
  readonly headerToken: string | undefined;
  readonly subprotocolToken: string | undefined;
  readonly ticket: string | undefined;
}

/** Finds a `bgls.token.<jwt>` entry among the offered subprotocols (comma-separated, already split and trimmed by the caller). */
export function subprotocolTokenFrom(offered: readonly string[]): string | undefined {
  const prefix = 'bgls.token.';
  const entry = offered.find((p) => p.startsWith(prefix));
  return entry?.slice(prefix.length);
}

/** Extracts the three pre-socket carriers from the upgrade `req`. */
export function extractPreUpgradeCarriers(
  req: IncomingMessage,
  offeredSubprotocols: readonly string[],
): PreUpgradeCarriers {
  const url = new URL(req.url ?? '/', 'http://localhost');
  return {
    headerToken: bearerTokenFromRequest(req),
    subprotocolToken: subprotocolTokenFrom(offeredSubprotocols),
    ticket: url.searchParams.get('ticket') ?? undefined,
  };
}

/** A successfully resolved credential: enough to build a viewer and pick an Instance. */
export interface ResolvedCredential {
  readonly principal: Principal;
  readonly viewerId: string;
  readonly instanceId: string;
  readonly nodeId: string | undefined;
}

/** A rejected credential, already mapped onto a close code and wire error code. */
export interface RejectedCredential {
  readonly closeCode: number;
  readonly wireCode: string;
  readonly message: string;
}

/** The result of {@link resolveCredential}: either a {@link ResolvedCredential} or a {@link RejectedCredential}. */
export type CredentialOutcome =
  | ({ readonly ok: true } & ResolvedCredential)
  | ({ readonly ok: false } & RejectedCredential);

const TICKET_REASON_TO_WIRE: Readonly<Record<string, string>> = Object.freeze({
  invalid_ticket: 'bgls.error.auth.invalid_ticket',
  ticket_expired: 'bgls.error.auth.ticket_expired',
  origin_mismatch: 'bgls.error.auth.origin_mismatch',
  ticket_consumed: 'bgls.error.auth.ticket_consumed',
});

/**
 * Applies the four-carrier precedence (`headerToken` > `subprotocolToken` >
 * `ticket` > `helloAuthToken`) and resolves whichever carrier wins. Two
 * carriers present at once and disagreeing (different kind, or the same
 * kind with a different literal value) is `bgls.error.auth.conflicting_credentials`,
 * close `4200`.
 */
export async function resolveCredential(
  pre: PreUpgradeCarriers,
  helloAuthToken: string | undefined,
  deps: {
    readonly resolver: AuthResolver | undefined;
    readonly store: Store | undefined;
    readonly ticketRegistry: TicketRegistry;
    readonly tenantId: TenantId;
    readonly appId: AppId;
    readonly maxCaps: readonly Capability[];
    readonly origin: string;
  },
): Promise<CredentialOutcome> {
  const jwtCarriers = [pre.headerToken, pre.subprotocolToken, helloAuthToken].filter(
    (t): t is string => t !== undefined,
  );
  const distinctJwt = new Set(jwtCarriers);
  if (distinctJwt.size > 1) {
    return {
      ok: false,
      closeCode: 4200,
      wireCode: 'bgls.error.auth.conflicting_credentials',
      message: 'Conflicting credentials were presented on more than one carrier.',
    };
  }
  if (jwtCarriers.length > 0 && pre.ticket !== undefined) {
    return {
      ok: false,
      closeCode: 4200,
      wireCode: 'bgls.error.auth.conflicting_credentials',
      message: 'A ticket and a bearer token were both presented; use exactly one credential.',
    };
  }

  const chosenJwt = pre.headerToken ?? pre.subprotocolToken ?? helloAuthToken;

  if (pre.ticket !== undefined) {
    return resolveTicket(pre.ticket, deps);
  }
  if (chosenJwt !== undefined) {
    return resolveJwt(chosenJwt, deps);
  }
  return {
    ok: false,
    closeCode: 4200,
    wireCode: 'bgls.error.auth.no_credential',
    message: 'No credential was presented (no ticket, bearer token, or hello.auth).',
  };
}

async function resolveTicket(
  ticket: string,
  deps: {
    readonly store: Store | undefined;
    readonly ticketRegistry: TicketRegistry;
    readonly tenantId: TenantId;
    readonly appId: AppId;
    readonly maxCaps: readonly Capability[];
    readonly origin: string;
  },
): Promise<CredentialOutcome> {
  if (deps.store === undefined) {
    return {
      ok: false,
      closeCode: 4200,
      wireCode: 'bgls.error.auth.invalid_ticket',
      message: 'No store is configured; tickets cannot be redeemed.',
    };
  }
  const result = await redeemTicket(deps.store, deps.ticketRegistry, ticket, {
    origin: deps.origin,
    appId: deps.appId,
    tenantId: deps.tenantId,
  });
  if (!result.ok) {
    return {
      ok: false,
      closeCode: 4200,
      wireCode: TICKET_REASON_TO_WIRE[result.reason] ?? 'bgls.error.auth.invalid_ticket',
      message: `Ticket redemption failed: ${result.reason}.`,
    };
  }
  const scope: Scope = { kind: 'instance', instanceId: result.record.instanceId, targets: '*' };
  const principal: Principal = {
    tenantId: deps.tenantId,
    appId: deps.appId,
    sub: result.record.viewerId,
    subKind: 'user',
    caps: [...deps.maxCaps],
    scope,
    jti: result.ticketId,
    exp: Math.floor(result.record.expiresAt / 1000),
  };
  return {
    ok: true,
    principal,
    viewerId: result.record.viewerId,
    instanceId: result.record.instanceId,
    nodeId: result.record.nodeId,
  };
}

async function resolveJwt(
  token: string,
  deps: { readonly resolver: AuthResolver | undefined; readonly origin: string },
): Promise<CredentialOutcome> {
  if (deps.resolver === undefined) {
    return {
      ok: false,
      closeCode: 4200,
      wireCode: 'bgls.error.auth.no_credential',
      message: 'No AuthResolver is configured.',
    };
  }
  const result = await deps.resolver.verify(token, { origin: deps.origin });
  if (!isPrincipal(result)) {
    return {
      ok: false,
      closeCode: result.closeCode ?? 4200,
      wireCode: mapAuthRejectionCode(result.code),
      message: result.message,
    };
  }
  if (result.scope.kind !== 'instance' && result.scope.kind !== 'stream') {
    return {
      ok: false,
      closeCode: 4202,
      wireCode: 'bgls.error.protocol.bad_envelope',
      message:
        'A WS connection needs an instance- or stream-scoped token (no target Instance to attach to).',
    };
  }
  return {
    ok: true,
    principal: result,
    viewerId: newId('vwr'),
    instanceId: result.scope.instanceId,
    nodeId: undefined,
  };
}

function isPrincipal(
  value:
    | Principal
    | { readonly code: string; readonly message: string; readonly closeCode?: number },
): value is Principal {
  return (
    typeof (value as Principal).sub === 'string' &&
    typeof (value as Principal).tenantId === 'string'
  );
}

function mapAuthRejectionCode(code: string): string {
  if (code === 'E_TOKEN_EXPIRED') return 'bgls.error.auth.expired';
  return 'bgls.error.auth.token_invalid';
}
