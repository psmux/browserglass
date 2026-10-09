/**
 * A minimal DOM `key`/`code` table for {@link AutomationClient.pressKey},
 * `type()`, and `humanType()`. This is deliberately NOT a transcription of
 * `VK_BY_KEY` (the CDP `windowsVirtualKeyCode` table `@browserglass/core`
 * owns): the wire's `input.key` message carries
 * only DOM `key`/`code`/`text`, and the CDP-level hardening (`hardenKeyEvent`,
 * the empty-text headless deadlock guard) happens server side in `core`,
 * already built. This module's only job is producing a reasonable DOM
 * `key`/`code` pair for the characters and named keys an agent is likely to
 * send; an unmapped printable character still works correctly by falling
 * back to `input.text` (see `AutomationClient.type()`), so nothing is lost
 * for characters outside this table, only per-keystroke `keydown`/`keyup`
 * fidelity.
 */

/** One DOM key event's `key` and `code`. */
export interface KeyCode {
  key: string;
  code: string;
}

const NAMED_KEYS: Readonly<Record<string, KeyCode>> = Object.freeze({
  Enter: { key: 'Enter', code: 'Enter' },
  Tab: { key: 'Tab', code: 'Tab' },
  Escape: { key: 'Escape', code: 'Escape' },
  Backspace: { key: 'Backspace', code: 'Backspace' },
  Delete: { key: 'Delete', code: 'Delete' },
  Insert: { key: 'Insert', code: 'Insert' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp' },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown' },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft' },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight' },
  Home: { key: 'Home', code: 'Home' },
  End: { key: 'End', code: 'End' },
  PageUp: { key: 'PageUp', code: 'PageUp' },
  PageDown: { key: 'PageDown', code: 'PageDown' },
  Space: { key: ' ', code: 'Space' },
  F1: { key: 'F1', code: 'F1' },
  F2: { key: 'F2', code: 'F2' },
  F3: { key: 'F3', code: 'F3' },
  F4: { key: 'F4', code: 'F4' },
  F5: { key: 'F5', code: 'F5' },
  F6: { key: 'F6', code: 'F6' },
  F7: { key: 'F7', code: 'F7' },
  F8: { key: 'F8', code: 'F8' },
  F9: { key: 'F9', code: 'F9' },
  F10: { key: 'F10', code: 'F10' },
  F11: { key: 'F11', code: 'F11' },
  F12: { key: 'F12', code: 'F12' },
  Alt: { key: 'Alt', code: 'AltLeft' },
  Control: { key: 'Control', code: 'ControlLeft' },
  Meta: { key: 'Meta', code: 'MetaLeft' },
  Shift: { key: 'Shift', code: 'ShiftLeft' },
});

/** US QWERTY punctuation, `key` to `code`. Shifted variants (e.g. `!` for `1`) share the unshifted key's code. */
const PUNCTUATION_CODES: Readonly<Record<string, string>> = Object.freeze({
  '`': 'Backquote',
  '~': 'Backquote',
  '-': 'Minus',
  _: 'Minus',
  '=': 'Equal',
  '+': 'Equal',
  '[': 'BracketLeft',
  '{': 'BracketLeft',
  ']': 'BracketRight',
  '}': 'BracketRight',
  '\\': 'Backslash',
  '|': 'Backslash',
  ';': 'Semicolon',
  ':': 'Semicolon',
  "'": 'Quote',
  '"': 'Quote',
  ',': 'Comma',
  '<': 'Comma',
  '.': 'Period',
  '>': 'Period',
  '/': 'Slash',
  '?': 'Slash',
  ' ': 'Space',
});

const DIGIT_SHIFT: Readonly<Record<string, string>> = Object.freeze({
  '!': 'Digit1',
  '@': 'Digit2',
  '#': 'Digit3',
  $: 'Digit4',
  '%': 'Digit5',
  '^': 'Digit6',
  '&': 'Digit7',
  '*': 'Digit8',
  '(': 'Digit9',
  ')': 'Digit0',
});

/**
 * Resolves one of the named keys above (case sensitive, e.g. `'Enter'`,
 * `'ArrowLeft'`, `'F5'`), or `undefined` for anything else. Used by
 * {@link AutomationClient.pressKey}.
 */
export function namedKeyCode(name: string): KeyCode | undefined {
  return NAMED_KEYS[name];
}

/**
 * Resolves a single printable character (must satisfy `[...s].length === 1`,
 * astral safe) to a best-effort DOM `key`/`code` pair for a real per-key
 * `keydown`/`keyup` pair, or `undefined` when no reasonable `code` is known
 * (multi-codepoint graphemes, most non-Latin scripts): the caller falls
 * back to `input.text` in that case, which is always correct even without a
 * `code`.
 */
export function printableKeyCode(char: string): KeyCode | undefined {
  if ([...char].length !== 1) return undefined;
  if (/^[a-z]$/.test(char)) return { key: char, code: `Key${char.toUpperCase()}` };
  if (/^[A-Z]$/.test(char)) return { key: char, code: `Key${char}` };
  if (/^[0-9]$/.test(char)) return { key: char, code: `Digit${char}` };
  const digitShiftCode = DIGIT_SHIFT[char];
  if (digitShiftCode !== undefined) return { key: char, code: digitShiftCode };
  const punctCode = PUNCTUATION_CODES[char];
  if (punctCode !== undefined) return { key: char, code: punctCode };
  return undefined;
}
