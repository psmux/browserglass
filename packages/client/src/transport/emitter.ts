/**
 * A minimal typed publish/subscribe emitter, deliberately not Node's
 * `EventEmitter` (forbidden in this package by the layer gate) and not a
 * DOM `EventTarget` (this package's `tsconfig` carries no DOM lib). Used
 * for {@link TransportEvents} and nothing else; it has no dependency on
 * this module's neighbours.
 */

/** A subscription canceller, returned by {@link Emitter.on} and {@link Emitter.once}. */
export type Unsubscribe = () => void;

/**
 * A typed emitter over an event-name-to-payload map. `on()` returns its
 * own unsubscribe function rather than requiring the caller to keep a
 * reference to pass to `off()`, which is what makes a React effect a
 * one-liner and eliminates the "removed with a differently bound
 * function" bug class.
 */
export class Emitter<Events extends Record<string, unknown>> {
  private readonly listeners = new Map<keyof Events, Set<(ev: never) => void>>();

  /** Subscribes `fn` to every `type` event; returns a function that unsubscribes it. */
  on<K extends keyof Events>(type: K, fn: (ev: Events[K]) => void): Unsubscribe {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(fn as (ev: never) => void);
    return () => {
      set.delete(fn as (ev: never) => void);
    };
  }

  /** Subscribes `fn` to the next `type` event only, then unsubscribes it. */
  once<K extends keyof Events>(type: K, fn: (ev: Events[K]) => void): Unsubscribe {
    const off = this.on(type, (ev: Events[K]) => {
      off();
      fn(ev);
    });
    return off;
  }

  /** Unsubscribes `fn` from `type`, if it was subscribed. */
  off<K extends keyof Events>(type: K, fn: (ev: Events[K]) => void): void {
    this.listeners.get(type)?.delete(fn as (ev: never) => void);
  }

  /** Synchronously invokes every current subscriber of `type` with `ev`. */
  emit<K extends keyof Events>(type: K, ev: Events[K]): void {
    const set = this.listeners.get(type);
    if (!set || set.size === 0) return;
    for (const fn of Array.from(set)) {
      (fn as (ev: Events[K]) => void)(ev);
    }
  }

  /** Drops every subscriber of every event type. */
  clear(): void {
    this.listeners.clear();
  }
}
