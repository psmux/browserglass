import type { Capability } from './capabilities.js';
import type { QualityProfile } from './messages/streams.js';

/**
 * What a token may attach to. Four kinds, narrowing left to right:
 * `tenant > pool > instance > stream`. Checked at handshake and again
 * whenever a viewer reaches for something new.
 */
export type Scope =
  | { kind: 'tenant' }
  | { kind: 'pool'; poolId: string; maxInstances: number }
  | { kind: 'instance'; instanceId: string; targets: '*' | string[]; sessionId?: string }
  | { kind: 'stream'; instanceId: string; targets: string[]; qualityCeiling?: QualityProfile };

/**
 * Per-token policy overrides. Always a narrowing, never a widening, of
 * tenant and pool policy.
 */
export interface TokenPolicyOverrides {
  urlAllow?: string[];
  urlDeny?: string[];
  maxSessionSec?: number;
  maxIdleSec?: number;
  downloadMaxBytes?: number;
  clipboardMaxBytes?: number;
  qualityCeiling?: QualityProfile;
}

/** Present on invite-derived tokens. Delegation depth is 1: a token carrying `del` cannot itself create an invite. */
export interface DelegationClaim {
  inviteId: string;
  by: string;
  at: number;
  depth: number;
}

/** RFC 8693 actor claim: present when a service acts on behalf of `sub`. */
export interface ActorClaim {
  sub: string;
}

/**
 * The full BrowserGlass App JWT claim set. `typ` in the
 * JWT header is `bgls+jwt`, never `JWT`; verification rejects any other
 * `typ`.
 */
export interface BglsClaims {
  /** Equals `aid`; present for JWT convention. */
  iss: string;
  /** `app_` + 26-char ULID. The App that signed this token. */
  aid: string;
  /** `ten_` + 26-char ULID. Every resource this token touches must carry this tenant id. */
  tid: string;
  /** Stable identifier of the acting party, opaque to BrowserGlass. 1 to 128 bytes UTF-8. */
  sub: string;
  /** Advisory, default `'user'`. */
  sub_kind?: 'user' | 'agent' | 'guest' | 'service';
  /** Display name in the presence roster. Untrusted, HTML-escaped at render. 1 to 64 bytes. */
  name?: string;
  /** {@link MIN_CAPS} to {@link MAX_CAPS} entries, from the canonical {@link Capability} list, sorted, no duplicates. */
  caps: Capability[];
  scope: Scope;
  /** Seconds, within 60s of server time. */
  iat: number;
  /** Seconds, default `iat`. */
  nbf?: number;
  /** Seconds. `exp - iat <= 900` regardless of what the app requested. */
  exp: number;
  /** 16 to 64 chars, unique per app. Replay detection plus audit correlation. */
  jti: string;
  /** Whether refreshable over the socket. `false` means a one-shot token. Default true. */
  rfr?: boolean;
  /** Seconds. Absolute deadline past which no refresh is granted regardless of `rfr`. */
  rfr_until?: number;
  pol?: TokenPolicyOverrides;
  del?: DelegationClaim;
  act?: ActorClaim;
}

/** The resolved identity behind a validated connection, produced by an {@link AuthResolver}. */
export interface Principal {
  tenantId: string;
  appId: string;
  sub: string;
  subKind: 'user' | 'agent' | 'guest' | 'service';
  name?: string;
  /** The effective capability set: `token.caps ∩ app.max_caps ∩ tenant.allowed_caps`. */
  caps: Capability[];
  scope: Scope;
  jti: string;
  /** Seconds, Unix epoch. */
  exp: number;
}

/** Connection-level context available to an {@link AuthResolver}, independent of any framework's request object. */
export interface AuthContext {
  remoteAddress?: string;
  forwardedFor?: string;
  origin?: string;
  userAgent?: string;
}

/** A structured auth failure, distinct from throwing, so an {@link AuthResolver} can name a specific wire error and close code. */
export interface AuthRejection {
  /** A `bgls.error.auth.*` or `bgls.error.cap.*` wire code. */
  code: string;
  message: string;
  /** The close code the caller should use, when the rejection is connection-fatal. */
  closeCode?: number;
}

/**
 * The extension point an app supplies to verify credentials and, for
 * refreshable tokens, to re-verify one presented over an open socket
 * (`hello { reauth: true }`). `refresh` is the server-side hook for that
 * `hello reauth:true` message; there is no separate `auth.refresh` wire
 * message.
 */
export interface AuthResolver {
  verify(token: string, ctx: AuthContext): Promise<Principal | AuthRejection>;
  refresh?(ctx: AuthContext, token: string): Promise<Principal | AuthRejection>;
}

/**
 * The connection ticket: an opaque, single-use handle exchanged at the WS
 * upgrade for a session token. Format `tkt_<ULID>.<32-byte base64url
 * random>`, NOT a JWT. Distinct from {@link AttachTicket}, the
 * MAC'd, node-bound, epoch-fenced handle for the (deferred) direct-attach
 * data plane: two types, two names, both kept.
 */
export interface Ticket {
  ticketId: string;
  tenantId: string;
  appId: string;
  sessionId?: string;
  instanceId?: string;
  /** The `Origin` this ticket was issued for. */
  originBinding: string;
  /** Set only when `auth.bindTicketToIp` is enabled. */
  ipPrefixBinding?: string;
  issuedAt: number;
  expiresAt: number;
}

/**
 * The attach ticket for the direct-attach data plane (frames and
 * input bypassing the gateway, straight to a node). DEFERRED for now:
 * typed here, unimplemented, because single-node embedded has no
 * node boundary (the gateway *is* the node).
 */
export interface AttachTicket {
  /** `tkt_` + 26-char ULID. */
  ticketId: string;
  /** HMAC-SHA256 over the canonical serialisation, keyed by the node's registration secret. */
  mac: string;

  tenantId: string;
  appId: string;
  sub: string;
  /** Pre-allocated by the gateway. */
  viewerId: string;
  sessionId: string;
  instanceId: string;
  /** Fencing: which node may redeem this. */
  nodeId: string;
  /** Fencing: the instance generation counter. */
  epoch: number;

  caps: string[];
  targets: string[] | '*';
  qualityCeiling?: QualityProfile;

  /** Epoch ms. */
  issuedAt: number;
  /** Epoch ms, `issuedAt + 30000` by default. */
  expiresAt: number;
  /** 128 bits, base64url. */
  nonce: string;
}

/**
 * The per-gateway-process `jti` replay cache. Default
 * capacity 200,000 entries. Eviction under pressure is fail-open by
 * design (fail-closed would be a DoS vector).
 */
export interface JtiCache {
  /** Returns false if this `jti` was already seen and is still within its window. */
  admit(aid: string, jti: string, expSec: number): boolean;
  size(): number;
}
