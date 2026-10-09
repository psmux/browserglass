import {
  ID_RE,
  type IdPrefix,
  ProtocolError,
  assertId,
  idPrefix,
  isId,
  newId,
} from '@browserglass/protocol';
/**
 * Id generation and validation conformance:
 * format `<prefix>_<26-char Crockford base32 ULID>`, uppercase body,
 * lowercase rejected and never normalised, validated by prefix at every
 * API boundary.
 */
import { describe, expect, it } from 'vitest';

/** The 23 canonical prefixes. */
const ID_PREFIXES: readonly IdPrefix[] = [
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
];

describe('id scheme: generation and validation', () => {
  it('newId() produces exactly 23 distinct, well formed ids, one per prefix', () => {
    expect(ID_PREFIXES).toHaveLength(23);
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id).toMatch(ID_RE);
      expect(isId(id)).toBe(true);
      expect(idPrefix(id)).toBe(prefix);
    }
  });

  it('every generated id round trips through assertId for its own prefix without throwing', () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(() => assertId(prefix, id)).not.toThrow();
    }
  });

  it('assertId throws when the prefix does not match', () => {
    const tenantId = newId('ten');
    expect(() => assertId('app', tenantId)).toThrow(ProtocolError);
  });

  it('case sensitivity: a lowercased ULID body is rejected, never normalised', () => {
    const id = newId('ten');
    const lowered = id.toLowerCase();
    expect(lowered).not.toBe(id);
    expect(isId(lowered)).toBe(false);
    expect(ID_RE.test(lowered)).toBe(false);
    expect(() => assertId('ten', lowered as never)).toThrow(ProtocolError);
  });

  it('case sensitivity: an uppercased prefix is rejected (prefixes are lowercase only)', () => {
    const id = newId('ten');
    const upperPrefix = id.replace(/^ten/, 'TEN');
    expect(isId(upperPrefix)).toBe(false);
  });

  it('idPrefix throws ProtocolError for a string with no matching prefix', () => {
    expect(() => idPrefix('not_a_real_id')).toThrow(ProtocolError);
    expect(() => idPrefix('')).toThrow(ProtocolError);
  });

  it('isId is false for a well formed id from an unknown prefix', () => {
    expect(isId('xyz_00000000000000000000000000')).toBe(false);
  });

  it('isId is false for a ULID body containing the excluded Crockford letters I, L, O, U', () => {
    // Crockford base32 excludes I, L, O, U to avoid visual ambiguity with
    // 1, 1, 0, and V; ID_RE's own character class enforces this.
    for (const bad of ['I', 'L', 'O', 'U']) {
      const body = bad + '0'.repeat(25);
      expect(body).toHaveLength(26);
      expect(ID_RE.test(`ten_${body}`)).toBe(false);
    }
  });

  it('the ULID body is fixed at 26 characters: one short or one long is rejected', () => {
    const id = newId('ten');
    const [prefix, body] = id.split('_') as [string, string];
    expect(body).toHaveLength(26);
    expect(isId(`${prefix}_${body.slice(0, 25)}`)).toBe(false);
    expect(isId(`${prefix}_${body}A`)).toBe(false);
  });

  it('two ids minted back to back for the same prefix are never equal', () => {
    const a = newId('sess');
    const b = newId('sess');
    expect(a).not.toBe(b);
  });
});
