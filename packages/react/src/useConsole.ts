'use client';

import type { BrowserGlassClient } from '@browserglass/client';
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * One log line for a debugging panel: either a `console.*` call
 * (`kind: 'console'`) or an uncaught page error (`kind: 'error'`),
 * normalised to the same shape so a panel can render both as one ordered
 * list, which is what "read console output and page errors" means to
 * someone actually debugging with it.
 * `receivedAt` is local, used as this hook's ring buffer ordering key,
 * since neither wire message carries a per-entry sequence.
 */
export interface ConsoleLogEntry {
  kind: 'console' | 'error';
  targetId: string;
  /** `console`: the `console.*` level. `error`: always `'error'`. */
  level: string;
  text: string;
  url?: string;
  line?: number;
  stack?: string;
  receivedAt: number;
}

/** Options for {@link useConsole}. */
export interface UseConsoleOptions {
  /** Ring buffer capacity: oldest entries are dropped once exceeded. Default 300, same default as `useNetwork`. */
  limit?: number;
  /**
   * Whether mounting this hook itself opts `targetId` into the `console`
   * and `errors` diagnostics feeds (`client.diagnostics.subscribe()` on
   * mount, `.unsubscribe()` on unmount or target change). Default true.
   * Set false when another hook on this target already owns the
   * subscribe/unsubscribe lifecycle.
   */
  subscribe?: boolean;
  /** Capture `console.*` calls. Default true. */
  console?: boolean;
  /** Capture uncaught page errors. Default true. */
  errors?: boolean;
}

/** Return shape of {@link useConsole}. */
export interface UseConsoleResult {
  entries: ConsoleLogEntry[];
  clear: () => void;
}

const EMPTY_ENTRIES: ConsoleLogEntry[] = [];
const DEFAULT_LIMIT = 300;

/**
 * Live console lines and page errors for one target, merged into a single
 * ordered ring buffer. Gated on `devtools` and the plan's "opt in per
 * target" `diagnostics.subscribe` pair, the same way `useNetwork` gates
 * its own feed: a collapsed panel that never mounts this hook never pays
 * for it.
 */
export function useConsole(
  client: BrowserGlassClient | null,
  targetId: string | null,
  opts?: UseConsoleOptions,
): UseConsoleResult {
  const limit = opts?.limit ?? DEFAULT_LIMIT;
  const shouldSubscribe = opts?.subscribe ?? true;
  const wantConsole = opts?.console ?? true;
  const wantErrors = opts?.errors ?? true;
  const [entries, setEntries] = useState<ConsoleLogEntry[]>(EMPTY_ENTRIES);
  const entriesRef = useRef(entries);
  entriesRef.current = entries;

  const push = useCallback(
    (entry: ConsoleLogEntry) => {
      const next = [...entriesRef.current, entry];
      if (next.length > limit) next.splice(0, next.length - limit);
      entriesRef.current = next;
      setEntries(next);
    },
    [limit],
  );

  useEffect(() => {
    entriesRef.current = EMPTY_ENTRIES;
    setEntries(EMPTY_ENTRIES);
    if (!client || !targetId) return;

    const offs: Array<() => void> = [];
    if (wantConsole) {
      offs.push(
        client.on('console', (ev) => {
          if (ev.targetId !== targetId) return;
          push({
            kind: 'console',
            targetId: ev.targetId,
            level: ev.level,
            text: ev.text,
            ...(ev.url !== undefined ? { url: ev.url } : {}),
            ...(ev.line !== undefined ? { line: ev.line } : {}),
            receivedAt: Date.now(),
          });
        }),
      );
    }
    if (wantErrors) {
      offs.push(
        client.on('pageerror', (ev) => {
          if (ev.targetId !== targetId) return;
          push({
            kind: 'error',
            targetId: ev.targetId,
            level: 'error',
            text: `${ev.name}: ${ev.message}`,
            ...(ev.stack !== undefined ? { stack: ev.stack } : {}),
            receivedAt: Date.now(),
          });
        }),
      );
    }

    if (shouldSubscribe && client.granted.has('devtools')) {
      client.diagnostics
        .subscribe(targetId, { console: wantConsole, errors: wantErrors })
        .catch(() => {
          // Best effort, matching useNetwork(): a failed subscribe just
          // leaves this pane's feed empty.
        });
    }

    return () => {
      for (const off of offs) off();
      if (shouldSubscribe && client.granted.has('devtools')) {
        client.diagnostics.unsubscribe(targetId).catch(() => {
          // Same best-effort reasoning as the subscribe call above.
        });
      }
    };
  }, [client, targetId, shouldSubscribe, wantConsole, wantErrors, push]);

  const clear = useCallback(() => {
    entriesRef.current = EMPTY_ENTRIES;
    setEntries(EMPTY_ENTRIES);
  }, []);

  return { entries, clear };
}
