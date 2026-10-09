import { CloseCode, VersionNegotiationError, negotiateVersion } from '@browserglass/protocol';
/**
 * Version negotiation conformance: `negotiateVersion(offered, minAccept, supported)`.
 *
 * The algorithm (`packages/protocol/src/wire/version.ts`):
 *   chosen = first v in offered where v is in supported
 *   if chosen is undefined:
 *       chosen = max(v in supported where v <= max(offered) and v >= minAccept)
 *   if chosen is undefined: throw (close 4104 IncompatibleVersion)
 *
 * Two consequences worth asserting explicitly, since they are easy to get
 * wrong reading the doc's prose alone: phase one is a membership scan
 * over `offered` in the client's own preference order, so `minAccept`
 * never blocks a version the client both offered and the server directly
 * supports; and `downgraded` compares `chosen` against `offered[0]`
 * (the client's top preference), not against the server's own maximum,
 * so a client that only ever offers one version is never reported as
 * downgraded even when the server could have gone higher.
 *
 * There is no exported `SUPPORTED_VERSIONS` constant; negotiation is
 * entirely caller supplied. This build's real matrix is version 1 only;
 * the synthetic two-version rows below prove the algorithm's downgrade
 * and rejection paths hold in general, ahead of a second version ever
 * shipping.
 */
import { describe, expect, it } from 'vitest';

describe('version negotiation: full compatibility matrix', () => {
  it('client offers [1], server supports [1]: chosen 1, not downgraded', () => {
    expect(negotiateVersion([1], 1, [1])).toEqual({ chosen: 1, downgraded: false });
  });

  it('an empty offered list throws rather than silently picking a version', () => {
    expect(() => negotiateVersion([], 1, [1])).toThrow(VersionNegotiationError);
  });

  it('server supports only versions newer than every offered version: throws with the 4104 close code', () => {
    let threw: unknown;
    try {
      negotiateVersion([1], 1, [2]);
    } catch (err) {
      threw = err;
    }
    expect(threw).toBeInstanceOf(VersionNegotiationError);
    expect((threw as VersionNegotiationError).closeCode).toBe(CloseCode.IncompatibleVersion);
    expect((threw as VersionNegotiationError).wireCode).toBe('bgls.error.version.unsupported');
  });

  it('minAccept excludes every fallback candidate: throws even though the server supports lower versions', () => {
    // offered=[5] is not itself in supported (phase one fails); the
    // fallback would consider {1,2,3} <= 5, but minAccept=10 excludes
    // all of them, so nothing remains.
    expect(() => negotiateVersion([5], 10, [1, 2, 3])).toThrow(VersionNegotiationError);
  });

  it('the server-supported set is carried on the thrown error for a client to report accurately', () => {
    try {
      negotiateVersion([1], 1, [2]);
      expect.unreachable('expected VersionNegotiationError');
    } catch (err) {
      expect(err).toBeInstanceOf(VersionNegotiationError);
      expect((err as VersionNegotiationError).serverVersions).toEqual([2]);
    }
  });

  describe('a synthetic future two-version matrix (server supports [2, 1])', () => {
    it('a client offering [2, 1] gets its own top preference, 2, not downgraded', () => {
      const result = negotiateVersion([2, 1], 1, [2, 1]);
      expect(result).toEqual({ chosen: 2, downgraded: false });
    });

    it('a client offering only [1] gets exactly 1 and is NOT marked downgraded, even though the server supports 2: phase one is a direct membership match, minAccept and "the server could have gone higher" never enter it', () => {
      const result = negotiateVersion([1], 1, [2, 1]);
      expect(result).toEqual({ chosen: 1, downgraded: false });
    });

    it('a client offering [3, 1] (an unsupported top preference plus a supported fallback in its own list) is downgraded to 1, found via the phase-one scan, not the numeric fallback', () => {
      const result = negotiateVersion([3, 1], 1, [1]);
      expect(result).toEqual({ chosen: 1, downgraded: true });
    });

    it('a client offering [5] alone, with nothing in offered directly supported, is downgraded via the numeric fallback to the highest eligible supported version', () => {
      const result = negotiateVersion([5], 1, [2, 1]);
      expect(result).toEqual({ chosen: 2, downgraded: true });
    });
  });
});
