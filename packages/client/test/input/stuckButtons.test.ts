import type { InputMouse } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { makeInputCapture, pointerEvent } from './testHelpers.js';

describe('InputCapture: stuck-button defences', () => {
  it('defence 1: setPointerCapture keeps the button tracked as held across a down', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 10, clientY: 10, button: 0, buttons: 1 }),
    );
    // A subsequent up, even far outside the canvas, must resolve at a
    // sensible last-known position rather than being lost.
    canvas.dispatchEvent(
      pointerEvent('pointerup', { clientX: -999, clientY: -999, button: 0, buttons: 0 }),
    );
    const ups = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'up') as InputMouse[];
    expect(ups).toHaveLength(1);
  });

  it('defence 2: pointercancel synthesises an up at the last known position with buttons:0', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 20, clientY: 30, button: 0, buttons: 1 }),
    );
    sent.length = 0;
    canvas.dispatchEvent(pointerEvent('pointercancel', { clientX: 20, clientY: 30 }));
    expect(sent).toHaveLength(1);
    const up = sent[0] as InputMouse;
    expect(up.kind).toBe('up');
    expect(up.button).toBe('left');
    expect(up.buttons).toBe(0);
    expect(up.x).toBe(20);
    expect(up.y).toBe(30);
  });

  it('defence 2: lostpointercapture also synthesises an up', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }),
    );
    sent.length = 0;
    canvas.dispatchEvent(pointerEvent('lostpointercapture', {}));
    const ups = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'up') as InputMouse[];
    expect(ups).toHaveLength(1);
  });

  it('defence 2: does not double-fire once the button is already released', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 5, clientY: 5, button: 0, buttons: 1 }),
    );
    canvas.dispatchEvent(
      pointerEvent('pointerup', { clientX: 5, clientY: 5, button: 0, buttons: 0 }),
    );
    sent.length = 0;
    canvas.dispatchEvent(pointerEvent('pointercancel', { clientX: 5, clientY: 5 }));
    expect(sent).toHaveLength(0);
  });

  it('defence 3: releaseStuckButtons() sends a synthetic up for every button believed down, before anything else', () => {
    const { canvas, capture, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 15, clientY: 15, button: 0, buttons: 1 }),
    );
    sent.length = 0;
    capture.releaseStuckButtons();
    expect(sent).toHaveLength(1);
    const up = sent[0] as InputMouse;
    expect(up.kind).toBe('up');
    expect(up.x).toBe(15);
    expect(up.y).toBe(15);
    // A second call with nothing held sends nothing further.
    sent.length = 0;
    capture.releaseStuckButtons();
    expect(sent).toHaveLength(0);
  });

  it('defence 3: releases every distinct held button, not just the most recent', () => {
    const { canvas, capture, sent } = makeInputCapture();
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 1, clientY: 1, button: 0, buttons: 1 }),
    );
    canvas.dispatchEvent(
      pointerEvent('pointerdown', { clientX: 2, clientY: 2, button: 2, buttons: 3 }),
    );
    sent.length = 0;
    capture.releaseStuckButtons();
    const ups = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'up') as InputMouse[];
    expect(ups.map((u) => u.button).sort()).toEqual(['left', 'right']);
  });
});
