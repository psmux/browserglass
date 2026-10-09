import type { InputMouse } from '@browserglass/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeInputCapture, pointerEvent } from './testHelpers.js';

describe('InputCapture: pointer down/move/up', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls setPointerCapture on down and sends input.mouse kind:down with a client-computed clickCount', () => {
    const { canvas, sent } = makeInputCapture();
    const spy = vi.spyOn(canvas, 'setPointerCapture');
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 20 }));
    expect(spy).toHaveBeenCalledWith(1);
    expect(sent).toHaveLength(1);
    const msg = sent[0] as InputMouse;
    expect(msg.t).toBe('input.mouse');
    expect(msg.kind).toBe('down');
    expect(msg.x).toBe(10);
    expect(msg.y).toBe(20);
    expect(msg.clickCount).toBe(1);
    expect(msg.targetId).toBe('tgt_TESTTARGET00000000000000');
    expect(msg.leaseId).toBe('lse_TESTLEASE0000000000000000');
    expect(msg.fw).toBe(200);
    expect(msg.fh).toBe(200);
    expect(msg.gen).toBe(1);
  });

  it('increments clickCount for consecutive downs within 500ms and 5 CSS px, resets otherwise', () => {
    let nowMs = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => nowMs);
    const { canvas, sent } = makeInputCapture();

    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    nowMs = 100;
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 12, clientY: 11 }));
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 12, clientY: 11 }));
    nowMs = 900; // beyond the 500ms window
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 12, clientY: 11 }));

    const downs = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'down') as InputMouse[];
    expect(downs.map((m) => m.clickCount)).toEqual([1, 2, 1]);
  });

  it('resets clickCount when a down lands more than 5 CSS px from the previous one', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 40, clientY: 10 }));
    const downs = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'down') as InputMouse[];
    expect(downs.map((m) => m.clickCount)).toEqual([1, 1]);
  });

  it('always sends up, regardless of whether the pointer is currently inside the canvas', () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
    // Way outside the 200x200 canvas: setPointerCapture means this still fires.
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: -500, clientY: -500 }));
    const ups = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'up') as InputMouse[];
    expect(ups).toHaveLength(1);
  });

  it('coalesces moves to one per animation frame via getCoalescedEvents(), last position wins', async () => {
    const { canvas, sent } = makeInputCapture();
    // The dispatched event's own top-level clientX/Y (99,99) is a stale
    // placeholder; the real, most recent sample lives in the coalesced
    // batch. If the handler used the raw event instead of
    // getCoalescedEvents(), this would send (99,99).
    const e1 = pointerEvent('pointermove', { clientX: 1, clientY: 1 });
    const e2 = pointerEvent('pointermove', { clientX: 2, clientY: 2 });
    const dispatched = pointerEvent('pointermove', {
      clientX: 99,
      clientY: 99,
      coalescedEvents: [e1, e2],
    });
    canvas.dispatchEvent(dispatched);
    await new Promise((r) => setTimeout(r, 20));
    const moves = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'move') as InputMouse[];
    expect(moves).toHaveLength(1);
    expect(moves[0]!.x).toBe(2);
    expect(moves[0]!.y).toBe(2);
  });

  it('drops a no-button-held move once outside the canvas, sending nothing', async () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 500, clientY: 500, buttons: 0 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent).toHaveLength(0);
  });

  it('keeps sending unclamped moves outside the canvas while a button is held (drag)', async () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 10, clientY: 10 }));
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: -50, clientY: 500, buttons: 1 }));
    await new Promise((r) => setTimeout(r, 20));
    const moves = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'move') as InputMouse[];
    expect(moves).toHaveLength(1);
    expect(moves[0]!.x).toBe(-50);
    expect(moves[0]!.y).toBe(500);
  });
});
