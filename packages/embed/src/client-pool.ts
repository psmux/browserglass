import { BrowserGlassClient, type StreamHandle, type SubscribeOptions } from '@browserglass/client';

/**
 * Two hazards, both confirmed by reading
 * `packages/client/src/client/BrowserGlassClient.ts` directly rather than
 * assumed:
 *
 * 1. `BrowserGlassClient.subscribe(targetId, opts)` dedupes strictly by
 *    `targetId`: a second `subscribe()` call for a target already
 *    subscribed on the same client returns the SAME `StreamHandle` object
 *    (`this.subscriptions` is keyed by `targetId` alone, not by caller).
 *    Its `unsubscribe()` is not reference counted: whichever caller drops
 *    the stream first tears it down for everyone still holding that same
 *    handle.
 * 2. `StreamHandleImpl.attach(canvas, container, opts)` replaces whichever
 *    renderer is already attached to that handle ("Replaces any
 *    previously attached renderer", its own doc comment). A `StreamHandle`
 *    can paint exactly one `<canvas>` at a time. There is no way for two
 *    `<browser-glass>` elements on the SAME target, sharing the SAME
 *    client connection, to both have a live picture at once: whichever
 *    called `attach()` most recently owns the canvas, and the other's
 *    view has gone stale with no signal that it happened.
 *
 * This module answers both, and the answer is one mechanism, not two
 * policies picked per hazard: every `<browser-glass>` element that wants a
 * given `(client, targetId)` pair registers as a subscriber. The first one
 * becomes PRIMARY and is told to attach a real renderer. Anyone after it
 * is QUEUED, told so explicitly (so the duplicate-target case is loud, not
 * silent), and gets nothing painted, but its interest is still counted:
 * the underlying `client.subscribe()` is not torn down as long as anyone,
 * primary or queued, still wants it, which closes hazard 1. If the
 * primary later disconnects, the next queued subscriber is promoted and
 * told to attach, which turns hazard 2 from "permanently refused" into
 * "second widget on the same target works as soon as the first one
 * leaves" at no extra cost, since the wire subscription was kept alive for
 * it the whole time anyway.
 *
 * Two widgets on two DIFFERENT targets never enter this file's queueing
 * path at all: each target gets its own entry, its own `subscribe()` call,
 * and its own primary slot, so they stream and are drivable fully
 * independently. That is the common case this whole package exists for;
 * the queueing behaviour above only matters for the deliberately unusual
 * case of pointing two elements at the one target.
 */

/** What a subscriber (a `<browser-glass>` element) is told by this module. It never touches `StreamHandle.attach()`/`detach()` itself except from inside these two calls, so ownership of "who currently owns the canvas" always lives here, not duplicated in the element. */
export interface TargetStreamSubscriber {
  /** This subscriber is now (or still) the one live view for its target. Attach a renderer to `handle` now. */
  onPrimary(handle: StreamHandle): void;
  /** Another element already owns the live view for this target. `aheadCount` is how many subscribers are ahead of this one in the promotion queue (normally `1`). Called again with an updated count if someone ahead of this subscriber releases without ever being promoted. */
  onQueued(aheadCount: number): void;
}

interface TargetEntry {
  refCount: number;
  handlePromise: Promise<StreamHandle>;
  handle: StreamHandle | null;
  primary: TargetStreamSubscriber | null;
  queue: TargetStreamSubscriber[];
}

/** One entry per `BrowserGlassClient`, so releasing a client (see {@link acquireClient}) also drops its whole target map with it; nothing here outlives the client it describes. */
const targetsByClient = new WeakMap<BrowserGlassClient, Map<string, TargetEntry>>();

function requeueRemaining(entry: TargetEntry): void {
  entry.queue.forEach((subscriber, i) => subscriber.onQueued(i + 1));
}

/**
 * Registers `subscriber`'s interest in `targetId` on `client`, subscribing
 * over the wire at most once no matter how many subscribers register for
 * the same pair, and arbitrating which one (if any) is currently painted.
 * Returns a `release()` to call from the subscriber's own teardown
 * (`disconnectedCallback`, or an attribute change that points the element
 * elsewhere); the actual `client.unsubscribe()` only happens once every
 * subscriber of that target has released.
 */
export function acquireTargetStream(
  client: BrowserGlassClient,
  targetId: string,
  subscribeOpts: Omit<SubscribeOptions, 'canvas' | 'container'> | undefined,
  subscriber: TargetStreamSubscriber,
): { release(): void } {
  let byTarget = targetsByClient.get(client);
  if (!byTarget) {
    byTarget = new Map();
    targetsByClient.set(client, byTarget);
  }

  let entry = byTarget.get(targetId);
  if (!entry) {
    entry = {
      refCount: 0,
      handlePromise: client.subscribe(targetId, subscribeOpts),
      handle: null,
      primary: null,
      queue: [],
    };
    byTarget.set(targetId, entry);
  }
  entry.refCount += 1;
  const myEntry = entry;

  myEntry.handlePromise
    .then((handle) => {
      // The whole entry can have been torn down (every subscriber released,
      // including this one) while the network round trip for the initial
      // `stream.subscribe` was still in flight; `byTarget.get` no longer
      // returning this entry is how that is detected, since `refCount`
      // alone cannot distinguish "released" from "never got a turn yet".
      if (byTarget.get(targetId) !== myEntry) return;
      myEntry.handle = handle;
      if (myEntry.primary === null) {
        myEntry.primary = subscriber;
        subscriber.onPrimary(handle);
      } else if (myEntry.primary !== subscriber && !myEntry.queue.includes(subscriber)) {
        myEntry.queue.push(subscriber);
        subscriber.onQueued(myEntry.queue.length);
      }
    })
    .catch(() => {
      // A failed `stream.subscribe` (target gone, capability missing) is
      // surfaced through the element's own `client.on('error', ...)`
      // wiring; nothing target-slot-specific to do with it here.
    });

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    myEntry.refCount -= 1;

    const queuedIdx = myEntry.queue.indexOf(subscriber);
    if (queuedIdx !== -1) myEntry.queue.splice(queuedIdx, 1);

    if (myEntry.primary === subscriber) {
      myEntry.primary = null;
      const next = myEntry.queue.shift();
      if (next && myEntry.handle) {
        myEntry.primary = next;
        next.onPrimary(myEntry.handle);
        requeueRemaining(myEntry);
      }
    } else if (queuedIdx !== -1) {
      requeueRemaining(myEntry);
    }

    if (myEntry.refCount <= 0) {
      byTarget.delete(targetId);
      myEntry.handlePromise.then(
        (handle) => void client.unsubscribe(handle).catch(() => {}),
        () => {
          // subscribe() itself never resolved; nothing to unsubscribe.
        },
      );
    }
  };

  return { release };
}

interface ClientEntry {
  client: BrowserGlassClient;
  refCount: number;
}

/** One entry per `(url, token)` pair actually in use right now. */
const clientsByKey = new Map<string, ClientEntry>();

function keyFor(url: string, token: string | undefined): string {
  // `\u0000` cannot appear in either a URL or a bearer token, so this is a
  // safe unambiguous join with no delimiter-collision case to worry about.
  return `${url}\u0000${token ?? ''}`;
}

/**
 * Returns a `BrowserGlassClient` connected to `url` with `token`, sharing
 * one already in flight for the same `(url, token)` pair rather than
 * opening a second socket. This is the "N widgets, one gateway" half of
 * this package's multi-widget story: a page with three `<browser-glass>`
 * elements all pointed at the same gateway and the same viewer token ends
 * up with exactly one WebSocket, not three, because that is what "the
 * gateway" and "the session" mean to the wire protocol: one socket, N
 * subscribed targets.
 *
 * A different `url` or a different `token` gets its own client and its
 * own socket; there is no cross-session sharing to be had there, and
 * trying would mean silently attaching one element's credentials to
 * another's connection.
 *
 * Reference counted like {@link acquireTargetStream}: the underlying
 * client is only constructed on the first caller for a key and only
 * `destroy()`ed once the last caller releases it.
 *
 * `opts.credentials`, when given, is threaded straight into
 * `BrowserGlassClient`'s own `credentials` option (`element.ts`'s
 * `#resolveCredentials`, wired from `onTokenExpired`/`token-endpoint`):
 * this is what lets a bearer token capped at 900 seconds
 * (`docs/protocol/wire-spec.md`) get refreshed without the host page ever
 * having to swap the `token` attribute itself. Only consulted the first
 * time a given `(url, token)` key is constructed, exactly like `token`
 * itself: a later acquirer sharing that same key gets the ALREADY LIVE
 * client, credentials callback included (or not), whichever the first
 * acquirer supplied. Once that client is live, its own internal token can
 * drift away from the string this key was built from, transparently,
 * every time `credentials()` runs, without ever needing a new pool entry:
 * `keyFor` names the credential the connection STARTED with, not its
 * current one, which is exactly why this pool never keeps handing out a
 * socket still authenticated with a token everyone has moved past. It
 * only stops handing out the client at all once every acquirer of that
 * original key has released.
 */
export function acquireClient(
  url: string,
  token: string | undefined,
  opts?: { readonly credentials?: () => Promise<{ ticket?: string; token?: string }> },
): { client: BrowserGlassClient; release(): void } {
  const key = keyFor(url, token);
  let entry = clientsByKey.get(key);
  if (!entry) {
    const client = new BrowserGlassClient({
      // The viewer may be reached over a LAN/WSL IP with plain ws:// (no TLS on the gateway);
      // the client's loopback-only guard would otherwise refuse to connect at all.
      transport: { allowInsecureTransport: true },
      url,
      ...(token !== undefined ? { token } : {}),
      ...(opts?.credentials !== undefined ? { credentials: opts.credentials } : {}),
    });
    entry = { client, refCount: 0 };
    clientsByKey.set(key, entry);
    // Errors from a failed initial connect are not thrown here: they
    // surface through this same client's own 'fatal'/'error' events, which
    // every acquiring element already listens to (see `element.ts`). A
    // rejected promise with nobody awaiting it would otherwise show up as
    // an unhandled rejection in the host page's console for no reason.
    client.connect().catch(() => {});
  }
  entry.refCount += 1;
  const myEntry = entry;

  let released = false;
  const release = (): void => {
    if (released) return;
    released = true;
    myEntry.refCount -= 1;
    if (myEntry.refCount <= 0) {
      clientsByKey.delete(key);
      myEntry.client.destroy();
    }
  };

  return { client: myEntry.client, release };
}
