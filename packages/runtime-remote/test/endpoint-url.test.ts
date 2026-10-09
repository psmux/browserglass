import { describe, expect, it } from 'vitest';
import { UnsupportedEndpointTransportError, deriveHttpOrigin } from '../src/endpoint-url.js';

describe('deriveHttpOrigin', () => {
  it('passes an http origin through unchanged, minus a trailing slash', () => {
    expect(deriveHttpOrigin('http://127.0.0.1:9222')).toBe('http://127.0.0.1:9222');
    expect(deriveHttpOrigin('http://127.0.0.1:9222/')).toBe('http://127.0.0.1:9222');
  });

  it('passes an https origin through unchanged', () => {
    expect(deriveHttpOrigin('https://cdp.example.com:443')).toBe('https://cdp.example.com:443');
  });

  it('maps a ws:// browser endpoint url to the matching http origin, dropping the /devtools/browser path', () => {
    expect(deriveHttpOrigin('ws://127.0.0.1:9222/devtools/browser/abc-123')).toBe(
      'http://127.0.0.1:9222',
    );
  });

  it('maps a wss:// browser endpoint url to the matching https origin', () => {
    expect(deriveHttpOrigin('wss://cdp.example.com:443/devtools/browser/abc-123')).toBe(
      'https://cdp.example.com:443',
    );
  });

  it('throws UnsupportedEndpointTransportError for a unix:// url', () => {
    expect(() => deriveHttpOrigin('unix:///run/bgls/inst_x.sock')).toThrow(
      UnsupportedEndpointTransportError,
    );
  });
});
