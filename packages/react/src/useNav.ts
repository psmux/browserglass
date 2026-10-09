'use client';

import { BrowserGlassError } from '@browserglass/client';
import type { BrowserGlassClient } from '@browserglass/client';
import type { NavState } from '@browserglass/protocol';
import { useCallback, useEffect, useState } from 'react';

/** A navigation blocked by server-side policy (`bgls.error.nav.blocked`). */
export interface BlockedNav {
  url: string;
  rule?: string;
  message: string;
}

/** Return shape of {@link useNav}. */
export interface UseNavResult {
  url: string;
  title: string;
  loading: boolean;
  /**
   * `0` to `1`, or `null`. Always `null` for now: the wire
   * `nav.state` message carries no fractional load-progress field (see
   * `@browserglass/protocol`'s `NavState`), only the boolean `loading`.
   * `<StatusBar/>`'s progress bar renders from `loading` alone.
   */
  progress: number | null;
  canGoBack: boolean;
  canGoForward: boolean;
  securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
  goto: (url: string) => Promise<NavState>;
  back: () => Promise<NavState>;
  forward: () => Promise<NavState>;
  reload: (opts?: { ignoreCache?: boolean }) => Promise<NavState>;
  stop: () => Promise<void>;
  /** `true` when the token has `navigate`. */
  canNavigate: boolean;
  blocked: BlockedNav | null;
  dismissBlocked: () => void;
}

interface NavShape {
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
}

const EMPTY_NAV: NavShape = {
  url: '',
  title: '',
  loading: false,
  canGoBack: false,
  canGoForward: false,
  securityState: 'unknown',
};

/** Everything an address bar needs. Pairs with `<AddressBar/>`. */
export function useNav(client: BrowserGlassClient | null, targetId: string | null): UseNavResult {
  const [nav, setNav] = useState<NavShape>(EMPTY_NAV);
  const [blocked, setBlocked] = useState<BlockedNav | null>(null);

  useEffect(() => {
    setNav(EMPTY_NAV);
    setBlocked(null);
    if (!client || !targetId) return;
    return client.on('nav', (ev) => {
      if (ev.targetId !== targetId) return;
      setNav({
        url: ev.url,
        title: ev.title,
        loading: ev.loading,
        canGoBack: ev.canGoBack,
        canGoForward: ev.canGoForward,
        securityState: ev.securityState,
      });
    });
  }, [client, targetId]);

  const runNav = useCallback(
    async (
      fn: (c: BrowserGlassClient, t: string) => Promise<NavState>,
      urlForBlocked: string | undefined,
      currentUrl: string,
    ): Promise<NavState> => {
      if (!client || !targetId) throw new Error('useNav(): no client or targetId');
      try {
        const result = await fn(client, targetId);
        setBlocked(null);
        return result;
      } catch (err) {
        if (err instanceof BrowserGlassError && err.code === 'bgls.error.nav.blocked') {
          // Bracket notation is required, not stylistic: `context` is a
          // `Record<string, unknown>` index signature, and
          // `noPropertyAccessFromIndexSignature` (tsconfig.base.json)
          // forbids dot access on it.
          // biome-ignore lint/complexity/useLiteralKeys: see above.
          const rawRule = err.context?.['rule'];
          const rule = typeof rawRule === 'string' ? rawRule : undefined;
          setBlocked({
            url: urlForBlocked ?? currentUrl,
            ...(rule !== undefined ? { rule } : {}),
            message: err.message,
          });
        }
        throw err;
      }
    },
    [client, targetId],
  );

  const goto = useCallback(
    (url: string) => runNav((c, t) => c.navigate(t, url), url, nav.url),
    [runNav, nav.url],
  );
  const back = useCallback(
    () => runNav((c, t) => c.back(t), undefined, nav.url),
    [runNav, nav.url],
  );
  const forward = useCallback(
    () => runNav((c, t) => c.forward(t), undefined, nav.url),
    [runNav, nav.url],
  );
  const reload = useCallback(
    (opts?: { ignoreCache?: boolean }) => runNav((c, t) => c.reload(t, opts), undefined, nav.url),
    [runNav, nav.url],
  );
  const stop = useCallback(async (): Promise<void> => {
    if (!client || !targetId) return;
    await client.stopLoading(targetId);
  }, [client, targetId]);
  const dismissBlocked = useCallback(() => setBlocked(null), []);

  return {
    ...nav,
    progress: null,
    goto,
    back,
    forward,
    reload,
    stop,
    canNavigate: client?.granted.has('navigate') ?? false,
    blocked,
    dismissBlocked,
  };
}
