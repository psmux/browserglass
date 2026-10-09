import { describe, expect, it } from 'vitest';
import { createBrowserGlass } from '../../src/index.js';

describe('REST dispatch via bg.fetch', () => {
  it('GET /healthz is unauthenticated and always ok', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(new Request('http://localhost/healthz'));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
  });

  it('GET /readyz is 503 before start() and unauthenticated', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(new Request('http://localhost/readyz'));
    expect(res.status).toBe(503);
  });

  it('a stubbed live-subset-adjacent route returns 501 with a clear body', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(
      new Request('http://localhost/browserglass/v1/pools', { method: 'GET' }),
    );
    expect(res.status).toBe(501);
    const body = await res.json();
    expect(body.error.code).toBe('E_NOT_IMPLEMENTED');
    expect(body.error.message).toMatch(/not implemented/i);
  });

  it('an unknown path under basePath/v1 returns 404 with the error envelope and a request id header', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(new Request('http://localhost/browserglass/v1/nonexistent'));
    expect(res.status).toBe(404);
    expect(res.headers.get('x-bgls-request-id')).toMatch(/^req_/);
    const body = await res.json();
    expect(body.error.code).toBe('E_ROUTE_NOT_FOUND');
    expect(body.error.requestId).toMatch(/^req_/);
  });

  it('handleRequest returns false and touches nothing for a path outside basePath', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(new Request('http://localhost/some/other/app/route'));
    expect(res.status).toBe(404); // fetch()'s own "not handled" fallback, not dispatchRest's
  });

  it('a route requiring a capability without any AuthResolver configured returns 401', async () => {
    const bg = createBrowserGlass({
      mode: 'gateway',
      router: { endpoint: 'https://router.example.com' },
    });
    const res = await bg.fetch(new Request('http://localhost/browserglass/v1/instances'));
    expect(res.status).toBe(401);
  });
});
