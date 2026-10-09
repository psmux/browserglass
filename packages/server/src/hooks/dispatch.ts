import type { Logger } from '../config/logger.js';
import { HOOK_TIMEOUTS, type HookEventBase, type HookName, type Hooks } from './types.js';

/** Result of {@link HookRegistry.dispatch}. `vetoed` is only ever true for a vetoing hook. */
export interface DispatchResult {
  readonly vetoed: boolean;
  readonly reason: string | undefined;
}

const TIMEOUT = Symbol('hook-timeout');

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof TIMEOUT> {
  if (ms <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof TIMEOUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMEOUT), ms);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Holds every registered handler per hook name and dispatches events
 * through them with these timeout and veto semantics: handlers run in registration
 * order; for a vetoing hook the first `false` return or thrown error wins
 * and later handlers are skipped; every hook but `onDownload` fails open
 * on timeout (treated as allow); `onDownload` fails closed (a timeout is
 * a veto). A thrown error's `.message` is never surfaced to the
 * dispatch result for a non-vetoing hook (logged only); for a vetoing
 * hook the caller sees `vetoed: true` with a generic reason unless the
 * handler itself set `event.reason`.
 */
export class HookRegistry {
  private readonly handlers: { [K in HookName]?: Array<NonNullable<Hooks[K]>> } = {};
  private readonly globalTimeoutMs: number;
  private readonly logger: Logger;

  constructor(
    initial: Hooks | undefined,
    opts: { readonly globalTimeoutMs: number; readonly logger: Logger },
  ) {
    this.globalTimeoutMs = opts.globalTimeoutMs;
    this.logger = opts.logger;
    if (initial !== undefined) {
      // Only known hook names: `initial` may be a superset object (for
      // example `ResolvedConfig.hooks`, which also carries `timeoutMs`).
      for (const name of Object.keys(HOOK_TIMEOUTS) as HookName[]) {
        const fn = initial[name];
        if (fn !== undefined) this.on(name, fn as NonNullable<Hooks[HookName]>);
      }
    }
  }

  on<K extends HookName>(name: K, fn: NonNullable<Hooks[K]>): () => void {
    this.handlers[name] ??= [];
    const list = this.handlers[name] as Array<NonNullable<Hooks[K]>>;
    list.push(fn);
    return () => {
      const idx = list.indexOf(fn);
      if (idx >= 0) list.splice(idx, 1);
    };
  }

  /**
   * Cheap, synchronous "is anybody listening" check, for a call site that
   * would otherwise have to do real work (a CDP round trip, an extra store
   * read) just to build the event object `dispatch` would then discard
   * because `dispatch` itself already early-returns on an empty handler
   * list. `dispatch`'s own early return protects every call site from the
   * COST OF DISPATCHING; this protects a call site from the cost of
   * BUILDING THE EVENT in the first place, which `dispatch` cannot see and
   * cannot skip on a caller's behalf. `onNavigation` is the hook this
   * exists for: its 750ms timeout fails open specifically so a slow or
   * absent handler never stalls a navigation (`hooks/types.ts`'s
   * `HOOK_TIMEOUTS` doc), and that guarantee is worthless if every
   * navigation still pays for an unused event's fields on the way to
   * finding nobody home.
   */
  has(name: HookName): boolean {
    const list = this.handlers[name];
    return list !== undefined && list.length > 0;
  }

  async dispatch<K extends HookName>(
    name: K,
    event: Parameters<NonNullable<Hooks[K]>>[0] & HookEventBase,
  ): Promise<DispatchResult> {
    const list = this.handlers[name] as Array<NonNullable<Hooks[K]>> | undefined;
    const spec = HOOK_TIMEOUTS[name];
    const timeoutMs = this.globalTimeoutMs > 0 ? this.globalTimeoutMs : spec.timeoutMs;
    if (list === undefined || list.length === 0) return { vetoed: false, reason: undefined };

    for (const fn of list) {
      let outcome: boolean | undefined | typeof TIMEOUT;
      try {
        // `fn`'s parameter type is keyed by the generic `K`, which TS cannot
        // correlate with `event`'s type across the full `Hooks` union at a
        // generic call site (the classic "correlated union" limitation);
        // the cast below is narrow and matches this call's own `event`.
        const call = fn as (e: typeof event) => boolean | undefined | Promise<boolean | undefined>;
        outcome = await withTimeout(Promise.resolve(call(event)), timeoutMs);
      } catch (err) {
        this.logger.error(
          {
            component: 'server',
            hook: name,
            error: err instanceof Error ? err.message : String(err),
          },
          'hook threw',
        );
        if (spec.vetoes)
          return { vetoed: true, reason: event.reason ?? `${name} rejected the request.` };
        continue;
      }
      if (outcome === TIMEOUT) {
        this.logger.warn({ component: 'server', hook: name, timeoutMs }, 'hook timed out');
        if (spec.vetoes && spec.failClosed) {
          return { vetoed: true, reason: event.reason ?? `${name} timed out and is fail closed.` };
        }
        continue;
      }
      if (outcome === false && spec.vetoes) {
        return { vetoed: true, reason: event.reason };
      }
    }
    return { vetoed: false, reason: undefined };
  }
}
