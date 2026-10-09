'use client';

import type { BrowserGlassClient } from '@browserglass/client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One network request/response row, mirroring the wire `network.request`
 * payload (`NetworkRequestEntry`)
 * plus a local `receivedAt`, used as this hook's own ring buffer ordering:
 * the wire message carries no per-entry sequence, and `requestId` alone is
 * not a safe React list key once the buffer wraps, since a target can in
 * principle reuse a CDP `requestId` across two different subscribe windows.
 */
export interface NetworkRow {
  targetId: string;
  requestId: string;
  method: string;
  url: string;
  resourceType: string;
  status: number | null;
  errorText: string | null;
  fromCache: boolean;
  durationMs: number | null;
  encodedBytes: number | null;
  startedAt: number;
  receivedAt: number;
}

/** Options for {@link useNetwork}. */
export interface UseNetworkOptions {
  /**
   * Ring buffer capacity: oldest rows are dropped once this is exceeded.
   * Default 300. A debugging panel must not grow without bound on a page
   * that issues requests in a loop, the same reasoning behind the
   * server's per-second cap on the console feed.
   */
  limit?: number;
  /**
   * Whether mounting this hook itself opts `targetId` into the `network`
   * diagnostics feed (`client.diagnostics.subscribe({network:true})` on
   * mount, `.unsubscribe()` on unmount or target change). Default true.
   * Set false when another mounted hook on the same target (typically
   * `useConsole`) already owns the subscribe/unsubscribe lifecycle and this
   * one should only read the feed.
   */
  subscribe?: boolean;
}

/** Return shape of {@link useNetwork}. */
export interface UseNetworkResult {
  entries: NetworkRow[];
  clear: () => void;
}

const EMPTY_ENTRIES: NetworkRow[] = [];
const DEFAULT_LIMIT = 300;

/**
 * Live network request rows for one target. Gated on `devtools` (the
 * subscribe call is skipped, not attempted and left to fail, when the
 * token lacks it) and on `diagnostics.subscribe({network:true})`, the
 * plan's explicit "opt in per target" requirement: `Network.enable` is not
 * free, so a wall of panes must not pay for it just because they render
 * `<BrowserGlass/>`. A collapsed panel that never mounts this hook (or
 * mounts it with `subscribe: false` and no sibling that subscribes) never
 * pays that cost.
 */
export function useNetwork(
  client: BrowserGlassClient | null,
  targetId: string | null,
  opts?: UseNetworkOptions,
): UseNetworkResult {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const shouldSubscribe = opts?.subscribe ?? true;
  const [entries, setEntries] = useState<NetworkRow[]>(EMPTY_ENTRIES);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  useEffect(() => {
    entriesRef.current = EMPTY_ENTRIES;
    setEntries(EMPTY_ENTRIES);
    if (!client || !targetId) return;

    const off = client.on('network', (ev) => {
      if (ev.targetId !== targetId) return;
      const next = [...entriesRef.current, { ...ev, receivedAt: Date.now() }];
      if (next.length > limit) next.splice(0, next.length - limit);
      entriesRef.current = next;
      setEntries(next);
    });

    if (shouldSubscribe && client.granted.has('devtools')) {
      client.diagnostics.subscribe(targetId, { network: true }).catch(() => {
        // Best effort: a subscribe failure (target already gone, connection
        // drop mid flight) just leaves this pane's feed empty, nothing a
        // mount effect can usefully surface beyond that.
      });
    }

    return () => {
      off();
      if (shouldSubscribe && client.granted.has('devtools')) {
        client.diagnostics.unsubscribe(targetId).catch(() => {
          // Same best-effort reasoning as the subscribe call above.
        });
      }
    };
  }, [client, targetId, limit, shouldSubscribe]);

  const clear = useCallback(() => {
    entriesRef.current = EMPTY_ENTRIES;
    setEntries(EMPTY_ENTRIES);
  }, []);

  return { entries, clear };
}
