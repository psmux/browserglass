/**
 * `HeldState`: per-`(target, viewer)` pointer and key hygiene bookkeeping,
 * and the ordered CDP release commands `releaseHeld` sends when it fires.
 *
 * This module builds the release commands only; `dispatcher.ts` is the one
 * caller that actually sends them (through the same allowlisted CDP path
 * every other input command uses) and clears the state afterward. Order
 * matters: touches, then drag, then buttons, then keys, modifiers last,
 * because a modifier keyup while a button is still held can trigger
 * different click behaviour.
 */

import type { AllowedInputMethod } from './cdp-allowlist.js';
import { buildKeyEvent } from './key-events.js';

/** Server-tracked hygiene state for one `(target, viewer)` pair, updated on every dispatched event. */
export interface HeldState {
  /** Bitmask of held mouse buttons (DOM `MouseEvent.buttons` ordering). */
  buttons: number;
  /** Last dispatched viewport (CDP-ready, already transformed) coordinates. */
  lastPos: { x: number; y: number };
  /** Held modifier bitmask (CDP ordering). */
  modifiers: number;
  /** `code` values with an unmatched `down`. */
  keysDown: Set<string>;
  /** Active touch point ids. */
  touchIds: Set<number>;
  dragActive: boolean;
}

/** A fresh, empty {@link HeldState}. */
export function createHeldState(): HeldState {
  return {
    buttons: 0,
    lastPos: { x: 0, y: 0 },
    modifiers: 0,
    keysDown: new Set(),
    touchIds: new Set(),
    dragActive: false,
  };
}

/** One CDP command {@link buildReleaseCommands} produces, in the order it must be sent. */
export interface ReleaseCommand {
  readonly method: AllowedInputMethod;
  readonly params: Record<string, unknown>;
}

/**
 * Builds the ordered CDP release commands for one {@link HeldState}: touch
 * cancels, a drag cancel, mouse button releases, then key releases (via
 * {@link buildKeyEvent}, so a synthesised key-up carries the same brand and
 * text handling as any other). `state` is not mutated; the caller clears it
 * after every command has actually been sent.
 */
export function buildReleaseCommands(state: HeldState): ReleaseCommand[] {
  const commands: ReleaseCommand[] = [];

  for (const _touchId of state.touchIds) {
    commands.push({
      method: 'Input.dispatchTouchEvent',
      params: { type: 'touchCancel', touchPoints: [], modifiers: state.modifiers },
    });
    break; // one touchCancel with an empty touchPoints array clears every active contact at once.
  }

  if (state.dragActive) {
    commands.push({
      method: 'Input.dispatchDragEvent',
      params: {
        type: 'dragCancel',
        x: state.lastPos.x,
        y: state.lastPos.y,
        modifiers: state.modifiers,
      },
    });
  }

  for (let bit = 1; bit <= 16; bit *= 2) {
    if ((state.buttons & bit) === 0) {
      continue;
    }
    commands.push({
      method: 'Input.dispatchMouseEvent',
      params: {
        type: 'mouseReleased',
        button: buttonNameForBit(bit),
        buttons: 0,
        x: state.lastPos.x,
        y: state.lastPos.y,
        modifiers: state.modifiers,
        clickCount: 1,
      },
    });
  }

  for (const code of state.keysDown) {
    const params = buildKeyEvent({ kind: 'up', key: '', code, modifiers: state.modifiers });
    if (params) {
      commands.push({
        method: 'Input.dispatchKeyEvent',
        params: params as unknown as Record<string, unknown>,
      });
    }
  }

  return commands;
}

/**
 * The CDP `button` name for the lowest set bit of a DOM
 * `MouseEvent.buttons` bitmask, or `'none'` when nothing is held.
 *
 * `Input.dispatchMouseEvent`'s `button` field is not decorative on a
 * `mouseMoved`: Chrome uses it to decide whether the move continues a drag
 * or is a plain hover. A move sent with `button: 'none'` while the left
 * button is physically down is a hover, so no text ever gets selected and
 * no drag ever starts, however faithfully `buttons` reports the held mask.
 * Verified against the running demo: an identical drag selected nothing
 * with `'none'` and selected the whole page (roughly 500,000 changed
 * pixels) with `'left'`.
 *
 * Left wins over right wins over middle when several are held, matching
 * the order Chrome itself reports a chord in.
 */
export function primaryHeldButtonName(buttons: number): string {
  for (const bit of [1, 2, 4, 8, 16]) {
    if ((buttons & bit) !== 0) return buttonNameForBit(bit);
  }
  return 'none';
}

/** DOM `MouseEvent.buttons` bit to CDP `button` name. */
function buttonNameForBit(bit: number): string {
  switch (bit) {
    case 1:
      return 'left';
    case 2:
      return 'right';
    case 4:
      return 'middle';
    case 8:
      return 'back';
    case 16:
      return 'forward';
    default:
      return 'none';
  }
}
