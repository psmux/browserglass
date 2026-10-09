import type { UseBrowserGlassOptions } from '../types.js';

/**
 * A stable string key for the fields of {@link UseBrowserGlassOptions} that
 * identify "the same connection" (the client lives in a ref keyed by
 * these options). Deliberately
 * excludes function fields (`credentials`, `onTicketExpired`) and
 * `transport`/`subscribe`, which a caller commonly re-creates as a fresh
 * object literal on every render without meaning to open a second socket;
 * this hook always reads the *latest* function references through a ref
 * (see `useBrowserGlass.ts`), so excluding them here never means a stale
 * callback is used, only that recreating one alone does not tear down and
 * rebuild the client.
 */
export function optionsKey(opts: UseBrowserGlassOptions): string {
  return JSON.stringify({
    url: opts.url,
    ticket: opts.ticket,
    token: opts.token,
    autoReconnect: opts.autoReconnect,
    codecs: opts.codecs,
    presenceCursor: opts.presenceCursor,
    keyboardLock: opts.keyboardLock,
    label: opts.label,
    debug: opts.debug,
  });
}
