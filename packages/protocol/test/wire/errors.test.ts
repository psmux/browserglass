import { describe, expect, it } from 'vitest';
import {
  BglsError,
  DEFAULT_WIRE_ERROR_CODE,
  ERROR_REGISTRY,
  E_TO_WIRE_ERROR,
  wireErrorCodeFor,
} from '../../src/wire/errors.js';

describe('error registry', () => {
  it('every registry key equals its own entry.code', () => {
    for (const [key, value] of Object.entries(ERROR_REGISTRY)) {
      expect(value.code).toBe(key);
    }
  });

  it('every registry code starts with bgls.error. and its second segment matches its category', () => {
    for (const value of Object.values(ERROR_REGISTRY)) {
      expect(value.code.startsWith('bgls.error.')).toBe(true);
      const segments = value.code.split('.');
      expect(segments[2]).toBe(value.category);
    }
  });

  it('bgls.error.internal is the fallback default', () => {
    expect(DEFAULT_WIRE_ERROR_CODE).toBe('bgls.error.internal');
    expect(ERROR_REGISTRY[DEFAULT_WIRE_ERROR_CODE]).toBeDefined();
  });
});

describe('BglsError and the E_* to wire-code mapping', () => {
  it('every mapped wire code exists in the registry', () => {
    for (const wireCode of Object.values(E_TO_WIRE_ERROR)) {
      expect(ERROR_REGISTRY[wireCode]).toBeDefined();
    }
  });

  it('wireErrorCodeFor resolves a known E_* code', () => {
    expect(wireErrorCodeFor('E_CAP_MISSING')).toBe('bgls.error.cap.missing');
  });

  it('wireErrorCodeFor resolves an unmapped code to the internal default', () => {
    expect(wireErrorCodeFor('E_SOMETHING_NEVER_MAPPED')).toBe(DEFAULT_WIRE_ERROR_CODE);
  });

  it('wireErrorCodeFor accepts a BglsError instance directly', () => {
    const err = new BglsError('E_STREAM_LIMIT', 'too many streams', {
      context: { current: 4, cap: 4 },
    });
    expect(wireErrorCodeFor(err)).toBe('bgls.error.stream.limit');
    expect(err.code).toBe('E_STREAM_LIMIT');
    expect(err.context).toEqual({ current: 4, cap: 4 });
    expect(err).toBeInstanceOf(Error);
  });
});
