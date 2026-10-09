import { describe, expect, it } from 'vitest';
import { buildReleaseCommands, createHeldState } from '../../src/input/held-state.js';
import { isHardenedKeyEvent } from '../../src/input/key-events.js';

describe('buildReleaseCommands', () => {
  it('produces nothing for a fresh, empty HeldState', () => {
    expect(buildReleaseCommands(createHeldState())).toEqual([]);
  });

  it('orders commands touches, then drag, then buttons, then keys', () => {
    const state = createHeldState();
    state.touchIds.add(1);
    state.touchIds.add(2);
    state.dragActive = true;
    state.buttons = 1 | 4; // left and middle held
    state.keysDown.add('ShiftLeft');
    state.lastPos = { x: 10, y: 20 };

    const commands = buildReleaseCommands(state);
    const methods = commands.map((c) => c.method);
    const touchIdx = methods.indexOf('Input.dispatchTouchEvent');
    const dragIdx = methods.indexOf('Input.dispatchDragEvent');
    const mouseIdxs = methods.reduce<number[]>((acc, m, i) => {
      if (m === 'Input.dispatchMouseEvent') acc.push(i);
      return acc;
    }, []);
    const keyIdx = methods.indexOf('Input.dispatchKeyEvent');

    expect(touchIdx).toBe(0);
    expect(dragIdx).toBe(1);
    expect(mouseIdxs.every((i) => i > dragIdx)).toBe(true);
    expect(keyIdx).toBeGreaterThan(Math.max(...mouseIdxs));
  });

  it('sends one touchCancel with an empty touchPoints array, clearing every active contact at once', () => {
    const state = createHeldState();
    state.touchIds.add(1);
    state.touchIds.add(2);
    state.touchIds.add(3);
    const commands = buildReleaseCommands(state);
    const touchCommands = commands.filter((c) => c.method === 'Input.dispatchTouchEvent');
    expect(touchCommands).toHaveLength(1);
    expect(touchCommands[0]?.params['touchPoints']).toEqual([]);
  });

  it('cancels an active drag at the last dispatched position, carrying the held modifiers', () => {
    const state = createHeldState();
    state.dragActive = true;
    state.lastPos = { x: 15, y: 25 };
    state.modifiers = 4;
    const commands = buildReleaseCommands(state);
    const drag = commands.filter((c) => c.method === 'Input.dispatchDragEvent');
    expect(drag).toHaveLength(1);
    expect(drag[0]?.params).toEqual({ type: 'dragCancel', x: 15, y: 25, modifiers: 4 });
  });

  it('emits no drag command when no drag is active', () => {
    const state = createHeldState();
    state.buttons = 1;
    const commands = buildReleaseCommands(state);
    expect(commands.some((c) => c.method === 'Input.dispatchDragEvent')).toBe(false);
  });

  it('releases every held mouse button at the last dispatched position, clickCount 1', () => {
    const state = createHeldState();
    state.buttons = 1 | 2; // left and right
    state.lastPos = { x: 42, y: 99 };
    const commands = buildReleaseCommands(state);
    const mouse = commands.filter((c) => c.method === 'Input.dispatchMouseEvent');
    expect(mouse).toHaveLength(2);
    for (const c of mouse) {
      expect(c.params['type']).toBe('mouseReleased');
      expect(c.params['x']).toBe(42);
      expect(c.params['y']).toBe(99);
      expect(c.params['clickCount']).toBe(1);
      expect(c.params['buttons']).toBe(0);
    }
    expect(mouse.map((c) => c.params['button'])).toEqual(expect.arrayContaining(['left', 'right']));
  });

  it('releases every held key via buildKeyEvent, carrying the hardened brand', () => {
    const state = createHeldState();
    state.keysDown.add('KeyA');
    const commands = buildReleaseCommands(state);
    const keyCommands = commands.filter((c) => c.method === 'Input.dispatchKeyEvent');
    expect(keyCommands).toHaveLength(1);
    expect(keyCommands[0]?.params['type']).toBe('keyUp');
    expect(isHardenedKeyEvent(keyCommands[0]?.params as object)).toBe(true);
  });
});
