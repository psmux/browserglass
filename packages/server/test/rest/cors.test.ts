/**
 * CORS for the REST surface (`src/rest/cors.ts`, wired into
 * `dispatchRest` in `src/rest/router.ts`): a `<browser-glass>` widget
 * embedded on a third party page cannot call this gateway at all unless
 * the response carries `Access-Control-Allow-Origin` for that page's own
 * origin, and unless an `OPTIONS` preflight gets a real answer instead of
 * falling through to route matching. Driven through `bg.fetch`, exactly
 * like `dispatch.test.ts`, so this exercises the real `dispatchRest` path
 * end to end rather than calling `cors.ts`'s exports directly.
 */
import { describe, expect, it } from 'vitest';
import { createBrowserGlass } from '../../src/index.js';

describe('REST CORS', () => {
  it('an unconfigured gateway (default allowedOrigins) sends no CORS headers at all', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://widget.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a request from an allowed origin gets that exact origin echoed back, plus Vary: Origin', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'] },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://widget.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://widget.example.com');
    expect(res.headers.get('vary')).toBe('Origin');
  });

  it('a request from an origin not on the list gets no CORS headers, even though the request itself still succeeds', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'] },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://evil.example.com' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allowedOrigins: "*" echoes the requesting origin, never the literal "*"', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: '*' },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://anywhere.example.com' },
      }),
    );
    expect(res.headers.get('access-control-allow-origin')).toBe('https://anywhere.example.com');
  });

  it('corsCredentials: true adds Access-Control-Allow-Credentials for a matched origin', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'], corsCredentials: true },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://widget.example.com' },
      }),
    );
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('corsCredentials defaults to off: no Access-Control-Allow-Credentials header even for a matched origin', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'] },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/healthz', {
        headers: { origin: 'https://widget.example.com' },
      }),
    );
    expect(res.headers.get('access-control-allow-credentials')).toBeNull();
  });

  it('an OPTIONS preflight for an allowed origin is answered 200 with the allow headers, never reaching route matching', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'] },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/v1/instances', {
        method: 'OPTIONS',
        headers: {
          origin: 'https://widget.example.com',
          'access-control-request-method': 'POST',
          'access-control-request-headers': 'authorization, content-type',
        },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBe('https://widget.example.com');
    expect(res.headers.get('access-control-allow-methods')).toContain('POST');
    expect(res.headers.get('access-control-allow-headers')).toBe('authorization, content-type');
    expect(res.headers.get('access-control-max-age')).not.toBeNull();
  });

  it('an OPTIONS preflight for a disallowed origin still gets 200, but with no Access-Control-Allow-Origin (the browser is what refuses)', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
      security: { allowedOrigins: ['https://widget.example.com'] },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/v1/instances', {
        method: 'OPTIONS',
        headers: { origin: 'https://evil.example.com', 'access-control-request-method': 'POST' },
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('a plain OPTIONS with no Access-Control-Request-Method is not treated as a preflight (falls through to normal 404)', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/v1/instances', { method: 'OPTIONS' }),
    );
    expect(res.status).toBe(404);
  });
});
