import type { InputMouse } from '@browserglass/protocol';
import { describe, expect, it, vi } from 'vitest';
import { InputCapture } from '../../src/input/InputCapture.js';
import { normalizeWheelDelta } from '../../src/input/wheel.js';
import { makeInputCapture } from './testHelpers.js';

function wheelEvent(init: Partial<WheelEventInit> = {}): WheelEvent {
  return new WheelEvent('wheel', {
    bubbles: true,
    cancelable: true,
    clientX: 50,
    clientY: 50,
    deltaX: 0,
    deltaY: 100,
    deltaMode: 0,
    ...init,
  });
}

describe('InputCapture: wheel', () => {
  it('is attached imperatively with { passive: false }, not through a JSX prop', () => {
    const canvas = document.createElement('canvas');
    const addSpy = vi.spyOn(canvas, 'addEventListener');
    const container = document.createElement('div');
    container.appendChild(canvas);
    // Constructing directly (bypassing the shared helper) to inspect the
    // exact addEventListener call the constructor makes.
    new InputCapture(canvas, container, {
      renderer: {
        toFrame: () => ({ x: 0, y: 0, inside: true }),
        frameSize: () => ({ fw: 1, fh: 1, gen: 0 }),
      },
      targetId: 't',
      leaseId: 'l',
      send: () => {},
    });
    const wheelCall = addSpy.mock.calls.find((c) => c[0] === 'wheel');
    expect(wheelCall).toBeDefined();
    expect(wheelCall![2]).toEqual({ passive: false });
  });

  it('preventDefault()s the wheel event (the passive-listener trap)', () => {
    const { canvas } = makeInputCapture();
    const e = wheelEvent();
    const spy = vi.spyOn(e, 'preventDefault');
    canvas.dispatchEvent(e);
    expect(spy).toHaveBeenCalled();
  });

  it('coalesces multiple wheel events within one animation frame by summing deltas', async () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(wheelEvent({ deltaX: 5, deltaY: 10 }));
    canvas.dispatchEvent(wheelEvent({ deltaX: 5, deltaY: 10 }));
    canvas.dispatchEvent(wheelEvent({ deltaX: 5, deltaY: 10 }));
    await new Promise((r) => setTimeout(r, 20));
    const wheels = sent.filter((m) => m.t === 'input.mouse' && m.kind === 'wheel') as InputMouse[];
    expect(wheels).toHaveLength(1);
    expect(wheels[0]!.dx).toBe(15);
    expect(wheels[0]!.dy).toBe(30);
  });

  it('normalizes deltaMode 1 (line) by x16 and deltaMode 2 (page) by frame height', () => {
    expect(normalizeWheelDelta(1, 2, 1, 900)).toEqual([16, 32]);
    expect(normalizeWheelDelta(0, 1, 2, 540)).toEqual([0, 540]);
    expect(normalizeWheelDelta(3, 4, 0, 540)).toEqual([3, 4]); // pixel mode: pass-through
  });

  it('sends nothing when the wheel position is outside the canvas', async () => {
    const { canvas, sent } = makeInputCapture();
    canvas.dispatchEvent(wheelEvent({ clientX: 9999, clientY: 9999 }));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.filter((m) => m.t === 'input.mouse' && m.kind === 'wheel')).toHaveLength(0);
  });
});
