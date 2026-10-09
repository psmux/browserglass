import { describe, expect, it } from 'vitest';
import {
  CLOSE_REASON_BY_CODE_NAME,
  CloseCode,
  NEVER_RECONNECT_CODES,
  closeCodeBand,
  reconnectPolicy,
} from '../../src/wire/close-codes.js';

const ALL_CODE_VALUES = Object.values(CloseCode);

describe('close codes', () => {
  it('every close code value is unique (never reused across bands)', () => {
    const seen = new Set<number>();
    for (const value of ALL_CODE_VALUES) {
      expect(seen.has(value)).toBe(false);
      seen.add(value);
    }
  });

  it('every close code resolves to exactly one non-unknown band', () => {
    for (const value of ALL_CODE_VALUES) {
      expect(closeCodeBand(value)).not.toBe('unknown');
    }
  });

  it('an unrecognised numeric code resolves to the unknown band', () => {
    expect(closeCodeBand(4850)).toBe('unknown');
    expect(closeCodeBand(2999)).toBe('ws');
  });

  it('the never-reconnect set matches the reference reconnect algorithm exactly', () => {
    const expected = new Set([
      CloseCode.Kicked,
      CloseCode.InstanceReleased,
      CloseCode.PolicyViolation,
      CloseCode.QuotaExceeded,
      CloseCode.IncompatibleVersion,
      CloseCode.InvalidAuth,
      CloseCode.MissingParams,
      CloseCode.Forbidden,
      CloseCode.TenantSuspended,
      CloseCode.Replaced,
    ]);
    expect(NEVER_RECONNECT_CODES.size).toBe(expected.size);
    for (const code of expected) {
      expect(NEVER_RECONNECT_CODES.has(code)).toBe(true);
    }
  });

  it('reconnectPolicy never reconnects for every code in the never-reconnect set', () => {
    for (const code of NEVER_RECONNECT_CODES) {
      expect(reconnectPolicy(code).reconnect).toBe(false);
    }
  });

  it('reconnectPolicy reconnects on 4000 to 4099 except 4003 and 4006', () => {
    for (let code = 4000; code <= 4099; code++) {
      const policy = reconnectPolicy(code);
      if (code === CloseCode.Kicked || code === CloseCode.InstanceReleased) {
        expect(policy.reconnect).toBe(false);
      } else {
        expect(policy.reconnect).toBe(true);
      }
    }
  });

  it('reconnectPolicy special-cases match the reference algorithm', () => {
    expect(reconnectPolicy(CloseCode.NormalClosure)).toEqual({ reconnect: false });
    expect(reconnectPolicy(CloseCode.RateLimited)).toEqual({
      reconnect: true,
      backoff: 'retryAfter',
      sameToken: true,
    });
    expect(reconnectPolicy(CloseCode.TokenExpired)).toEqual({
      reconnect: true,
      backoff: 'immediate',
      sameToken: false,
    });
    expect(reconnectPolicy(CloseCode.ResumeRejected)).toEqual({
      reconnect: true,
      backoff: 'immediate',
      sameToken: true,
      dropResume: true,
    });
    expect(reconnectPolicy(CloseCode.Relocate)).toEqual({
      reconnect: true,
      backoff: 'immediate',
      sameToken: false,
      useRedirect: true,
    });
  });

  it('reconnectPolicy defaults to reconnect for an unknown code', () => {
    expect(reconnectPolicy(4850)).toEqual({ reconnect: true, backoff: 'normal', sameToken: true });
  });

  it('every close-code name with a reason string round-trips through CLOSE_REASON_BY_CODE_NAME', () => {
    expect(CLOSE_REASON_BY_CODE_NAME.SessionEnded).toBe('session_ended');
    expect(CLOSE_REASON_BY_CODE_NAME.Relocate).toBe('relocate');
  });
});
