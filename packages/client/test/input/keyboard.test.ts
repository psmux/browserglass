import type { InputKey } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { makeInputCapture } from './testHelpers.js';

function getImeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input');
  if (!input) throw new Error('hidden IME input not found');
  return input;
}

describe('InputCapture: keyboard', () => {
  it('forwards a printable keydown with text set to the key', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputKey;
    expect(msg.t).toBe('input.key');
    expect(msg.kind).toBe('down');
    expect(msg.key).toBe('a');
    expect(msg.code).toBe('KeyA');
    expect(msg.text).toBe('a');
  });

  it('omits text for a non-printable key (Enter, Escape, arrow keys)', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter' }));
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', code: 'ArrowLeft' }));
    for (const msg of sent as InputKey[]) {
      expect(msg.text).toBeUndefined();
    }
  });

  it('packs modifiers in CDP order: Alt 1, Ctrl 2, Meta 4, Shift 8', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, shiftKey: true }),
    );
    const msg = sent[0] as InputKey;
    expect(msg.modifiers).toBe(0x2 | 0x8);
  });

  it('forwards keyup without a repeat/text field', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    expect(sent).toHaveLength(1);
    expect((sent[0] as InputKey).kind).toBe('up');
  });

  it('does not attach keyboard listeners when keyboard:false', () => {
    const { container, sent } = makeInputCapture({ keyboard: false });
    const ime = getImeInput(container);
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect(sent).toHaveLength(0);
  });

  it('setLeaseId() changes the leaseId stamped on subsequent messages', () => {
    const { container, capture, sent } = makeInputCapture();
    const ime = getImeInput(container);
    capture.setLeaseId('lse_NEWLEASE000000000000000');
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect((sent[0] as InputKey).leaseId).toBe('lse_NEWLEASE000000000000000');
  });

  it('setTargetId() changes the targetId stamped on subsequent messages', () => {
    const { container, capture, sent } = makeInputCapture();
    const ime = getImeInput(container);
    capture.setTargetId('tgt_NEWTARGET00000000000000');
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect((sent[0] as InputKey).targetId).toBe('tgt_NEWTARGET00000000000000');
  });
});
