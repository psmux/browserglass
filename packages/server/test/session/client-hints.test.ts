import { describe, expect, it } from 'vitest';
import {
  brandList,
  clientHintsFor,
  hostPlatformVersion,
  withoutHeadless,
} from '../../src/session/client-hints.js';

describe('brandList matches the brands real Chrome sends', () => {
  it('Chrome 120: "Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"', () => {
    expect(brandList(120)).toEqual([
      { brand: 'Not_A Brand', version: '8' },
      { brand: 'Chromium', version: '120' },
      { brand: 'Google Chrome', version: '120' },
    ]);
  });

  it('Chrome 124: "Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"', () => {
    expect(brandList(124)).toEqual([
      { brand: 'Chromium', version: '124' },
      { brand: 'Google Chrome', version: '124' },
      { brand: 'Not-A.Brand', version: '99' },
    ]);
  });

  it('gives every entry four version parts in the full version list shape', () => {
    for (const b of brandList(158, 'Google Chrome', '158.0.8127.37'))
      expect(b.version.split('.')).toHaveLength(4);
  });
});

describe('clientHintsFor', () => {
  it('agrees with a desktop agent string and fills the high entropy hints', () => {
    const ua =
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36';
    const h = clientHintsFor(ua, '158.0.8127.37');
    expect(h['platform']).toBe('Windows');
    expect(h['mobile']).toBe(false);
    expect(h['fullVersion']).toBe('158.0.8127.37');
    expect((h['brands'] as { brand: string }[]).map((b) => b.brand)).toContain('Google Chrome');
  });

  it('says mobile for a phone agent and names an Android model', () => {
    const ua =
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Mobile Safari/537.36';
    const h = clientHintsFor(ua, '158.0.8127.37');
    expect(h['platform']).toBe('Android');
    expect(h['mobile']).toBe(true);
    expect(h['model']).toBe('Pixel 8');
  });

  it('uses the agent major when the running version is another one', () => {
    const h = clientHintsFor(
      'Mozilla/5.0 (X11; Linux x86_64) Chrome/150.0.0.0 Safari/537.36',
      '158.0.1.2',
    );
    expect(h['fullVersion']).toBe('150.0.0.0');
  });
});

describe('hostPlatformVersion and withoutHeadless', () => {
  it('maps Windows builds to the contract versions Chrome reports', () => {
    expect(hostPlatformVersion('win32', '10.0.26100')).toBe('19.0.0');
    expect(hostPlatformVersion('win32', '10.0.22631')).toBe('15.0.0');
    expect(hostPlatformVersion('win32', '10.0.19045')).toBe('10.0.0');
  });

  it('maps Darwin releases to macOS versions', () => {
    expect(hostPlatformVersion('darwin', '24.3.0')).toBe('15.3.0');
    expect(hostPlatformVersion('darwin', '25.1.0')).toBe('26.1.0');
  });

  it('turns HeadlessChrome back into Chrome', () => {
    expect(
      withoutHeadless(
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/158.0.0.0 Safari/537.36',
      ),
    ).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/158.0.0.0 Safari/537.36',
    );
  });
});
