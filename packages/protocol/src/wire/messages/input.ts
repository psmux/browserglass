import type { Envelope } from '../envelope.js';

/**
 * Fields required on every input message. Coordinate spaces and key
 * tables are owned by `@browserglass/core`'s input module; this file
 * fixes wire shape only.
 */
export interface InputBase extends Envelope {
  targetId: string;
  /** Frame-space dims the coordinates were computed against. */
  fw: number;
  fh: number;
  /** Target generation the coordinates were computed against. NOT `sidEpoch`. */
  gen: number;
  /** The sender's ControlLease id. A new grant mints a new id. */
  leaseId: string;
}

/** C to S: pointer input. There is no `'enter'`/`'leave'` kind; CDP's dispatcher does not accept them. */
export interface InputMouse extends InputBase {
  t: 'input.mouse';
  kind: 'move' | 'down' | 'up' | 'wheel';
  /** Frame-space px, floats allowed. */
  x: number;
  y: number;
  button?: 'left' | 'middle' | 'right' | 'back' | 'forward' | 'none';
  /** Bitmask, DOM `MouseEvent.buttons` semantics. */
  buttons: number;
  /** Bit 1 Alt, 2 Ctrl, 4 Meta, 8 Shift (CDP order). */
  modifiers: number;
  clickCount?: number;
  /** Wheel only, CSS px. */
  dx?: number;
  dy?: number;
}

/** C to S: keyboard input. `kind` maps to CDP `keyDown`/`rawKeyDown`, `keyUp`, `char`. */
export interface InputKey extends InputBase {
  t: 'input.key';
  kind: 'down' | 'up' | 'char';
  /** DOM `KeyboardEvent.key`. */
  key: string;
  /** DOM `KeyboardEvent.code`. */
  code: string;
  modifiers: number;
  text?: string;
  repeat?: boolean;
  location?: 0 | 1 | 2 | 3;
}

/** C to S: text insertion, bypassing key events. */
export interface InputText extends InputBase {
  t: 'input.text';
  text: string;
}

/** CDP `Input.TouchPoint`. */
export interface TouchPoint {
  /** Stable for the life of the contact. */
  id: number;
  /** Frame-space px, same space as mouse. */
  x: number;
  y: number;
  radiusX?: number;
  radiusY?: number;
  rotationAngle?: number;
  /** 0.0 to 1.0. */
  force?: number;
  tangentialPressure?: number;
  tiltX?: number;
  tiltY?: number;
}

/** C to S: touch input. `points` is the full active set, not a delta. Max 10 (CDP's limit). */
export interface InputTouch extends InputBase {
  t: 'input.touch';
  kind: 'start' | 'move' | 'end' | 'cancel';
  points: TouchPoint[];
  modifiers: number;
}

/**
 * C to S: IME composition. Mapping to CDP is asymmetric: `'start'` and
 * `'update'` map to `Input.imeSetComposition`; `'end'` maps to
 * `Input.insertText` with the final string, then clears composition
 * state (NOT `imeSetComposition`). While a composition is active, the
 * client MUST NOT send `input.key`.
 */
export interface InputComposition extends InputBase {
  t: 'input.composition';
  kind: 'start' | 'update' | 'end';
  /** Current composition string. */
  text: string;
  selectionStart?: number;
  selectionEnd?: number;
  segments?: Array<{ start: number; end: number; style: 'underline' | 'thick' | 'none' }>;
}

/**
 * C to S: drag and drop. `kind` follows DOM drag event naming
 * (`dragenter`/`dragover`/`dragleave`/`drop`) and maps to CDP
 * `Input.dispatchDragEvent`'s own four values in that order: `dragEnter`,
 * `dragOver`, `drop`, `dragCancel`. There is no `input.drop`: it is
 * `input.drag` with `kind:'drop'`. `leave` maps to `dragCancel`: CDP has no
 * standalone "left the drop zone" verb, and a drag that leaves without
 * dropping is exactly a cancelled drag. See `@browserglass/core`'s
 * `input/dispatcher.ts` for the wired implementation, including the HTML5
 * fallback path (plain `input.mouse` down/move/up) for pages that never
 * fire a native drag at all.
 */
export interface InputDrag extends InputBase {
  t: 'input.drag';
  kind: 'enter' | 'over' | 'drop' | 'leave';
  x: number;
  y: number;
  modifiers: number;
  /** CDP `Input.DragData`, verbatim. `data.items[].data` carries mime-typed string data, never bytes. */
  data?: {
    items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }>;
    /** 1 copy, 2 link, 16 move, per CDP. */
    dragOperationsMask: number;
  };
}
