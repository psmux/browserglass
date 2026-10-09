import { describe, expect, it } from 'vitest';
import {
  validateComposition,
  validateDrag,
  validateKey,
  validateMouse,
  validateText,
  validateTouch,
} from '../../src/input/validation.js';

function baseMouse(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'input.mouse',
    ts: 1,
    targetId: 'tgt_1',
    fw: 1280,
    fh: 720,
    gen: 3,
    leaseId: 'lse_abc',
    kind: 'move',
    x: 10,
    y: 20,
    buttons: 0,
    modifiers: 0,
    ...overrides,
  };
}

describe('validateMouse', () => {
  it('accepts a well-formed message', () => {
    const result = validateMouse(baseMouse());
    expect(result.ok).toBe(true);
  });

  it('rejects NaN coordinates before anything downstream sees them', () => {
    const result = validateMouse(baseMouse({ x: Number.NaN }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.field).toBe('coords');
  });

  it('rejects Infinity coordinates', () => {
    const result = validateMouse(baseMouse({ y: Number.POSITIVE_INFINITY }));
    expect(result.ok).toBe(false);
  });

  it('rejects fw/fh of 0 (would divide by zero downstream)', () => {
    expect(validateMouse(baseMouse({ fw: 0 })).ok).toBe(false);
    expect(validateMouse(baseMouse({ fh: 0 })).ok).toBe(false);
  });

  it('rejects fw/fh above 16384', () => {
    expect(validateMouse(baseMouse({ fw: 16385 })).ok).toBe(false);
  });

  it('rejects an out-of-range buttons bitmask', () => {
    expect(validateMouse(baseMouse({ buttons: 32 })).ok).toBe(false);
  });

  it('rejects an out-of-range modifiers bitmask', () => {
    expect(validateMouse(baseMouse({ modifiers: 16 })).ok).toBe(false);
  });

  it('rejects clickCount outside [1, 3] on a down event', () => {
    expect(validateMouse(baseMouse({ kind: 'down', clickCount: 4 })).ok).toBe(false);
    expect(validateMouse(baseMouse({ kind: 'down', clickCount: 0 })).ok).toBe(false);
  });

  it('strips unknown fields rather than forwarding them', () => {
    const result = validateMouse(
      baseMouse({ evilField: 'DROP TABLE targets', __proto__: { polluted: true } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect((result.value as Record<string, unknown>)['evilField']).toBeUndefined();
      expect(Object.keys(result.value)).not.toContain('evilField');
    }
  });
});

describe('validateKey', () => {
  function baseKey(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      t: 'input.key',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 3,
      leaseId: 'lse_abc',
      kind: 'down',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      ...overrides,
    };
  }

  it('accepts a well-formed message', () => {
    expect(validateKey(baseKey()).ok).toBe(true);
  });

  it('rejects a key longer than 32 characters', () => {
    expect(validateKey(baseKey({ key: 'x'.repeat(33) })).ok).toBe(false);
  });

  it('rejects a key containing a control character', () => {
    expect(validateKey(baseKey({ key: 'a' })).ok).toBe(false);
  });

  it('rejects text longer than 8 code points', () => {
    expect(validateKey(baseKey({ text: 'x'.repeat(9) })).ok).toBe(false);
  });

  it('rejects an unrecognised kind', () => {
    expect(validateKey(baseKey({ kind: 'rawKeyDown' })).ok).toBe(false);
  });
});

describe('validateText', () => {
  it('rejects text over 8192 characters', () => {
    const result = validateText({
      v: 1,
      t: 'input.text',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 1,
      leaseId: 'lse_1',
      text: 'x'.repeat(8193),
    });
    expect(result.ok).toBe(false);
  });
});

describe('validateTouch', () => {
  function baseTouch(overrides: Record<string, unknown> = {}) {
    return {
      v: 1,
      t: 'input.touch',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 1,
      leaseId: 'lse_1',
      kind: 'start',
      points: [{ id: 0, x: 10, y: 10 }],
      modifiers: 0,
      ...overrides,
    };
  }

  it('accepts a well-formed message', () => {
    expect(validateTouch(baseTouch()).ok).toBe(true);
  });

  it('rejects more than 10 points (the CDP limit)', () => {
    const points = Array.from({ length: 11 }, (_, id) => ({ id, x: 0, y: 0 }));
    expect(validateTouch(baseTouch({ points })).ok).toBe(false);
  });

  it('rejects a point id outside [0, 65535]', () => {
    expect(validateTouch(baseTouch({ points: [{ id: 70000, x: 0, y: 0 }] })).ok).toBe(false);
  });

  it('accepts touchEnd with an empty points array (last finger lifting)', () => {
    expect(validateTouch(baseTouch({ kind: 'end', points: [] })).ok).toBe(true);
  });
});

describe('validateComposition', () => {
  it('accepts kind end with an empty text (clears remote composition state)', () => {
    const result = validateComposition({
      v: 1,
      t: 'input.composition',
      ts: 1,
      targetId: 'tgt_1',
      fw: 1280,
      fh: 720,
      gen: 1,
      leaseId: 'lse_1',
      kind: 'end',
      text: '',
    });
    expect(result.ok).toBe(true);
  });
});

function baseDrag(overrides: Record<string, unknown> = {}) {
  return {
    v: 1,
    t: 'input.drag',
    ts: 1,
    targetId: 'tgt_1',
    fw: 1280,
    fh: 720,
    gen: 3,
    leaseId: 'lse_abc',
    kind: 'over',
    x: 10,
    y: 20,
    modifiers: 0,
    ...overrides,
  };
}

describe('validateDrag', () => {
  it('accepts a well-formed message', () => {
    expect(validateDrag(baseDrag()).ok).toBe(true);
  });

  it('accepts every kind: enter, over, drop, leave', () => {
    for (const kind of ['enter', 'over', 'drop', 'leave']) {
      expect(validateDrag(baseDrag({ kind })).ok).toBe(true);
    }
  });

  it('rejects an unrecognised kind', () => {
    expect(validateDrag(baseDrag({ kind: 'cancel' })).ok).toBe(false);
  });

  it('rejects NaN and Infinity coordinates', () => {
    expect(validateDrag(baseDrag({ x: Number.NaN })).ok).toBe(false);
    expect(validateDrag(baseDrag({ y: Number.POSITIVE_INFINITY })).ok).toBe(false);
  });

  it('rejects an out-of-range modifiers bitmask', () => {
    expect(validateDrag(baseDrag({ modifiers: 16 })).ok).toBe(false);
  });

  it('accepts a message with no data at all', () => {
    const result = validateDrag(baseDrag());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.data).toBeUndefined();
  });

  it('accepts and rebuilds data.items and dragOperationsMask field by field', () => {
    const result = validateDrag(
      baseDrag({
        data: {
          items: [
            { mimeType: 'text/plain', data: 'hello', title: 't', baseURL: 'https://example.com' },
          ],
          dragOperationsMask: 1,
          extraneous: 'must be dropped, not forwarded',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.data).toEqual({
        items: [
          { mimeType: 'text/plain', data: 'hello', title: 't', baseURL: 'https://example.com' },
        ],
        dragOperationsMask: 1,
      });
    }
  });

  it('rejects data with a missing or empty mimeType', () => {
    expect(
      validateDrag(baseDrag({ data: { items: [{ data: 'x' }], dragOperationsMask: 1 } })).ok,
    ).toBe(false);
    expect(
      validateDrag(
        baseDrag({ data: { items: [{ mimeType: '', data: 'x' }], dragOperationsMask: 1 } }),
      ).ok,
    ).toBe(false);
  });

  it('rejects an out-of-range dragOperationsMask', () => {
    expect(validateDrag(baseDrag({ data: { items: [], dragOperationsMask: -1 } })).ok).toBe(false);
    expect(validateDrag(baseDrag({ data: { items: [], dragOperationsMask: 32 } })).ok).toBe(false);
  });

  it('rejects more than 32 data items', () => {
    const items = Array.from({ length: 33 }, () => ({ mimeType: 'text/plain', data: 'x' }));
    expect(validateDrag(baseDrag({ data: { items, dragOperationsMask: 0 } })).ok).toBe(false);
  });
});
