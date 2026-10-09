import type { InputComposition, InputKey, InputText } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { makeInputCapture, pointerEvent } from './testHelpers.js';

function getImeInput(container: HTMLElement): HTMLInputElement {
  const input = container.querySelector('input');
  if (!input) throw new Error('hidden IME input not found');
  return input;
}

describe('InputCapture: IME and composition (the six-step sequence)', () => {
  it('step 1: the hidden input is positioned under the last pointerdown, never at (0,0)', () => {
    const { canvas, container } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 77, clientY: 55, button: 0, buttons: 1 }),
    );
    const ime = getImeInput(container);
    expect(ime.style.left).toBe('77px');
    expect(ime.style.top).toBe('55px');
  });

  it('step 2: compositionstart suppresses keydown/keyup entirely and sends kind:start', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    expect(sent).toHaveLength(1);
    expect((sent[0] as InputComposition).kind).toBe('start');

    sent.length = 0;
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    ime.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    expect(sent).toHaveLength(0);
  });

  it('step 3: compositionupdate sends kind:update with the in-progress text', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    sent.length = 0;
    ime.dispatchEvent(new CompositionEvent('compositionupdate', { data: 'あ' }));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputComposition;
    expect(msg.kind).toBe('update');
    expect(msg.text).toBe('あ');
  });

  it('step 4: compositionend sends kind:end with the final string, and clears the hidden input', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.value = 'partial';
    ime.dispatchEvent(new CompositionEvent('compositionstart', { data: '' }));
    sent.length = 0;
    ime.dispatchEvent(new CompositionEvent('compositionend', { data: 'あい' }));
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputComposition;
    expect(msg.kind).toBe('end');
    expect(msg.text).toBe('あい');
    expect(ime.value).toBe('');

    // Keydown forwarding resumes once composition has ended.
    sent.length = 0;
    ime.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    expect(sent).toHaveLength(1);
    expect((sent[0] as InputKey).t).toBe('input.key');
  });

  it('step 5: beforeinput insertText with no active composition sends input.text', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    const event = new InputEvent('beforeinput', {
      inputType: 'insertText',
      data: 'hello',
      cancelable: true,
    });
    ime.dispatchEvent(event);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputText;
    expect(msg.t).toBe('input.text');
    expect(msg.text).toBe('hello');
  });

  it('step 5: beforeinput deleteContentBackward sends a synthetic Backspace down/up pair', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    const event = new InputEvent('beforeinput', {
      inputType: 'deleteContentBackward',
      cancelable: true,
    });
    ime.dispatchEvent(event);
    expect(sent).toHaveLength(2);
    expect((sent[0] as InputKey).kind).toBe('down');
    expect((sent[0] as InputKey).key).toBe('Backspace');
    expect((sent[1] as InputKey).kind).toBe('up');
    expect((sent[1] as InputKey).key).toBe('Backspace');
  });

  it('step 6: cancelComposition() sends kind:end,text:"" and is idempotent', () => {
    const { container, capture, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ' }));
    sent.length = 0;
    capture.cancelComposition();
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputComposition;
    expect(msg.kind).toBe('end');
    expect(msg.text).toBe('');

    // No active composition: a second call sends nothing further.
    sent.length = 0;
    capture.cancelComposition();
    expect(sent).toHaveLength(0);
  });

  it('step 6: blurring the hidden input while composing cancels the composition', () => {
    const { container, sent } = makeInputCapture();
    const ime = getImeInput(container);
    ime.dispatchEvent(new CompositionEvent('compositionstart', { data: 'あ' }));
    sent.length = 0;
    ime.dispatchEvent(new FocusEvent('blur'));
    expect(sent).toHaveLength(1);
    expect((sent[0] as InputComposition).kind).toBe('end');
  });
});
