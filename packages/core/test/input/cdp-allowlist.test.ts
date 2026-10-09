import { describe, expect, it } from 'vitest';
import {
  ALLOWED_INPUT_METHODS,
  InputCdpAllowlistError,
  isAllowedInputMethod,
  sendInputCommand,
} from '../../src/input/cdp-allowlist.js';
import { buildKeyEvent } from '../../src/input/key-events.js';
import { FakeCdpSender } from './test-helpers.js';

describe('ALLOWED_INPUT_METHODS', () => {
  it('is exactly the seven Input.* methods the doc allows', () => {
    expect([...ALLOWED_INPUT_METHODS].sort()).toEqual(
      [
        'Input.dispatchDragEvent',
        'Input.dispatchKeyEvent',
        'Input.dispatchMouseEvent',
        'Input.dispatchTouchEvent',
        'Input.imeSetComposition',
        'Input.insertText',
        'Input.setIgnoreInputEvents',
      ].sort(),
    );
  });

  it('isAllowedInputMethod rejects anything outside the list, including a dangerous method', () => {
    expect(isAllowedInputMethod('Runtime.evaluate')).toBe(false);
    expect(isAllowedInputMethod('Page.navigate')).toBe(false);
    expect(isAllowedInputMethod('Input.dispatchMouseEvent')).toBe(true);
  });
});

describe('sendInputCommand', () => {
  it('throws synchronously, before touching the bridge, for a method outside the allowlist', () => {
    const bridge = new FakeCdpSender();
    expect(() =>
      sendInputCommand(bridge, 'Runtime.evaluate', { expression: '1' }, 'sess-1' as never),
    ).toThrow(InputCdpAllowlistError);
    expect(bridge.calls).toHaveLength(0);
  });

  it('sends an allowed non-key method straight through', async () => {
    const bridge = new FakeCdpSender();
    await sendInputCommand(
      bridge,
      'Input.dispatchMouseEvent',
      { type: 'mouseMoved', x: 1, y: 2 },
      'sess-1' as never,
    );
    expect(bridge.calls).toHaveLength(1);
    expect(bridge.calls[0]?.method).toBe('Input.dispatchMouseEvent');
  });

  it('refuses Input.dispatchKeyEvent params that were not produced by buildKeyEvent (no hardened brand)', () => {
    const bridge = new FakeCdpSender();
    const unbranded = {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 0,
      text: 'a',
      unmodifiedText: 'a',
    };
    expect(() =>
      sendInputCommand(bridge, 'Input.dispatchKeyEvent', unbranded, 'sess-1' as never),
    ).toThrow(InputCdpAllowlistError);
    expect(bridge.calls).toHaveLength(0);
  });

  it('accepts Input.dispatchKeyEvent params produced by buildKeyEvent: every dispatchKeyEvent call in this package routes through it', async () => {
    const bridge = new FakeCdpSender();
    const params = buildKeyEvent({ kind: 'down', key: 'a', code: 'KeyA', modifiers: 0 });
    expect(params).not.toBeNull();
    await sendInputCommand(
      bridge,
      'Input.dispatchKeyEvent',
      params as unknown as Record<string, unknown>,
      'sess-1' as never,
    );
    expect(bridge.calls).toHaveLength(1);
  });
});
