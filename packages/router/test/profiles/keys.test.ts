import { describe, expect, it } from 'vitest';
import { ProfileServiceError } from '../../src/profiles/errors.js';
import { ephemeralCallerKey, storedKeyFor, validateCallerKey } from '../../src/profiles/keys.js';

describe('profile key namespacing', () => {
  it('accepts a normal key', () => {
    expect(() => validateCallerKey('user:4412:mail')).not.toThrow();
  });

  it('rejects the eph: reserved prefix', () => {
    try {
      validateCallerKey('eph:whatever');
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(ProfileServiceError);
      expect((err as ProfileServiceError).code).toBe('E_PROFILE_KEY_RESERVED');
    }
  });

  it('rejects the bgls: reserved prefix', () => {
    try {
      validateCallerKey('bgls:cow-probe');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ProfileServiceError).code).toBe('E_PROFILE_KEY_RESERVED');
    }
  });

  it('rejects a key not matching the caller key regex', () => {
    try {
      validateCallerKey('has spaces');
      throw new Error('expected throw');
    } catch (err) {
      expect((err as ProfileServiceError).code).toBe('E_PROFILE_KEY_INVALID');
    }
  });

  it('rejects an empty key', () => {
    expect(() => validateCallerKey('')).toThrow(ProfileServiceError);
  });

  it('storedKeyFor produces the canonical t:/a:/ prefixed form', () => {
    expect(storedKeyFor('ten_A', 'app_B', 'user:1')).toBe('t:ten_A/a:app_B/user:1');
  });

  it('ephemeralCallerKey synthesises eph:<instanceId>', () => {
    expect(ephemeralCallerKey('inst_X')).toBe('eph:inst_X');
  });
});
