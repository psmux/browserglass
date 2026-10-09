import { describe, expect, it } from 'vitest';
import { CanvasRenderer } from '../../src/render/CanvasRenderer.js';

describe('CanvasRenderer construction: no desynchronized context', () => {
  it('never requests { desynchronized: true } and asserts against a context that reports it', () => {
    const canvas = document.createElement('canvas');
    (canvas as unknown as { __forceDesynchronized: boolean }).__forceDesynchronized = true;
    const container = document.createElement('div');
    expect(() => new CanvasRenderer(canvas, container)).toThrow(/desynchronized/i);
  });

  it('constructs normally against an ordinary context', () => {
    const canvas = document.createElement('canvas');
    const container = document.createElement('div');
    expect(() => new CanvasRenderer(canvas, container)).not.toThrow();
  });
});
