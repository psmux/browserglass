/**
 * BrowserGlass identifier scheme: `<prefix>_<26-char Crockford base32 ULID>`.
 *
 * The ULID body is always uppercase. A lowercase body is rejected, never
 * normalised. Ids are opaque to clients and are validated by prefix at
 * every API boundary, so passing a `sessionId` where an `instanceId` is
 * expected is an argument-validation failure rather than a downstream 404.
 */

/**
 * Every id prefix BrowserGlass mints, in the order the wire protocol and
 * domain model reference them. `tkt` (ticket) and `inv` (invite) are part of
 * the canonical table too.
 */
export type IdPrefix =
  | 'ten'
  | 'app'
  | 'key'
  | 'nod'
  | 'pol'
  | 'bsp'
  | 'prf'
  | 'tpl'
  | 'plse'
  | 'inst'
  | 'tgt'
  | 'sess'
  | 'strm'
  | 'vwr'
  | 'att'
  | 'lse'
  | 'evt'
  | 'jti'
  | 'rsm'
  | 'snp'
  | 'rec'
  | 'tkt'
  | 'inv';

/**
 * All valid {@link IdPrefix} values, in the same order as the union, for
 * runtime membership checks and regex construction.
 */
export const ID_PREFIXES: readonly IdPrefix[] = Object.freeze([
  'ten',
  'app',
  'key',
  'nod',
  'pol',
  'bsp',
  'prf',
  'tpl',
  'plse',
  'inst',
  'tgt',
  'sess',
  'strm',
  'vwr',
  'att',
  'lse',
  'evt',
  'jti',
  'rsm',
  'snp',
  'rec',
  'tkt',
  'inv',
]);

/**
 * Validates the full shape of a BrowserGlass id: `<prefix>_` followed by a
 * 26-character Crockford base32 ULID body, uppercase only. The first ULID
 * character is constrained to `0` to `7`, which is a structural property
 * of encoding a 48-bit timestamp into 10 base32 characters.
 */
export const ID_RE =
  /^(ten|app|key|nod|pol|bsp|prf|tpl|plse|inst|tgt|sess|strm|vwr|att|lse|evt|jti|rsm|snp|rec|tkt|inv)_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

/**
 * A branded string type scoping a plain `string` id to one {@link IdPrefix}.
 * The brand is compile-time only; at runtime a branded id is an ordinary
 * string and can be passed anywhere a `string` is expected.
 */
export type Id<P extends IdPrefix> = string & { readonly __bglsIdPrefix?: P };

/** Branded id for a `ten_` tenant. */
export type TenantId = Id<'ten'>;
/** Branded id for an `app_` App. */
export type AppId = Id<'app'>;
/** Branded id for a `key_` App signing key. */
export type AppKeyId = Id<'key'>;
/** Branded id for a `nod_` node. */
export type NodeId = Id<'nod'>;
/** Branded id for a `pol_` policy. */
export type PolicyId = Id<'pol'>;
/** Branded id for a `bsp_` BrowserSpec. */
export type BrowserSpecId = Id<'bsp'>;
/** Branded id for a `prf_` profile. */
export type ProfileId = Id<'prf'>;
/** Branded id for a `tpl_` profile template. */
export type TemplateId = Id<'tpl'>;
/** Branded id for a `plse_` profile lease. */
export type ProfileLeaseId = Id<'plse'>;
/** Branded id for an `inst_` browser Instance. */
export type InstanceId = Id<'inst'>;
/** Branded id for a `tgt_` Target, stable across CDP session invalidation. */
export type TargetId = Id<'tgt'>;
/** Branded id for a `sess_` Session. */
export type SessionId = Id<'sess'>;
/**
 * Branded id for a `strm_` server-internal Stream record. Never sent on the
 * wire; the wire handle for a stream is the numeric `streamId` (u16) in the
 * binary frame header instead.
 */
export type ServerStreamId = Id<'strm'>;
/** Branded id for a `vwr_` Viewer. */
export type ViewerId = Id<'vwr'>;
/** Branded id for an `att_` Attachment. */
export type AttachmentId = Id<'att'>;
/** Branded id for an `lse_` ControlLease. */
export type ControlLeaseId = Id<'lse'>;
/** Branded id for an `evt_` audit or lifecycle event. */
export type EventId = Id<'evt'>;
/** Branded id for a `jti_` JWT id used for replay detection. */
export type JtiId = Id<'jti'>;
/** Branded id for an `rsm_` resume token handle. */
export type ResumeTokenId = Id<'rsm'>;
/** Branded id for a `snp_` profile snapshot. */
export type SnapshotId = Id<'snp'>;
/** Branded id for a `rec_` recording (v2). */
export type RecordingId = Id<'rec'>;
/** Branded id for a `tkt_` single-use admission ticket. */
export type TicketId = Id<'tkt'>;
/** Branded id for an `inv_` invite. */
export type InviteId = Id<'inv'>;

/**
 * Thrown by every id and binary-frame validation routine in this package.
 * Also the class the binary frame codec throws on a truncated buffer, a
 * bad magic, or an unsupported version.
 */
export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProtocolError';
  }
}

const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/**
 * The slice of the Web Crypto API this module needs. Declared locally
 * rather than relying on the `dom` lib, which this zero-dependency package
 * does not include, since `globalThis.crypto` is present at runtime in
 * every browser and in Node 22 without it.
 */
interface MinimalCrypto {
  getRandomValues: (array: Uint8Array) => Uint8Array;
}

function bglsCrypto(): MinimalCrypto {
  return (globalThis as unknown as { crypto: MinimalCrypto }).crypto;
}

function encodeUlidTime(timeMs: number): string {
  let time = timeMs;
  let out = '';
  for (let i = 0; i < 10; i++) {
    const mod = time % 32;
    out = CROCKFORD_ALPHABET[mod] + out;
    time = (time - mod) / 32;
  }
  return out;
}

function encodeUlidRandom(): string {
  const bytes = new Uint8Array(16);
  bglsCrypto().getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += CROCKFORD_ALPHABET[(bytes[i] as number) % 32];
  }
  return out;
}

/**
 * Mints a fresh BrowserGlass id for the given prefix: `<prefix>_<ULID>`,
 * where the ULID body is 10 characters of millisecond timestamp followed by
 * 16 characters of cryptographically random data, both uppercase Crockford
 * base32. Ids are minted exactly once, at admission, never at "ready", and
 * are never reused, even after delete.
 */
export function newId<P extends IdPrefix>(prefix: P): Id<P> {
  const ulid = encodeUlidTime(Date.now()) + encodeUlidRandom();
  return `${prefix}_${ulid}` as Id<P>;
}

/**
 * Checks whether `value` is a syntactically valid BrowserGlass id of any
 * known prefix. Does not check that the id refers to anything that exists.
 */
export function isId(value: string): boolean {
  return ID_RE.test(value);
}

/**
 * Extracts and returns the {@link IdPrefix} of a syntactically valid
 * BrowserGlass id. Throws {@link ProtocolError} if `value` does not match
 * {@link ID_RE}.
 */
export function idPrefix(value: string): IdPrefix {
  const match = ID_RE.exec(value);
  if (!match) {
    throw new ProtocolError(`not a valid BrowserGlass id: ${JSON.stringify(value)}`);
  }
  return match[1] as IdPrefix;
}

/**
 * Asserts that `value` is a syntactically valid BrowserGlass id carrying
 * exactly the given `prefix`. Intended for use at every API boundary, so
 * that passing a `sessionId` where an `instanceId` is expected fails
 * immediately with a clear message rather than surfacing as a downstream
 * not-found error. Throws {@link ProtocolError} on any mismatch.
 */
export function assertId<P extends IdPrefix>(prefix: P, value: string): asserts value is Id<P> {
  const match = ID_RE.exec(value);
  if (!match || match[1] !== prefix) {
    throw new ProtocolError(`expected id with prefix '${prefix}', got: ${JSON.stringify(value)}`);
  }
}
