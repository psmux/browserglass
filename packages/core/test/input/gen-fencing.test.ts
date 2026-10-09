import { describe, expect, it } from 'vitest';
import { resolveGenFencing } from '../../src/input/gen-fencing.js';

describe('resolveGenFencing', () => {
  it('dispatches whenever the generation is current, regardless of kind', () => {
    for (const kind of [
      'mouse.move',
      'mouse.down',
      'mouse.up',
      'touch.start',
      'key.down',
    ] as const) {
      expect(resolveGenFencing(3, 3, kind)).toEqual({ action: 'dispatch', stale: false });
    }
  });

  it('drops a stale mouse.move and mouse.wheel silently', () => {
    expect(resolveGenFencing(3, 2, 'mouse.move').action).toBe('drop');
    expect(resolveGenFencing(3, 2, 'mouse.wheel').action).toBe('drop');
  });

  it('drops a stale touch.start and touch.move silently', () => {
    expect(resolveGenFencing(3, 2, 'touch.start').action).toBe('drop');
    expect(resolveGenFencing(3, 2, 'touch.move').action).toBe('drop');
  });

  it('drops a stale mouse.down with an error signal', () => {
    const decision = resolveGenFencing(3, 2, 'mouse.down');
    expect(decision).toEqual({ action: 'drop_with_error', stale: true });
  });

  it('dispatches a stale mouse.up, touch.end, and touch.cancel at the last position: the release exception', () => {
    for (const kind of ['mouse.up', 'touch.end', 'touch.cancel'] as const) {
      expect(resolveGenFencing(3, 2, kind)).toEqual({
        action: 'dispatch_at_last_position',
        stale: true,
      });
    }
  });

  it('key events always dispatch regardless of gen: they carry no coordinates', () => {
    for (const kind of ['key.down', 'key.up', 'key.char'] as const) {
      expect(resolveGenFencing(3, 2, kind).action).toBe('dispatch');
    }
  });

  it('drops a stale drag.enter and drag.over silently', () => {
    expect(resolveGenFencing(3, 2, 'drag.enter').action).toBe('drop');
    expect(resolveGenFencing(3, 2, 'drag.over').action).toBe('drop');
  });

  it('dispatches a stale drag.drop and drag.leave at the last position: the release exception', () => {
    for (const kind of ['drag.drop', 'drag.leave'] as const) {
      expect(resolveGenFencing(3, 2, kind)).toEqual({
        action: 'dispatch_at_last_position',
        stale: true,
      });
    }
  });
});
