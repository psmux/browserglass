import type { Capability } from '@browserglass/protocol';
/**
 * `input.drag`'s capability gate. `checkCapability` runs on EVERY inbound
 * message (`capability-check.ts`'s own doc), so this pins the one row this
 * task added to `REQUIRED_CAPABILITY`: `input.drag` requires `control`,
 * exactly like every sibling `input.*` type.
 */
import { describe, expect, it } from 'vitest';
import { checkCapability } from '../../src/wire/capability-check.js';

describe('checkCapability: input.drag', () => {
  it('requires control, same as input.mouse/key/text/touch/composition', () => {
    const withoutControl: ReadonlySet<Capability> = new Set(['view']);
    const result = checkCapability('input.drag', {}, withoutControl);
    expect(result).toEqual({ ok: false, required: 'control' });
  });

  it('passes once control is granted', () => {
    const withControl: ReadonlySet<Capability> = new Set(['control']);
    const result = checkCapability('input.drag', {}, withControl);
    expect(result).toEqual({ ok: true });
  });
});
