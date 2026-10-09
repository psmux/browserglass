/**
 * Key event construction: `VK_BY_KEY`, `keyDownText`, `isNonTextKey`,
 * `buildKeyEvent`, and `hardenKeyEvent`.
 *
 * THE INVARIANT this whole module exists to protect: under
 * `--headless=new`, a `keyDown` for a text-producing key dispatched with an
 * empty `text` field permanently deadlocks the renderer main thread.
 * `rawKeyDown` cannot carry text by definition and is therefore banned from
 * the protocol entirely (`InputKey.kind` is `'down' | 'up' | 'char'`, with
 * no way to express `rawKeyDown` at all); `hardenKeyEvent` is defence in
 * depth for any other direct CDP key-event param construction.
 */

import type { InputKey } from '@browserglass/protocol';

/** CDP's `Input.dispatchKeyEvent` (and mouse/touch) modifier bitmask: 1 Alt, 2 Ctrl, 4 Meta, 8 Shift. */
export const CDP_MODIFIER = Object.freeze({ ALT: 1, CTRL: 2, META: 4, SHIFT: 8 });

/**
 * The virtual key code table `Input.dispatchKeyEvent` needs for non-character
 * keys (Enter submit, Backspace delete, and so on). `'['` is `219`, the
 * backslash key is `'\\': 220` (a single escaped backslash character, not
 * a two-character sequence), `']'` is `221`, and the apostrophe is
 * `222`.
 */
export const VK_BY_KEY: Readonly<Record<string, number>> = Object.freeze({
  Backspace: 8,
  Tab: 9,
  Enter: 13,
  Shift: 16,
  Control: 17,
  Alt: 18,
  Pause: 19,
  CapsLock: 20,
  Escape: 27,
  ' ': 32,
  PageUp: 33,
  PageDown: 34,
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Insert: 45,
  Delete: 46,
  Meta: 91,
  ContextMenu: 93,
  NumLock: 144,
  ScrollLock: 145,
  ';': 186,
  '=': 187,
  ',': 188,
  '-': 189,
  '.': 190,
  '/': 191,
  '`': 192,
  '[': 219,
  '\\': 220,
  ']': 221,
  "'": 222,
});

/**
 * Resolves the `windowsVirtualKeyCode` (and `nativeVirtualKeyCode`, CDP
 * expects them equal for this relay use case) for one key, by four
 * derivation rules, in order:
 * a direct {@link VK_BY_KEY} hit; `F1` to `F24` as `111 + n`; a single
 * printable ASCII character as its uppercase code; then the `code`-based
 * fallbacks for non-US layouts (`Digit3` gives `0x33`, `KeyQ` gives `Q`'s
 * char code, `Numpad7` gives `0x67`). Anything else is `0`, which CDP treats
 * as "no virtual key".
 */
export function vkForKey(key: string, code: string): number {
  const direct = VK_BY_KEY[key];
  if (direct !== undefined) {
    return direct;
  }
  const fMatch = /^F([1-9]|1[0-9]|2[0-4])$/.exec(key);
  if (fMatch) {
    return 111 + Number(fMatch[1]);
  }
  if ([...key].length === 1) {
    const upper = key.toUpperCase();
    const codePoint = upper.codePointAt(0);
    if (codePoint !== undefined && codePoint >= 0x20 && codePoint <= 0x7e) {
      return codePoint;
    }
  }
  const digitMatch = /^Digit([0-9])$/.exec(code);
  if (digitMatch) {
    return 0x30 + Number(digitMatch[1]);
  }
  const keyCodeMatch = /^Key([A-Z])$/.exec(code);
  if (keyCodeMatch) {
    return (keyCodeMatch[1] as string).charCodeAt(0);
  }
  const numpadMatch = /^Numpad([0-9])$/.exec(code);
  if (numpadMatch) {
    return 0x60 + Number(numpadMatch[1]);
  }
  return 0;
}

/**
 * Keys that must never carry `text`, because they have no character
 * representation: sending `text: 'ArrowLeft'` would type the literal string
 * "ArrowLeft". Every `/^F\d+$/` key is excluded the same way, checked
 * separately in {@link isNonTextKey}.
 */
export const NON_TEXT_KEYS: ReadonlySet<string> = Object.freeze(
  new Set([
    'Backspace',
    'Escape',
    'Delete',
    'Insert',
    'Home',
    'End',
    'PageUp',
    'PageDown',
    'ArrowLeft',
    'ArrowRight',
    'ArrowUp',
    'ArrowDown',
    'Shift',
    'Control',
    'Alt',
    'Meta',
    'ContextMenu',
    'CapsLock',
    'NumLock',
    'ScrollLock',
    'Pause',
    'Dead',
  ]),
);

/** Whether `key` is one of {@link NON_TEXT_KEYS} or matches `/^F\d+$/`. */
export function isNonTextKey(key: string): boolean {
  return NON_TEXT_KEYS.has(key) || /^F\d+$/.test(key);
}

/**
 * Resolves the `text` a `keyDown` for `key` should carry. This is the function whose result
 * being empty for a printable key, and that empty string being sent anyway,
 * is the deadlock this whole module exists to prevent.
 *
 * - Ctrl, Alt, or Meta held (Shift alone excluded: Shift+A does produce
 *   `'A'`) means no keypress and therefore no text.
 * - `Enter` returns `'\r'`, never `'\n'`: `'\n'` inserts a literal newline in
 *   some `contenteditable` implementations instead of splitting the block.
 * - `Tab` returns `'\t'`, matching a real browser typing a tab into a
 *   `<textarea>`.
 * - {@link isNonTextKey} keys never carry text.
 * - A single code point (`[...key].length === 1`, never `key.length`, so an
 *   astral character such as an emoji, two UTF-16 code units, is still
 *   recognised as one grapheme) is returned as-is.
 * - Anything else falls back to the client-reported `text`, or `''`.
 */
export function keyDownText(
  key: string,
  clientText: string | undefined,
  modifiers: number,
): string {
  if ((modifiers | 0) & ~CDP_MODIFIER.SHIFT) {
    return '';
  }
  if (key === 'Enter') {
    return '\r';
  }
  if (key === 'Tab') {
    return '\t';
  }
  if (typeof key !== 'string' || !key) {
    return typeof clientText === 'string' ? clientText : '';
  }
  if (isNonTextKey(key)) {
    return '';
  }
  if ([...key].length === 1) {
    return key;
  }
  return typeof clientText === 'string' ? clientText : '';
}

/** The exact CDP `Input.dispatchKeyEvent` parameter shape this module builds, before the hardened brand is applied. */
export interface CdpKeyEventParams {
  type: 'keyDown' | 'keyUp' | 'char' | 'rawKeyDown';
  key: string;
  code: string;
  windowsVirtualKeyCode?: number;
  nativeVirtualKeyCode?: number;
  modifiers: number;
  text?: string;
  unmodifiedText?: string;
  autoRepeat?: boolean;
  location?: number;
}

/**
 * A symbol-keyed brand, never enumerable and never serialised by
 * `JSON.stringify` (which ignores every symbol-keyed property regardless of
 * enumerability), so it can be stamped onto a real CDP params object without
 * that object ever carrying an extra field onto the wire to Chrome. Only
 * {@link buildKeyEvent} and {@link hardenKeyEvent} ever call {@link brand};
 * `cdp-allowlist.ts` refuses to send `Input.dispatchKeyEvent` params lacking
 * it.
 */
const HARDENED = Symbol('bgls.core.input.hardenedKeyEvent');

function brand<T extends object>(params: T): T {
  Object.defineProperty(params, HARDENED, { value: true, enumerable: false, configurable: false });
  return params;
}

/** Whether `params` was produced by {@link buildKeyEvent} or explicitly passed through {@link hardenKeyEvent}. */
export function isHardenedKeyEvent(params: object): boolean {
  return (params as Record<symbol, unknown>)[HARDENED] === true;
}

/** The subset of {@link InputKey} {@link buildKeyEvent} needs. */
export type KeyEventInput = Pick<
  InputKey,
  'kind' | 'key' | 'code' | 'modifiers' | 'text' | 'repeat' | 'location'
>;

/**
 * Builds one CDP `Input.dispatchKeyEvent` params object from a validated
 * wire `input.key` message, or returns `null` when nothing should be
 * dispatched (an empty `char` whose text was already carried by the
 * preceding `keyDown`).
 *
 * Every field is assembled explicitly from validated values; nothing here
 * ever spreads the raw wire message into the returned object. `text` and
 * `unmodifiedText` are always set equal: this relays a key
 * event the viewer's own browser already resolved against its layout, so
 * there is no layout to re-derive `unmodifiedText` against, and the one case
 * that would look wrong (Ctrl+Z on a Dvorak layout) self-corrects because
 * {@link keyDownText} returns `''` for any Ctrl/Alt/Meta combination anyway,
 * falling back to `windowsVirtualKeyCode`, which is layout independent.
 */
export function buildKeyEvent(msg: KeyEventInput): CdpKeyEventParams | null {
  const modifiers = msg.modifiers;

  if (msg.kind === 'char') {
    if (keyDownText(msg.key, msg.text, modifiers)) {
      // The keyDown already carried this text; relaying char too would double-type.
      return null;
    }
    const charText = typeof msg.text === 'string' ? msg.text : '';
    if (!charText) {
      return null;
    }
    const params: CdpKeyEventParams = {
      type: 'char',
      key: msg.key,
      code: msg.code,
      modifiers,
      text: charText,
      unmodifiedText: charText,
      autoRepeat: msg.repeat ?? false,
    };
    return brand(params);
  }

  const vk = vkForKey(msg.key, msg.code);
  const params: CdpKeyEventParams = {
    type: msg.kind === 'down' ? 'keyDown' : 'keyUp',
    key: msg.key,
    code: msg.code,
    modifiers,
    ...(vk !== 0 ? { windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk } : {}),
    ...(msg.location !== undefined ? { location: msg.location } : {}),
  };
  if (msg.kind === 'down') {
    const text = keyDownText(msg.key, msg.text, modifiers);
    params.text = text;
    params.unmodifiedText = text;
    params.autoRepeat = msg.repeat ?? false;
  }
  return brand(params);
}

/**
 * Defence in depth for any CDP key-event params constructed outside
 * {@link buildKeyEvent}. `rawKeyDown` cannot occur through the protocol path
 * (`InputKey.kind` has no such value), so this exists purely as a guard: if
 * `p.type` is somehow `'rawKeyDown'` and the key would actually produce
 * text, it is corrected to `'keyDown'` before the hardened brand is applied.
 * Every `Input.dispatchKeyEvent`
 * call must route through {@link buildKeyEvent} or this function.
 */
export function hardenKeyEvent(
  p: { type: string; key?: string; text?: string },
  modifiers: number,
): void {
  if (p.type === 'rawKeyDown' && keyDownText(p.key ?? '', p.text, modifiers)) {
    p.type = 'keyDown';
  }
  brand(p as unknown as object);
}
