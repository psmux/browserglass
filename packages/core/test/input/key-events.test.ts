import { describe, expect, it } from 'vitest';
import {
  VK_BY_KEY,
  buildKeyEvent,
  hardenKeyEvent,
  isHardenedKeyEvent,
  isNonTextKey,
  keyDownText,
  vkForKey,
} from '../../src/input/key-events.js';

describe('VK_BY_KEY', () => {
  it('maps the bracket and backslash keys to their Windows virtual key codes', () => {
    expect(VK_BY_KEY['[']).toBe(219);
    expect(VK_BY_KEY['\\']).toBe(220);
    expect(VK_BY_KEY[']']).toBe(221);
    expect(VK_BY_KEY["'"]).toBe(222);
    expect(VK_BY_KEY['Enter']).toBe(13);
    expect(VK_BY_KEY['Backspace']).toBe(8);
    expect(VK_BY_KEY[' ']).toBe(32);
  });
});

describe('vkForKey', () => {
  it('resolves F1 to F24 as 111 + n', () => {
    expect(vkForKey('F1', 'F1')).toBe(112);
    expect(vkForKey('F24', 'F24')).toBe(135);
  });
  it('resolves a single printable character to its uppercase ASCII code', () => {
    expect(vkForKey('a', 'KeyA')).toBe(65);
    expect(vkForKey('5', 'Digit5')).toBe(53);
  });
  it('falls back to the code for a non-US layout: Digit3 gives 0x33', () => {
    expect(vkForKey('é', 'Digit3')).toBe(0x33);
  });
  it('falls back to the code for KeyQ', () => {
    expect(vkForKey('é', 'KeyQ')).toBe('Q'.charCodeAt(0));
  });
  it('falls back to the code for Numpad7 (0x67)', () => {
    expect(vkForKey('é', 'Numpad7')).toBe(0x67);
  });
  it('returns 0 for anything unrecognised', () => {
    expect(vkForKey('Unidentified', 'Unidentified')).toBe(0);
  });
});

describe('isNonTextKey', () => {
  it('flags the fixed non-text set', () => {
    expect(isNonTextKey('ArrowLeft')).toBe(true);
    expect(isNonTextKey('Backspace')).toBe(true);
  });
  it('flags every F-key by pattern', () => {
    expect(isNonTextKey('F1')).toBe(true);
    expect(isNonTextKey('F13')).toBe(true);
  });
  it('does not flag a printable key', () => {
    expect(isNonTextKey('a')).toBe(false);
  });
});

describe('keyDownText: the function whose emptiness is the headless deadlock', () => {
  it('returns the key itself for a single printable character', () => {
    expect(keyDownText('a', undefined, 0)).toBe('a');
  });
  it('returns \\r for Enter, never \\n', () => {
    expect(keyDownText('Enter', undefined, 0)).toBe('\r');
  });
  it('returns \\t for Tab', () => {
    expect(keyDownText('Tab', undefined, 0)).toBe('\t');
  });
  it('returns empty for a non-text key (ArrowLeft), never the literal key name', () => {
    expect(keyDownText('ArrowLeft', undefined, 0)).toBe('');
  });
  it('returns empty when Ctrl is held', () => {
    expect(keyDownText('c', undefined, 2)).toBe('');
  });
  it('returns empty when Alt is held', () => {
    expect(keyDownText('a', undefined, 1)).toBe('');
  });
  it('returns empty when Meta is held', () => {
    expect(keyDownText('a', undefined, 4)).toBe('');
  });
  it('still returns text when only Shift is held', () => {
    expect(keyDownText('A', undefined, 8)).toBe('A');
  });
  it('treats an astral character (emoji, two UTF-16 units) as one code point', () => {
    const emoji = '\u{1F600}';
    expect([...emoji]).toHaveLength(1);
    expect(emoji.length).toBe(2);
    expect(keyDownText(emoji, undefined, 0)).toBe(emoji);
  });
});

describe('buildKeyEvent', () => {
  it('never produces an empty text for a keyDown of a printable key: the exact invariant that deadlocks headless Chrome otherwise', () => {
    for (const key of ['a', 'Z', '5', ' ', '@', "'"]) {
      const params = buildKeyEvent({
        kind: 'down',
        key,
        code: `Key${key.toUpperCase()}`,
        modifiers: 0,
      });
      expect(params).not.toBeNull();
      expect(params?.text).toBeTruthy();
      expect(params?.text).not.toBe('');
    }
  });

  it('produces type keyDown for kind down, keyUp for kind up', () => {
    const down = buildKeyEvent({ kind: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
    const up = buildKeyEvent({ kind: 'up', key: 'a', code: 'KeyA', modifiers: 0 });
    expect(down?.type).toBe('keyDown');
    expect(up?.type).toBe('keyUp');
  });

  it('sets windowsVirtualKeyCode and nativeVirtualKeyCode equal, from VK_BY_KEY, for Enter', () => {
    const params = buildKeyEvent({ kind: 'down', key: 'Enter', code: 'Enter', modifiers: 0 });
    expect(params?.windowsVirtualKeyCode).toBe(13);
    expect(params?.nativeVirtualKeyCode).toBe(13);
    expect(params?.text).toBe('\r');
  });

  it('sets text equal to unmodifiedText', () => {
    const params = buildKeyEvent({
      kind: 'down',
      key: '@',
      code: 'Digit2',
      modifiers: 8,
      text: '@',
    });
    expect(params?.text).toBe(params?.unmodifiedText);
  });

  it('returns null for a char event whose text was already carried by the keyDown (no double-typing)', () => {
    const params = buildKeyEvent({ kind: 'char', key: 'a', code: 'KeyA', modifiers: 0, text: 'a' });
    expect(params).toBeNull();
  });

  it('passes through a bare char event for an AltGr-style combo (Ctrl+Alt held, keyDownText empty despite a real character)', () => {
    const params = buildKeyEvent({
      kind: 'char',
      key: '@',
      code: 'Digit2',
      modifiers: 3,
      text: '@',
    });
    expect(params).not.toBeNull();
    expect(params?.type).toBe('char');
    expect(params?.text).toBe('@');
  });

  it('returns null for an empty char event', () => {
    const params = buildKeyEvent({
      kind: 'char',
      key: 'Unidentified',
      code: '',
      modifiers: 0,
      text: '',
    });
    expect(params).toBeNull();
  });

  it('stamps the hardened brand on every non-null result', () => {
    const down = buildKeyEvent({ kind: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
    expect(down).not.toBeNull();
    expect(isHardenedKeyEvent(down as unknown as object)).toBe(true);
  });

  it('the hardened brand never appears in the JSON payload sent to Chrome', () => {
    const down = buildKeyEvent({ kind: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
    const json = JSON.stringify(down);
    expect(json).not.toMatch(/hardened/i);
  });
});

describe('hardenKeyEvent', () => {
  it('corrects a rawKeyDown for a text-producing key to keyDown', () => {
    const p = { type: 'rawKeyDown', key: 'a', text: 'a' };
    hardenKeyEvent(p, 0);
    expect(p.type).toBe('keyDown');
  });
  it('leaves a non-rawKeyDown type alone', () => {
    const p = { type: 'keyUp', key: 'a' };
    hardenKeyEvent(p, 0);
    expect(p.type).toBe('keyUp');
  });
  it('brands the params it processes', () => {
    const p = { type: 'keyDown', key: 'a', text: 'a' };
    hardenKeyEvent(p, 0);
    expect(isHardenedKeyEvent(p)).toBe(true);
  });
});
