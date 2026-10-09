import { describe, expect, it } from 'vitest';
import { CloseCode } from '../../src/wire/close-codes.js';
import { VersionNegotiationError, negotiateVersion } from '../../src/wire/version.js';

describe('negotiateVersion', () => {
  it('v1 client, v1 server: normal', () => {
    expect(negotiateVersion([1], 1, [1])).toEqual({ chosen: 1, downgraded: false });
  });

  it('v1 client, v2 server that still supports v1: chosen 1, downgraded false (client only ever offered 1)', () => {
    expect(negotiateVersion([1], 1, [2, 1])).toEqual({ chosen: 1, downgraded: false });
  });

  it('v2 preferred client, v1-only server: downgrades to 1 with downgraded:true', () => {
    expect(negotiateVersion([2, 1], 1, [1])).toEqual({ chosen: 1, downgraded: true });
  });

  it('v2-only client (minVersion 2) against a v1-only server: throws', () => {
    expect(() => negotiateVersion([2], 2, [1])).toThrow(VersionNegotiationError);
  });

  it('the thrown error carries the 4104 close code and the wire error code', () => {
    try {
      negotiateVersion([2], 2, [1]);
      throw new Error('expected negotiateVersion to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionNegotiationError);
      const e = err as VersionNegotiationError;
      expect(e.closeCode).toBe(CloseCode.IncompatibleVersion);
      expect(e.wireCode).toBe('bgls.error.version.unsupported');
      expect(e.serverVersions).toEqual([1]);
    }
  });

  it('throws when the client offers no versions at all', () => {
    expect(() => negotiateVersion([], 1, [1])).toThrow(VersionNegotiationError);
  });

  it('falls back to the highest supported version within [minAccept, max(offered)] when no offered version is directly supported', () => {
    // Client only offers 3 (none of which the server supports directly);
    // server supports 2 and 1. Step 1 finds no match, so step 2 picks the
    // highest in-range supported version.
    expect(negotiateVersion([3], 1, [2, 1])).toEqual({ chosen: 2, downgraded: true });
  });
});
