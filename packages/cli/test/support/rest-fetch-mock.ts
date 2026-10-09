/**
 * A scripted `global.fetch` test double for `util/rest.ts`'s `restCall`.
 * Every browser-driving command's REST calls (`instances create/list/
 * describe/release`, `swarm run`'s `acquire()`/teardown) go through
 * `fetch` directly (no HTTP client library between them), so stubbing
 * `global.fetch` with this exercises the exact same code path a real
 * `bgls` invocation does, without a real `@browserglass/server` process.
 */
import { vi } from 'vitest';

/** One recorded call this mock's `fetch` received. */
export interface RecordedFetchCall {
  readonly method: string;
  readonly pathname: string;
  readonly search: URLSearchParams;
  readonly body: unknown;
}

/** One route this mock answers. `test` matches on pathname only; `method` is compared case-sensitively against the request's own method. */
export interface FetchRoute {
  readonly method: string;
  readonly test: (pathname: string) => boolean;
  /** Returns the JSON body and status to answer with; called once per matching request. */
  readonly handle: (
    call: RecordedFetchCall,
  ) => { status: number; body: unknown } | Promise<{ status: number; body: unknown }>;
}

/** Installs `routes` as `global.fetch`, in `vi.stubGlobal`'s sense: call `restore()` (or `vi.unstubAllGlobals()`) in an `afterEach`. */
export function installFetchMock(routes: readonly FetchRoute[]): {
  calls: RecordedFetchCall[];
  restore: () => void;
} {
  const calls: RecordedFetchCall[] = [];

  const fakeFetch = vi.fn(
    async (input: string | URL, init?: { method?: string; body?: unknown }) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      const body =
        typeof init?.body === 'string' && init.body.length > 0
          ? (JSON.parse(init.body) as unknown)
          : undefined;
      const call: RecordedFetchCall = {
        method,
        pathname: url.pathname,
        search: url.searchParams,
        body,
      };
      calls.push(call);

      const route = routes.find((r) => r.method === method && r.test(url.pathname));
      const result =
        route !== undefined
          ? await route.handle(call)
          : {
              status: 404,
              body: {
                error: {
                  code: 'E_MOCK_NOT_FOUND',
                  message: `no mock route for ${method} ${url.pathname}`,
                },
              },
            };

      return {
        ok: result.status >= 200 && result.status < 300,
        status: result.status,
        text: async () => JSON.stringify(result.body),
      };
    },
  );

  vi.stubGlobal('fetch', fakeFetch);
  return { calls, restore: () => vi.unstubAllGlobals() };
}
