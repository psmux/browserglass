/**
 * `pdf/print-to-pdf.ts`.
 *
 * Mirrors `cdp/accessibility.test.ts`'s own approach: a scripted fake
 * bridge, and assertions on WHICH CDP command goes out and with WHAT
 * params, not just on what comes back, because a test that only checked
 * the returned `data` would not catch a wrong paper size or a stray
 * param leaking through when it was not asked for.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import type { CdpSessionId } from '../../src/cdp/types.js';
import { printToPdf } from '../../src/pdf/print-to-pdf.js';
import { PrintToPdfOptionsError } from '../../src/pdf/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: CdpSessionId | undefined;
}

function fakeBridge(reply: unknown): { bridge: CdpBridge; sent: Sent[] } {
  const sent: Sent[] = [];
  const bridge = {
    async send(
      method: string,
      params?: Record<string, unknown>,
      sessionId?: CdpSessionId,
    ): Promise<unknown> {
      sent.push({ method, params: params ?? {}, sessionId });
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;
const FAKE_DATA = 'ZmFrZS1wZGYtYnl0ZXM=';

describe('printToPdf: which CDP command goes out', () => {
  it('sends exactly one Page.printToPDF, ReturnAsBase64, with the default Letter paper size and nothing else when no options are given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    const result = await printToPdf(bridge, SESSION);

    expect(sent.map((s) => s.method)).toEqual(['Page.printToPDF']);
    expect(sent[0]?.sessionId).toBe(SESSION);
    expect(sent[0]?.params).toEqual({
      paperWidth: 8.5,
      paperHeight: 11,
      transferMode: 'ReturnAsBase64',
    });
    expect(result).toEqual({ data: FAKE_DATA });
  });

  it('resolves a named format to its own width/height', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, { format: 'A4' });

    expect(sent[0]?.params['paperWidth']).toBe(8.27);
    expect(sent[0]?.params['paperHeight']).toBe(11.7);
  });

  it('uses explicit widthInches/heightInches over any default', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, { widthInches: 4, heightInches: 6 });

    expect(sent[0]?.params['paperWidth']).toBe(4);
    expect(sent[0]?.params['paperHeight']).toBe(6);
  });

  it('passes landscape, printBackground, scale, margins, and pageRanges through only when given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, {
      landscape: true,
      printBackground: true,
      scale: 0.75,
      marginTopInches: 0.5,
      marginBottomInches: 0.5,
      marginLeftInches: 0.25,
      marginRightInches: 0.25,
      pageRanges: '1-3, 5',
    });

    expect(sent[0]?.params).toEqual({
      paperWidth: 8.5,
      paperHeight: 11,
      transferMode: 'ReturnAsBase64',
      landscape: true,
      printBackground: true,
      scale: 0.75,
      marginTop: 0.5,
      marginBottom: 0.5,
      marginLeft: 0.25,
      marginRight: 0.25,
      pageRanges: '1-3, 5',
    });
  });

  it('turns displayHeaderFooter on when either template is given, and passes only the template(s) actually given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, { headerTemplate: '<span class="date"></span>' });

    expect(sent[0]?.params['displayHeaderFooter']).toBe(true);
    expect(sent[0]?.params['headerTemplate']).toBe('<span class="date"></span>');
    expect(sent[0]?.params['footerTemplate']).toBeUndefined();
  });

  it('sets both templates when both are given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, {
      headerTemplate: '<span></span>',
      footerTemplate: '<span class="pageNumber"></span>',
    });

    expect(sent[0]?.params['displayHeaderFooter']).toBe(true);
    expect(sent[0]?.params['headerTemplate']).toBe('<span></span>');
    expect(sent[0]?.params['footerTemplate']).toBe('<span class="pageNumber"></span>');
  });

  it('omits displayHeaderFooter entirely when neither template is given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await printToPdf(bridge, SESSION, {});

    expect('displayHeaderFooter' in (sent[0]?.params ?? {})).toBe(false);
  });
});

describe('printToPdf: option validation, checked before any CDP command is sent', () => {
  it('throws PrintToPdfOptionsError, and sends nothing, when format and widthInches are both given', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(
      printToPdf(bridge, SESSION, { format: 'A4', widthInches: 4 }),
    ).rejects.toBeInstanceOf(PrintToPdfOptionsError);
    expect(sent).toEqual([]);
  });

  it('throws, and sends nothing, when widthInches is given without heightInches', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(printToPdf(bridge, SESSION, { widthInches: 4 })).rejects.toBeInstanceOf(
      PrintToPdfOptionsError,
    );
    expect(sent).toEqual([]);
  });

  it('throws, and sends nothing, when heightInches is given without widthInches', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(printToPdf(bridge, SESSION, { heightInches: 6 })).rejects.toBeInstanceOf(
      PrintToPdfOptionsError,
    );
    expect(sent).toEqual([]);
  });

  it('throws, and sends nothing, when widthInches/heightInches are not positive', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(
      printToPdf(bridge, SESSION, { widthInches: 0, heightInches: 6 }),
    ).rejects.toBeInstanceOf(PrintToPdfOptionsError);
    expect(sent).toEqual([]);
  });

  it('throws, and sends nothing, when scale is below the 0.1 floor', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(printToPdf(bridge, SESSION, { scale: 0.05 })).rejects.toBeInstanceOf(
      PrintToPdfOptionsError,
    );
    expect(sent).toEqual([]);
  });

  it('throws, and sends nothing, when scale is above the 2 ceiling', async () => {
    const { bridge, sent } = fakeBridge({ data: FAKE_DATA });

    await expect(printToPdf(bridge, SESSION, { scale: 2.5 })).rejects.toBeInstanceOf(
      PrintToPdfOptionsError,
    );
    expect(sent).toEqual([]);
  });

  it('accepts the scale boundaries themselves, 0.1 and 2', async () => {
    const { bridge: bridgeLow, sent: sentLow } = fakeBridge({ data: FAKE_DATA });
    await printToPdf(bridgeLow, SESSION, { scale: 0.1 });
    expect(sentLow[0]?.params['scale']).toBe(0.1);

    const { bridge: bridgeHigh, sent: sentHigh } = fakeBridge({ data: FAKE_DATA });
    await printToPdf(bridgeHigh, SESSION, { scale: 2 });
    expect(sentHigh[0]?.params['scale']).toBe(2);
  });
});

describe('printToPdf: CDP-level failure propagates unwrapped', () => {
  it('rejects with whatever bridge.send() itself threw, not a re-wrapped error', async () => {
    const failure = new Error('boom');
    const { bridge } = fakeBridge(failure);

    await expect(printToPdf(bridge, SESSION)).rejects.toBe(failure);
  });
});
