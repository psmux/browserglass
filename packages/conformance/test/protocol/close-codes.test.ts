import {
  CloseCode,
  NEVER_RECONNECT_CODES,
  closeCodeBand,
  reconnectPolicy,
} from '@browserglass/protocol';
/**
 * Close code conformance: every close code is in exactly one band,
 * and the never reconnect set matches the documented list exactly:
 * `{4003, 4006, 4100, 4102, 4104, 4200, 4202, 4203, 4204, 4300}`.
 */
import { describe, expect, it } from 'vitest';

/** Every numeric close code this build defines, by name, for exhaustive band checks. */
const ALL_CLOSE_CODES = Object.entries(CloseCode) as [string, number][];

describe('close codes: band membership', () => {
  it('every close code is in exactly one band', () => {
    for (const [name, code] of ALL_CLOSE_CODES) {
      const band = closeCodeBand(code);
      expect(band, `${name} (${code}) must resolve to exactly one band`).toBeDefined();
      expect(typeof band).toBe('string');
    }
  });

  it('no numeric close code value is reused across two different names', () => {
    const seen = new Map<number, string>();
    for (const [name, code] of ALL_CLOSE_CODES) {
      const existing = seen.get(code);
      expect(
        existing,
        `close code ${code} is used by both ${existing} and ${name}`,
      ).toBeUndefined();
      seen.set(code, name);
    }
  });

  it('the never-reconnect set is exactly {4003, 4006, 4100, 4102, 4104, 4200, 4202, 4203, 4204, 4300}', () => {
    const expected = new Set([4003, 4006, 4100, 4102, 4104, 4200, 4202, 4203, 4204, 4300]);
    expect(new Set(NEVER_RECONNECT_CODES)).toEqual(expected);
  });

  it('every code outside the never-reconnect set that reconnectPolicy considers has an opinion (no silent gap)', () => {
    for (const [, code] of ALL_CLOSE_CODES) {
      const policy = reconnectPolicy(code);
      expect(typeof policy.reconnect).toBe('boolean');
    }
  });

  it('reconnect is offered on every 4000-4099 code except 4003 (Kicked) and 4006 (InstanceReleased)', () => {
    for (const [name, code] of ALL_CLOSE_CODES) {
      if (code < 4000 || code > 4099) continue;
      const policy = reconnectPolicy(code);
      if (code === CloseCode.Kicked || code === CloseCode.InstanceReleased) {
        expect(policy.reconnect, `${name} must not reconnect`).toBe(false);
      } else {
        expect(policy.reconnect, `${name} must reconnect`).toBe(true);
      }
    }
  });

  it('bands: ws (1000-1999), session (4000-4099), policy (4100-4199), auth (4200-4299), replacement (4300-4399), routing (4400-4499)', () => {
    expect(closeCodeBand(CloseCode.NormalClosure)).toBe('ws');
    expect(closeCodeBand(CloseCode.SessionEnded)).toBe('session');
    expect(closeCodeBand(CloseCode.PolicyViolation)).toBe('policy');
    expect(closeCodeBand(CloseCode.InvalidAuth)).toBe('auth');
    expect(closeCodeBand(CloseCode.Replaced)).toBe('replacement');
    expect(closeCodeBand(CloseCode.NoCapacity)).toBe('routing');
  });
});
