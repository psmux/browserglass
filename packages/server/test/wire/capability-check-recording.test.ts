import type { Capability } from '@browserglass/protocol';
/**
 * `recording.start`/`.stop`/`.list`'s capability gate. `checkCapability`
 * only enforces the BASE capability (`capture`, see `capability-check.ts`'s
 * own comment on these three table entries for why `capture` is the base
 * and why `download` cannot be layered on through a `ParamCapabilityRule`
 * here); the second half of the gate (`download`) is enforced by
 * `ws/connection.ts`'s `requireDownloadCapability`, a handler-level check
 * this test cannot reach without a live socket, so it is asserted
 * separately (see `test/ws/recording.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { checkCapability } from '../../src/wire/capability-check.js';

describe('checkCapability: recording.*', () => {
  it.each(['recording.start', 'recording.stop', 'recording.list'] as const)(
    '%s requires capture',
    (t) => {
      const withoutCapture: ReadonlySet<Capability> = new Set(['view', 'download']);
      expect(checkCapability(t, {}, withoutCapture)).toEqual({ ok: false, required: 'capture' });
    },
  );

  it.each(['recording.start', 'recording.stop', 'recording.list'] as const)(
    '%s passes checkCapability once capture is granted (download is checked separately, by the handler)',
    (t) => {
      const withCapture: ReadonlySet<Capability> = new Set(['capture']);
      expect(checkCapability(t, {}, withCapture)).toEqual({ ok: true });
    },
  );

  it('does not widen target.capture/page.pdf.get: neither gains a download requirement from sharing the capture base', () => {
    const captureOnly: ReadonlySet<Capability> = new Set(['capture']);
    expect(checkCapability('target.capture', {}, captureOnly)).toEqual({ ok: true });
    expect(checkCapability('page.pdf.get', {}, captureOnly)).toEqual({ ok: true });
  });
});
