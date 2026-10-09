/**
 * `checkUpgradeOrigin` (`src/ws/origin-check.ts`): the WS upgrade path's
 * `Origin` check. A regression fixed in the same change this test guards
 * against: an earlier version of `security.allowedOrigins`'s default
 * consulted this list for EVERY request with an `Origin` header,
 * including same origin ones, which 403'd a gateway's own page connecting
 * back to itself with zero configuration.
 */
import type { IncomingMessage } from 'node:http';
import { describe, expect, it } from 'vitest';
import { checkUpgradeOrigin } from '../../src/ws/origin-check.js';

function req(headers: Record<string, string>): IncomingMessage {
  return { headers } as unknown as IncomingMessage;
}

describe('checkUpgradeOrigin', () => {
  it('allows a request with no Origin header at all, with allowedOrigins unconfigured (default [])', () => {
    const result = checkUpgradeOrigin(req({ host: 'gateway.example:7799' }), []);
    expect(result.allowed).toBe(true);
  });

  it('allows a same origin request (Origin host matches Host header), with allowedOrigins unconfigured', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'http://gateway.example:7799' }),
      [],
    );
    expect(result.allowed).toBe(true);
  });

  it('allows a same origin request even when the Origin scheme is https and the socket is plain (proxy/TLS termination case): only host:port is compared', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'https://gateway.example:7799' }),
      [],
    );
    expect(result.allowed).toBe(true);
  });

  it('denies a genuinely cross origin request with allowedOrigins unconfigured (default []), naming the origin and the config key', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'https://evil.example.com' }),
      [],
    );
    expect(result.allowed).toBe(false);
    expect(result.message).toContain('https://evil.example.com');
    expect(result.message).toContain('security.allowedOrigins');
    expect(result.message).toContain('BGLS_ALLOWED_ORIGINS');
  });

  it('allows a cross origin request whose Origin is on the configured allow list', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'https://widget.example.com' }),
      ['https://widget.example.com'],
    );
    expect(result.allowed).toBe(true);
  });

  it('denies a cross origin request whose Origin is not on the configured allow list', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'https://evil.example.com' }),
      ['https://widget.example.com'],
    );
    expect(result.allowed).toBe(false);
  });

  it('allows every cross origin request when allowedOrigins is the literal "*" (explicit opt in)', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'https://anywhere.example.com' }),
      '*',
    );
    expect(result.allowed).toBe(true);
  });

  it('denies a malformed Origin header that fails to parse as a URL, unless allowedOrigins is "*"', () => {
    const result = checkUpgradeOrigin(
      req({ host: 'gateway.example:7799', origin: 'not a url' }),
      [],
    );
    expect(result.allowed).toBe(false);
  });
});
