/**
 * Input message validation: every field checked before use, unknown fields
 * stripped rather than forwarded, and nothing here ever spreads the raw
 * client message into the returned value (`{...msg}` is banned; every
 * validator builds its result field by field, the same discipline
 * `cdp-allowlist.ts` requires of the CDP params built downstream of it).
 * The `validateMouse` pattern is generalised to every wire input message
 * type.
 */

import type {
  InputComposition,
  InputDrag,
  InputKey,
  InputMouse,
  InputText,
  InputTouch,
  TouchPoint,
} from '@browserglass/protocol';
import type { InputFenceKind } from '../control/fencing.js';

/** One validation failure: which field, and why. */
export interface ValidationError {
  readonly ok: false;
  readonly field: string;
  readonly message: string;
}

/** A validated value, or the failure that rejected it. */
export type ValidationResult<T> = { readonly ok: true; readonly value: T } | ValidationError;

function err(field: string, message: string): ValidationError {
  return { ok: false, field, message };
}

const FINITE = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
const IS_INT = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Validates the four {@link import('@browserglass/protocol').InputBase}
 * fields shared by every input message. `targetId` is read straight off the
 * message, not compared against anything external: the dispatcher routes
 * purely on this value (keyed straight off `msg.targetId` with no lookup),
 * and an unresolvable target
 * is caught downstream when the dispatcher's target resolver returns
 * nothing for it, not here.
 */
function validateBase(m: Record<string, unknown>): ValidationError | null {
  if (
    typeof m['targetId'] !== 'string' ||
    m['targetId'].length === 0 ||
    m['targetId'].length > 128
  ) {
    return err('targetId', 'targetId missing or malformed');
  }
  const fw = m['fw'];
  if (!IS_INT(fw) || fw < 1 || fw > 16384) {
    return err('fw', 'fw must be an integer in [1, 16384]');
  }
  const fh = m['fh'];
  if (!IS_INT(fh) || fh < 1 || fh > 16384) {
    return err('fh', 'fh must be an integer in [1, 16384]');
  }
  const gen = m['gen'];
  if (!IS_INT(gen) || gen < 0) {
    return err('gen', 'gen must be a non-negative integer');
  }
  const leaseId = m['leaseId'];
  if (typeof leaseId !== 'string' || leaseId.length === 0 || leaseId.length > 128) {
    return err('leaseId', 'leaseId missing or too long');
  }
  return null;
}

function validateModifiers(m: Record<string, unknown>): ValidationError | null {
  const modifiers = m['modifiers'];
  if (!IS_INT(modifiers) || modifiers < 0 || modifiers > 15) {
    return err('modifiers', 'modifiers must be an integer in [0, 15]');
  }
  return null;
}

/** Validates and strips an `input.mouse` message. */
export function validateMouse(raw: unknown): ValidationResult<InputMouse> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.mouse') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const kind = raw['kind'];
  if (kind !== 'move' && kind !== 'down' && kind !== 'up' && kind !== 'wheel') {
    return err('kind', 'kind must be one of move, down, up, wheel');
  }
  const x = raw['x'];
  const y = raw['y'];
  if (!FINITE(x) || !FINITE(y)) {
    return err('coords', 'x and y must be finite numbers');
  }
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
    return err('coords', 'x/y implausibly large');
  }
  const modifiersErr = validateModifiers(raw);
  if (modifiersErr) {
    return modifiersErr;
  }
  const buttons = raw['buttons'];
  if (!IS_INT(buttons) || buttons < 0 || buttons > 31) {
    return err('buttons', 'buttons must be an integer in [0, 31]');
  }
  const button = raw['button'];
  if (
    button !== undefined &&
    !['left', 'middle', 'right', 'back', 'forward', 'none'].includes(button as string)
  ) {
    return err('button', 'unrecognised button name');
  }
  let clickCount: number | undefined;
  if (kind === 'down' || kind === 'up') {
    const cc = raw['clickCount'];
    if (cc !== undefined) {
      if (!IS_INT(cc) || cc < 1 || cc > 3) {
        return err('clickCount', 'clickCount must be an integer in [1, 3]');
      }
      clickCount = cc;
    }
  }
  let dx: number | undefined;
  let dy: number | undefined;
  if (kind === 'wheel') {
    const rawDx = raw['dx'];
    const rawDy = raw['dy'];
    if (rawDx !== undefined) {
      if (!FINITE(rawDx) || Math.abs(rawDx) > 1e5) {
        return err('dx', 'dx must be a finite number with magnitude at most 1e5');
      }
      dx = rawDx;
    }
    if (rawDy !== undefined) {
      if (!FINITE(rawDy) || Math.abs(rawDy) > 1e5) {
        return err('dy', 'dy must be a finite number with magnitude at most 1e5');
      }
      dy = rawDy;
    }
  }

  const value: InputMouse = {
    v: 1,
    t: 'input.mouse',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    kind,
    x,
    y,
    buttons,
    modifiers: raw['modifiers'] as number,
    ...(button !== undefined ? { button: button as Exclude<InputMouse['button'], undefined> } : {}),
    ...(clickCount !== undefined ? { clickCount } : {}),
    ...(dx !== undefined ? { dx } : {}),
    ...(dy !== undefined ? { dy } : {}),
  };
  return { ok: true, value };
}

/** Validates and strips an `input.key` message. */
export function validateKey(raw: unknown): ValidationResult<InputKey> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.key') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const kind = raw['kind'];
  if (kind !== 'down' && kind !== 'up' && kind !== 'char') {
    return err('kind', 'kind must be one of down, up, char');
  }
  const key = raw['key'];
  if (typeof key !== 'string' || key.length > 32 || hasControlChars(key)) {
    return err('key', 'key must be a string of at most 32 characters with no control characters');
  }
  const code = raw['code'];
  if (typeof code !== 'string' || code.length > 32 || hasControlChars(code)) {
    return err('code', 'code must be a string of at most 32 characters with no control characters');
  }
  const modifiersErr = validateModifiers(raw);
  if (modifiersErr) {
    return modifiersErr;
  }
  const rawText = raw['text'];
  let text: string | undefined;
  if (rawText !== undefined) {
    if (typeof rawText !== 'string' || [...rawText].length > 8) {
      return err('text', 'text must be a string of at most 8 code points');
    }
    text = rawText;
  }
  const rawRepeat = raw['repeat'];
  const repeat = typeof rawRepeat === 'boolean' ? rawRepeat : undefined;
  const rawLocation = raw['location'];
  let location: 0 | 1 | 2 | 3 | undefined;
  if (rawLocation !== undefined) {
    if (rawLocation !== 0 && rawLocation !== 1 && rawLocation !== 2 && rawLocation !== 3) {
      return err('location', 'location must be 0, 1, 2, or 3');
    }
    location = rawLocation;
  }

  const value: InputKey = {
    v: 1,
    t: 'input.key',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    kind,
    key,
    code,
    modifiers: raw['modifiers'] as number,
    ...(text !== undefined ? { text } : {}),
    ...(repeat !== undefined ? { repeat } : {}),
    ...(location !== undefined ? { location: location as 0 | 1 | 2 | 3 } : {}),
  };
  return { ok: true, value };
}

/** Validates and strips an `input.text` message. */
export function validateText(raw: unknown): ValidationResult<InputText> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.text') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const text = raw['text'];
  if (typeof text !== 'string' || text.length > 8192) {
    return err('text', 'text must be a string of at most 8192 characters');
  }
  const value: InputText = {
    v: 1,
    t: 'input.text',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    text,
  };
  return { ok: true, value };
}

function validateTouchPoint(raw: unknown): ValidationResult<TouchPoint> {
  if (!isPlainObject(raw)) {
    return err('points[]', 'touch point must be an object');
  }
  const id = raw['id'];
  if (!IS_INT(id) || id < 0 || id > 65535) {
    return err('points[].id', 'id must be an integer in [0, 65535]');
  }
  const x = raw['x'];
  const y = raw['y'];
  if (!FINITE(x) || !FINITE(y)) {
    return err('points[].coords', 'x and y must be finite numbers');
  }
  const value: TouchPoint = { id, x, y };
  const radiusX = raw['radiusX'];
  const radiusY = raw['radiusY'];
  const rotationAngle = raw['rotationAngle'];
  const force = raw['force'];
  const tangentialPressure = raw['tangentialPressure'];
  const tiltX = raw['tiltX'];
  const tiltY = raw['tiltY'];
  if (FINITE(radiusX)) value.radiusX = radiusX;
  if (FINITE(radiusY)) value.radiusY = radiusY;
  if (FINITE(rotationAngle)) value.rotationAngle = rotationAngle;
  if (FINITE(force)) value.force = force;
  if (FINITE(tangentialPressure)) value.tangentialPressure = tangentialPressure;
  if (FINITE(tiltX)) value.tiltX = tiltX;
  if (FINITE(tiltY)) value.tiltY = tiltY;
  return { ok: true, value };
}

/** Validates and strips an `input.touch` message. */
export function validateTouch(raw: unknown): ValidationResult<InputTouch> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.touch') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const kind = raw['kind'];
  if (kind !== 'start' && kind !== 'move' && kind !== 'end' && kind !== 'cancel') {
    return err('kind', 'kind must be one of start, move, end, cancel');
  }
  const rawPoints = raw['points'];
  if (!Array.isArray(rawPoints) || rawPoints.length > 10) {
    return err('points', 'points must be an array of at most 10 entries');
  }
  const points: TouchPoint[] = [];
  for (const p of rawPoints) {
    const result = validateTouchPoint(p);
    if (!result.ok) {
      return result;
    }
    points.push(result.value);
  }
  const modifiersErr = validateModifiers(raw);
  if (modifiersErr) {
    return modifiersErr;
  }
  const value: InputTouch = {
    v: 1,
    t: 'input.touch',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    kind,
    points,
    modifiers: raw['modifiers'] as number,
  };
  return { ok: true, value };
}

/** Validates and strips an `input.composition` message. */
export function validateComposition(raw: unknown): ValidationResult<InputComposition> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.composition') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const kind = raw['kind'];
  if (kind !== 'start' && kind !== 'update' && kind !== 'end') {
    return err('kind', 'kind must be one of start, update, end');
  }
  const text = raw['text'];
  if (typeof text !== 'string' || text.length > 8192) {
    return err('text', 'text must be a string of at most 8192 characters');
  }
  const value: InputComposition = {
    v: 1,
    t: 'input.composition',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    kind,
    text,
  };
  const selectionStart = raw['selectionStart'];
  const selectionEnd = raw['selectionEnd'];
  if (IS_INT(selectionStart)) value.selectionStart = selectionStart;
  if (IS_INT(selectionEnd)) value.selectionEnd = selectionEnd;
  return { ok: true, value };
}

/**
 * Validates and strips an `input.drag` message. `kind` is DOM drag event
 * naming (`enter`/`over`/`drop`/`leave`); `dispatcher.ts` maps it onto
 * CDP's own `dragEnter`/`dragOver`/`drop`/`dragCancel`. `data`, when
 * present, is rebuilt field by field, the same discipline every other
 * validator here follows: `{...rawItem}` is never spread into the result.
 */
export function validateDrag(raw: unknown): ValidationResult<InputDrag> {
  if (!isPlainObject(raw)) {
    return err('_root', 'not an object');
  }
  if (raw['t'] !== 'input.drag') {
    return err('t', 'wrong message type');
  }
  const base = validateBase(raw);
  if (base) {
    return base;
  }
  const kind = raw['kind'];
  if (kind !== 'enter' && kind !== 'over' && kind !== 'drop' && kind !== 'leave') {
    return err('kind', 'kind must be one of enter, over, drop, leave');
  }
  const x = raw['x'];
  const y = raw['y'];
  if (!FINITE(x) || !FINITE(y)) {
    return err('coords', 'x and y must be finite numbers');
  }
  if (Math.abs(x) > 1e6 || Math.abs(y) > 1e6) {
    return err('coords', 'x/y implausibly large');
  }
  const modifiersErr = validateModifiers(raw);
  if (modifiersErr) {
    return modifiersErr;
  }

  let data: InputDrag['data'];
  const rawData = raw['data'];
  if (rawData !== undefined) {
    if (!isPlainObject(rawData)) {
      return err('data', 'data must be an object');
    }
    const rawItems = rawData['items'];
    if (!Array.isArray(rawItems) || rawItems.length > 32) {
      return err('data.items', 'data.items must be an array of at most 32 entries');
    }
    const items: Array<{ mimeType: string; data: string; title?: string; baseURL?: string }> = [];
    for (const rawItem of rawItems) {
      if (!isPlainObject(rawItem)) {
        return err('data.items[]', 'each drag data item must be an object');
      }
      const mimeType = rawItem['mimeType'];
      if (typeof mimeType !== 'string' || mimeType.length === 0 || mimeType.length > 256) {
        return err(
          'data.items[].mimeType',
          'mimeType must be a non-empty string of at most 256 characters',
        );
      }
      const itemData = rawItem['data'];
      if (typeof itemData !== 'string' || itemData.length > 65536) {
        return err('data.items[].data', 'data must be a string of at most 65536 characters');
      }
      const item: { mimeType: string; data: string; title?: string; baseURL?: string } = {
        mimeType,
        data: itemData,
      };
      const title = rawItem['title'];
      if (typeof title === 'string') {
        item.title = title;
      }
      const baseURL = rawItem['baseURL'];
      if (typeof baseURL === 'string') {
        item.baseURL = baseURL;
      }
      items.push(item);
    }
    // Per `@browserglass/protocol`'s own doc on `InputDrag.data`: 1 copy, 2
    // link, 16 move (CDP's `Input.DragData.dragOperationsMask`); 19 (all
    // three combined) is the highest meaningful value, bounded generously
    // to 31 the same way `modifiers`/`buttons` bound their own bitmasks.
    const dragOperationsMask = rawData['dragOperationsMask'];
    if (!IS_INT(dragOperationsMask) || dragOperationsMask < 0 || dragOperationsMask > 31) {
      return err('data.dragOperationsMask', 'dragOperationsMask must be an integer in [0, 31]');
    }
    data = { items, dragOperationsMask };
  }

  const value: InputDrag = {
    v: 1,
    t: 'input.drag',
    ts: FINITE(raw['ts']) ? (raw['ts'] as number) : 0,
    targetId: raw['targetId'] as string,
    fw: raw['fw'] as number,
    fh: raw['fh'] as number,
    gen: raw['gen'] as number,
    leaseId: raw['leaseId'] as string,
    kind,
    x,
    y,
    modifiers: raw['modifiers'] as number,
    ...(data !== undefined ? { data } : {}),
  };
  return { ok: true, value };
}

function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** Classifies a validated input message into `../control/fencing.ts`'s {@link InputFenceKind} taxonomy. */
export function fenceKindOf(
  msg: InputMouse | InputKey | InputText | InputTouch | InputComposition | InputDrag,
): InputFenceKind {
  if (msg.t === 'input.mouse') {
    return `mouse.${msg.kind}` as InputFenceKind;
  }
  if (msg.t === 'input.key') {
    return `key.${msg.kind}` as InputFenceKind;
  }
  if (msg.t === 'input.touch') {
    return `touch.${msg.kind}` as InputFenceKind;
  }
  if (msg.t === 'input.drag') {
    return `drag.${msg.kind}` as InputFenceKind;
  }
  return 'other';
}
