import { describe, expect, it } from 'vitest';
import {
  ID_PREFIXES,
  ID_RE,
  ProtocolError,
  assertId,
  idPrefix,
  isId,
  newId,
} from '../../src/wire/ids.js';

describe('ids', () => {
  it('mints an id matching ID_RE for every prefix', () => {
    for (const prefix of ID_PREFIXES) {
      const id = newId(prefix);
      expect(id).toMatch(ID_RE);
      expect(isId(id)).toBe(true);
      expect(idPrefix(id)).toBe(prefix);
    }
  });

  it('mints 23 known prefixes, including tkt and inv', () => {
    expect(ID_PREFIXES.length).toBe(23);
    expect(ID_PREFIXES).toContain('tkt');
    expect(ID_PREFIXES).toContain('inv');
  });

  it('rejects a lowercased ULID body without normalising it', () => {
    const id = newId('sess');
    const lowered = id.toLowerCase();
    expect(isId(lowered)).toBe(false);
  });

  it('rejects a syntactically invalid id', () => {
    expect(isId('not_an_id')).toBe(false);
    expect(isId('sess_tooshort')).toBe(false);
  });

  it('idPrefix throws ProtocolError for an invalid id', () => {
    expect(() => idPrefix('nope')).toThrow(ProtocolError);
  });

  it('assertId passes for a matching prefix and throws for a mismatched one', () => {
    const sessionId = newId('sess');
    expect(() => assertId('sess', sessionId)).not.toThrow();
    expect(() => assertId('inst', sessionId)).toThrow(ProtocolError);
  });

  it('generated ids are unique across repeated calls', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 500; i++) {
      seen.add(newId('evt'));
    }
    expect(seen.size).toBe(500);
  });
});
