import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { printableKeyCode } from '../../src/keys.js';
import { connectFakeClient, tick } from '../helpers.js';

/**
 * Every printable character has to reach the page. A live run lost `#`
 * from every field and `!` from a password field, so a login with
 * "SuperSecretPassword!" failed without an exception. The client half of
 * that is here: each ASCII printable character goes out as its own key
 * event with the character as both `key` and `text`, and anything with no
 * key definition goes out as `input.text` for that one character. The
 * gateway half (the virtual key code Chrome is given) is tested in
 * `packages/core/test/input/key-events.test.ts`.
 */
const ASCII = Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i)).join('');
const NON_ASCII = '\u00e9\u00fc\u00f1\u65e5\u{1F600}';

describe('typing every printable character', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('has a key definition for every ASCII printable character, and none for non ASCII', () => {
    for (const ch of ASCII) {
      const kc = printableKeyCode(ch);
      expect(kc, JSON.stringify(ch)).toBeDefined();
      expect(kc?.key).toBe(ch);
      expect(kc?.code).toMatch(/^(Key[A-Z]|Digit[0-9]|[A-Z][a-zA-Z]+)$/);
    }
    for (const ch of NON_ASCII) expect(printableKeyCode(ch)).toBeUndefined();
  });

  for (const verb of ['type', 'humanType'] as const) {
    it(`${verb}() sends one key pair per ASCII character and input.text for the rest`, async () => {
      const { client, gateway } = await connectFakeClient();
      await client.inspectAt(0, 0);
      const leasePromise = client.acquireControl({ waitMs: 5000 });
      await tick();
      await leasePromise;

      const text = ASCII + NON_ASCII;
      const p = verb === 'type' ? client.type(text) : client.humanType(text, { delayMs: 0 });
      await tick(100);
      await p;

      const sent = gateway.ws
        .sentJsonMessages()
        .filter((m) => m['t'] === 'input.key' || m['t'] === 'input.text');
      // Rebuild what the page would receive: the `text` of each keydown,
      // plus each input.text.
      let typed = '';
      for (const m of sent) {
        if (m['t'] === 'input.text') typed += m['text'] as string;
        else if (m['kind'] === 'down') {
          expect(m['key']).toBe(m['text']);
          expect(m['modifiers']).toBe(0);
          typed += m['text'] as string;
        }
      }
      expect(typed).toBe(text);
      const downs = sent.filter((m) => m['t'] === 'input.key' && m['kind'] === 'down');
      const ups = sent.filter((m) => m['t'] === 'input.key' && m['kind'] === 'up');
      expect(downs).toHaveLength(ASCII.length);
      expect(ups).toHaveLength(ASCII.length);
      expect(sent.filter((m) => m['t'] === 'input.text').map((m) => m['text'])).toEqual([
        ...NON_ASCII,
      ]);
      client.close();
    });
  }
});
