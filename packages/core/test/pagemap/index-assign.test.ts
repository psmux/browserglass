/**
 * `pagemap/index-assign.ts`.
 *
 * Pure functions, no CDP bridge needed: this file exercises the epoch mint,
 * the freshness check, the stale-epoch guard, and the trivial index
 * identity function directly.
 */

import { describe, expect, it } from 'vitest';
import type { CdpSessionId } from '../../src/cdp/types.js';
import {
  PageMapStaleEpochError,
  assertFreshEpoch,
  isFreshEpoch,
  mintPageMapEpoch,
  pageMapIndexOf,
} from '../../src/pagemap/index-assign.js';

const SESSION_A = 'sess-a' as CdpSessionId;
const SESSION_B = 'sess-b' as CdpSessionId;

describe('pageMapIndexOf', () => {
  it('is the identity function on backendNodeId', () => {
    expect(pageMapIndexOf(42)).toBe(42);
    expect(pageMapIndexOf(0)).toBe(0);
  });
});

describe('mintPageMapEpoch', () => {
  it('mints the same epoch for the same session and loaderId', () => {
    const a = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    const b = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    expect(a).toBe(b);
  });

  it('mints a different epoch when the loaderId changes (a navigation)', () => {
    const before = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    const after = mintPageMapEpoch(SESSION_A, 'LOADER_2');
    expect(before).not.toBe(after);
  });

  it('mints a different epoch when the session changes, even against the same loaderId', () => {
    const a = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    const b = mintPageMapEpoch(SESSION_B, 'LOADER_1');
    expect(a).not.toBe(b);
  });

  it('still mints a usable, session-varying epoch when loaderId is null', () => {
    const a = mintPageMapEpoch(SESSION_A, null);
    const b = mintPageMapEpoch(SESSION_B, null);
    expect(a).not.toBe(b);
    expect(typeof a).toBe('string');
  });
});

describe('epoch staleness is detectable before any action', () => {
  it('isFreshEpoch is true for a matching pair and false for a mismatched one', () => {
    const current = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    const requested = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    expect(isFreshEpoch(current, requested)).toBe(true);

    const staleRequested = mintPageMapEpoch(SESSION_A, 'LOADER_0');
    expect(isFreshEpoch(current, staleRequested)).toBe(false);
  });

  it('assertFreshEpoch does not throw on a matching pair', () => {
    const epoch = mintPageMapEpoch(SESSION_A, 'LOADER_1');
    expect(() => assertFreshEpoch(epoch, epoch)).not.toThrow();
  });

  it('assertFreshEpoch throws PageMapStaleEpochError, carrying both epochs, on a mismatch', () => {
    const current = mintPageMapEpoch(SESSION_A, 'LOADER_2'); // a navigation happened
    const requested = mintPageMapEpoch(SESSION_A, 'LOADER_1'); // caller still holds the pre-navigation epoch

    let caught: unknown;
    try {
      assertFreshEpoch(current, requested);
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(PageMapStaleEpochError);
    const err = caught as PageMapStaleEpochError;
    expect(err.currentEpoch).toBe(current);
    expect(err.requestedEpoch).toBe(requested);
  });
});
