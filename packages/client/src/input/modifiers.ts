/** CDP modifier bit order: Alt 1, Ctrl 2, Meta 4, Shift 8. */
export const MODIFIER_ALT = 0x1;
export const MODIFIER_CTRL = 0x2;
export const MODIFIER_META = 0x4;
export const MODIFIER_SHIFT = 0x8;

/** The subset of `MouseEvent`/`KeyboardEvent`/`WheelEvent` this reads. */
export interface ModifierKeys {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/** Packs a DOM event's modifier keys into the CDP bit order (Alt 1, Ctrl 2, Meta 4, Shift 8). */
export function modMask(e: ModifierKeys): number {
  let m = 0;
  if (e.altKey) m |= MODIFIER_ALT;
  if (e.ctrlKey) m |= MODIFIER_CTRL;
  if (e.metaKey) m |= MODIFIER_META;
  if (e.shiftKey) m |= MODIFIER_SHIFT;
  return m;
}

/** DOM `MouseEvent.button` (0 to 4) to the wire's named button. */
const BUTTON_NAMES = ['left', 'middle', 'right', 'back', 'forward'] as const;

/** Maps a DOM `MouseEvent.button`/`PointerEvent.button` value to the wire's named button, `'none'` for anything unrecognised. */
export function buttonName(
  button: number,
): 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none' {
  return BUTTON_NAMES[button] ?? 'none';
}
