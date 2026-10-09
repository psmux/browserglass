/**
 * Fencing by target `gen`: coordinates computed against a superseded target
 * generation (post-resize, post-navigation) are stale. Distinct from, and a
 * sibling to, `../control/fencing.ts`'s `leaseId` fencing: the same input
 * message is checked against both tables, and `resolveInputFencing`'s
 * {@link import('../control/fencing.js').ALWAYS_DISPATCHED_KINDS} class
 * (mouse up, key up, touch end, touch cancel) is exactly the class this
 * module also never silently drops, it dispatches at the last known
 * position instead.
 */

import type { InputFenceKind } from '../control/fencing.js';

/**
 * What a stale-`gen` input message should do. `'dispatch'` covers both a
 * current `gen` and the gen-irrelevant key events (no coordinates involved).
 * `'dispatch_at_last_position'` is the release-class exception: never drop a
 * `mouse.up`/`touch.end`/`touch.cancel`, dispatch it at the last dispatched
 * position instead. `'drop'` is silent. `'drop_with_error'` additionally
 * signals a throttled `bgls.error.input.gen_stale` (currently only
 * `mouse.down`, per the source table).
 */
export type InputGenAction = 'dispatch' | 'dispatch_at_last_position' | 'drop' | 'drop_with_error';

/** The outcome of a `gen` staleness check for one input message. */
export interface GenFenceDecision {
  readonly action: InputGenAction;
  readonly stale: boolean;
}

const DISPATCH_AT_LAST_POSITION: ReadonlySet<InputFenceKind> = new Set([
  'mouse.up',
  'touch.end',
  'touch.cancel',
  // `drag.drop`/`drag.leave` close a drag the way `mouse.up` closes a
  // click-drag: never dropped for a stale gen, dispatched at the last
  // dispatched position instead.
  'drag.drop',
  'drag.leave',
]);

const DROP_SILENTLY: ReadonlySet<InputFenceKind> = new Set([
  'mouse.move',
  'mouse.wheel',
  'touch.start',
  'touch.move',
  // `drag.enter`/`drag.over` carry coordinates the same way `touch.start`/
  // `touch.move` do, and get the same treatment: a stale one is simply
  // superseded, not an error worth signalling.
  'drag.enter',
  'drag.over',
]);

/**
 * Decides what to do with one input message given the target's current
 * generation and the generation the message's coordinates were computed
 * against. Key events (`key.down`, `key.up`, `key.char`) always dispatch:
 * they carry no coordinates, so `gen` is irrelevant to them.
 */
export function resolveGenFencing(
  currentGen: number,
  messageGen: number,
  kind: InputFenceKind,
): GenFenceDecision {
  const stale = currentGen !== messageGen;
  if (!stale) {
    return { action: 'dispatch', stale: false };
  }
  if (DISPATCH_AT_LAST_POSITION.has(kind)) {
    return { action: 'dispatch_at_last_position', stale: true };
  }
  if (kind === 'mouse.down') {
    return { action: 'drop_with_error', stale: true };
  }
  if (DROP_SILENTLY.has(kind)) {
    return { action: 'drop', stale: true };
  }
  // key.down, key.up, key.char, and anything else with no coordinate basis.
  return { action: 'dispatch', stale: true };
}
