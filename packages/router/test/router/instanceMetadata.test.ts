/**
 * `validateAcquireMetadata` (`../../src/router/instanceMetadata.ts`), the
 * cap enforcement `AcquireRequest.metadata` gets before it reaches
 * `Store.createInstance`. See that module's top comment for why the caps
 * exist (an uncapped caller-supplied map landing on every instance row is
 * a denial-of-service vector against the store) and why 16 keys / 64
 * character keys / 512 character values were chosen.
 */
import { describe, expect, it } from 'vitest';
import {
  MAX_METADATA_KEYS,
  MAX_METADATA_KEY_LENGTH,
  MAX_METADATA_VALUE_LENGTH,
  MetadataValidationError,
  validateAcquireMetadata,
} from '../../src/router/instanceMetadata.js';

describe('validateAcquireMetadata', () => {
  it('returns {} for undefined, never undefined itself', () => {
    expect(validateAcquireMetadata(undefined)).toEqual({});
  });

  it('passes through a small, well formed map unchanged', () => {
    const input = { name: 'checkout-repro-17', description: 'reproducing the double-submit bug' };
    expect(validateAcquireMetadata(input)).toEqual(input);
  });

  it('accepts exactly MAX_METADATA_KEYS keys', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < MAX_METADATA_KEYS; i++) input[`k${i}`] = 'v';
    expect(Object.keys(validateAcquireMetadata(input))).toHaveLength(MAX_METADATA_KEYS);
  });

  it('rejects one key more than MAX_METADATA_KEYS', () => {
    const input: Record<string, string> = {};
    for (let i = 0; i < MAX_METADATA_KEYS + 1; i++) input[`k${i}`] = 'v';
    expect(() => validateAcquireMetadata(input)).toThrow(MetadataValidationError);
  });

  it('accepts a key exactly MAX_METADATA_KEY_LENGTH characters long', () => {
    const key = 'k'.repeat(MAX_METADATA_KEY_LENGTH);
    expect(validateAcquireMetadata({ [key]: 'v' })).toEqual({ [key]: 'v' });
  });

  it('rejects a key one character over MAX_METADATA_KEY_LENGTH', () => {
    const key = 'k'.repeat(MAX_METADATA_KEY_LENGTH + 1);
    expect(() => validateAcquireMetadata({ [key]: 'v' })).toThrow(MetadataValidationError);
  });

  it('accepts a value exactly MAX_METADATA_VALUE_LENGTH characters long', () => {
    const value = 'v'.repeat(MAX_METADATA_VALUE_LENGTH);
    expect(validateAcquireMetadata({ description: value })).toEqual({ description: value });
  });

  it('rejects a value one character over MAX_METADATA_VALUE_LENGTH', () => {
    const value = 'v'.repeat(MAX_METADATA_VALUE_LENGTH + 1);
    expect(() => validateAcquireMetadata({ description: value })).toThrow(MetadataValidationError);
  });

  it('returns a frozen object, so a caller cannot mutate the stored metadata after the fact', () => {
    const out = validateAcquireMetadata({ name: 'x' });
    expect(Object.isFrozen(out)).toBe(true);
  });
});
