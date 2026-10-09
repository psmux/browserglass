'use client';

import { BrowserGlassClient } from '@browserglass/client';
import type { Capability, ConnectionState, FatalInfo } from '@browserglass/client';
import type { ErrorMsg, WelcomeInstance } from '@browserglass/protocol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { optionsKey } from './internal/optionsKey.js';
import type { UseBrowserGlassOptions } from './types.js';

const TEARDOWN_DELAY_MS = 100;

/** Return shape of {@link useBrowserGlass}. */
export interface UseBrowserGlassResult {
  /** `null` during SSR, the first client render, and whenever `opts.url` is empty. */
  client: BrowserGlassClient | null;
  state: ConnectionState;
  connected: boolean;
  resumed: boolean;
  instance: WelcomeInstance | null;
  granted: ReadonlySet<Capability>;
  error: ErrorMsg | null;
  fatal: FatalInfo | null;
  reconnectAttempt: number;
  /** Manual retry, resets backoff. Safe to call in any state. */
  reconnect: () => void;
}

interface Snapshot {
  state: ConnectionState;
  resumed: boolean;
  instance: WelcomeInstance | null;
  granted: ReadonlySet<Capability>;
  error: ErrorMsg | null;
  fatal: FatalInfo | null;
  reconnectAttempt: number;
}

const EMPTY_GRANTED: ReadonlySet<Capability> = new Set();

function initialSnapshot(): Snapshot {
  return {
    state: 'idle',
    resumed: false,
    instance: null,
    granted: EMPTY_GRANTED,
    error: null,
    fatal: null,
    reconnectAttempt: 0,
  };
}

function buildClient(o: UseBrowserGlassOptions): BrowserGlassClient {
  const onTicketExpired = o.onTicketExpired;
  const credentials =
    o.credentials ??
    (onTicketExpired ? async () => ({ ticket: await onTicketExpired() }) : undefined);
  return new BrowserGlassClient({
    url: o.url,
    ...(o.ticket !== undefined ? { ticket: o.ticket } : {}),
    ...(o.token !== undefined ? { token: o.token } : {}),
    ...(credentials !== undefined ? { credentials } : {}),
    ...(o.autoReconnect !== undefined ? { autoReconnect: o.autoReconnect } : {}),
    ...(o.subscribe !== undefined ? { subscribe: o.subscribe } : {}),
    ...(o.codecs !== undefined ? { codecs: o.codecs } : {}),
    ...(o.transport !== undefined ? { transport: o.transport } : {}),
    ...(o.presenceCursor !== undefined ? { presenceCursor: o.presenceCursor } : {}),
    ...(o.keyboardLock !== undefined ? { keyboardLock: o.keyboardLock } : {}),
    ...(o.label !== undefined ? { label: o.label } : {}),
    ...(o.debug !== undefined ? { debug: o.debug } : {}),
  });
}

/**
 * Owns a `BrowserGlassClient`'s lifecycle. Creating it here (not inside
 * `<BrowserGlass/>`) is what lets multiple panes share one socket by
 * passing the same client down as a prop.
 *
 * An empty `opts.url` disables the hook entirely: no client is ever
 * constructed and every field returns its `client: null` default. This is
 * an internal escape hatch `<BrowserGlass client={existingClient}>` uses to
 * skip its own owned-client lifecycle without calling this hook
 * conditionally (Rules of Hooks).
 *
 * Two of the three StrictMode defences live here (the third, the
 * `ticket_consumed` silent retry, is already built into
 * `@browserglass/client`'s `Transport`; this hook only needs to wire `credentials`
 * correctly for that retry to succeed): the client lives in a ref keyed by
 * `optionsKey(opts)`, and `connect()` on an already-connecting or already-live
 * client returns the in-flight promise or resolves immediately
 * (`BrowserGlassClient.connect()`'s own contract, unchanged here). This
 * hook's own effect schedules `destroy()` on a 100ms timer at cleanup,
 * which a synchronous second mount (StrictMode's) cancels before it fires;
 * a real unmount is not cancelled and the timer runs to completion.
 */
export function useBrowserGlass(opts: UseBrowserGlassOptions): UseBrowserGlassResult {
  const enabled = opts.url.length > 0;
  const generationRef = useRef(0);
  const key = enabled ? `${optionsKey(opts)}::${generationRef.current}` : '';

  const clientRef = useRef<{ key: string; client: BrowserGlassClient } | null>(null);
  const teardownTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  const [snapshot, setSnapshot] = useState<Snapshot>(initialSnapshot);
  const [, forceRender] = useState(0);

  // Ref-keyed-by-options singleton creation (see file doc comment). Runs
  // during render deliberately: it is the only way a hook can hand back a
  // `client` on the very render that first needs one, matching
  // `useBrowserGlass`'s documented contract that `client` is non-null as
  // soon as options resolve rather than one render later.
  if (!enabled) {
    if (clientRef.current) {
      clientRef.current.client.destroy();
      clientRef.current = null;
    }
    if (teardownTimerRef.current) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }
  } else if (!clientRef.current || clientRef.current.key !== key) {
    clientRef.current?.client.destroy();
    if (teardownTimerRef.current) {
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }
    clientRef.current = { key, client: buildClient(optsRef.current) };
  }

  const client = clientRef.current?.client ?? null;

  useEffect(() => {
    if (!client) return;

    if (teardownTimerRef.current) {
      // The StrictMode second mount: a first-mount teardown is pending,
      // cancel it, no new socket, no new connect() call needed (the first
      // mount's connect() already put the client into `connecting`/`live`).
      clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    } else {
      setSnapshot(initialSnapshot());
      client.connect().catch(() => {
        // A permanent failure lands in `fatal`, observed through the
        // `fatal` event below; the rejection itself carries nothing this
        // hook needs beyond that.
      });
    }

    const offs = [
      client.on('state', (ev) => setSnapshot((s) => ({ ...s, state: ev.to }))),
      client.on('connected', (ev) =>
        setSnapshot((s) => ({
          ...s,
          resumed: ev.resumed,
          instance: ev.instance,
          granted: new Set(ev.granted),
          error: null,
        })),
      ),
      client.on('disconnected', () => setSnapshot((s) => ({ ...s, resumed: false }))),
      client.on('reconnecting', (ev) =>
        setSnapshot((s) => ({ ...s, reconnectAttempt: ev.attempt })),
      ),
      client.on('fatal', (ev) => setSnapshot((s) => ({ ...s, fatal: ev }))),
      client.on('error', (ev) => setSnapshot((s) => ({ ...s, error: ev }))),
      client.on('capabilities', (ev) =>
        setSnapshot((s) => ({ ...s, granted: new Set(ev.granted) })),
      ),
    ];

    return () => {
      for (const off of offs) off();
      teardownTimerRef.current = setTimeout(() => {
        teardownTimerRef.current = null;
        client.destroy();
        // Only clear the ref if nothing newer has already replaced it (an
        // options-key change during the 100ms window constructs its own
        // fresh entry first).
        if (clientRef.current?.client === client) clientRef.current = null;
      }, TEARDOWN_DELAY_MS);
    };
    // `client` is the only real dependency: it already reflects every
    // field `optionsKey` folds in, and function-valued options are always
    // read fresh through `optsRef`.
  }, [client]);

  const reconnect = useCallback(() => {
    generationRef.current += 1;
    forceRender((n) => n + 1);
  }, []);

  const connected =
    snapshot.state === 'live' || snapshot.state === 'degraded' || snapshot.state === 'resuming';

  return {
    client,
    state: client ? snapshot.state : 'idle',
    connected: client ? connected : false,
    resumed: client ? snapshot.resumed : false,
    instance: client ? snapshot.instance : null,
    granted: client ? snapshot.granted : EMPTY_GRANTED,
    error: client ? snapshot.error : null,
    fatal: client ? snapshot.fatal : null,
    reconnectAttempt: client ? snapshot.reconnectAttempt : 0,
    reconnect,
  };
}
