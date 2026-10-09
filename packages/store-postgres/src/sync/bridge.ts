import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/**
 * `SyncBridge`: a synchronous facade over one Postgres transaction,
 * backed by `worker.ts` running on a dedicated `worker_threads` thread.
 * See `worker.ts`'s top comment for why this exists at all.
 *
 * The mechanism (a well known Node.js pattern for building a synchronous
 * API on an asynchronous one, e.g. how `receiveMessageOnPort` itself is
 * documented): the main thread and the worker share one
 * `MessageChannel`'s two ports and one `SharedArrayBuffer`-backed
 * `Int32Array` of length 1. To make a synchronous call, the main thread
 * posts a command on its port, then `Atomics.wait()`s on the shared int32
 * until the worker (after actually awaiting the real, asynchronous `pg`
 * query) posts its reply and calls `Atomics.notify()`. `postMessage`
 * enqueues into the channel's internal queue immediately, independent of
 * whether the receiving end is in flowing mode, so `receiveMessageOnPort`
 * can pull the already-queued reply synchronously the instant
 * `Atomics.wait` returns, with no dependency on the event loop turning at
 * all. This is genuinely blocking, real inter-thread synchronisation, not
 * a `setImmediate` polling loop.
 *
 * One `SyncBridge` is spun up per `Store.transaction()` call and torn
 * down at the end of it (`store.ts`): a fresh worker thread and a fresh
 * `pg.Client` per transaction, not a pooled/reused worker. `transaction()`
 * is not this store's hot path (ticket issuance, key rotation, invite
 * redemption), so the worker startup and connection cost is an accepted
 * trade for an implementation that is simple enough to reason about and
 * does not risk one transaction's failure corrupting a reused worker's
 * state for the next.
 */
import { MessageChannel, Worker, receiveMessageOnPort } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import type { ClientConfig } from 'pg';

/** How long the main thread will block in `Atomics.wait` for one reply before giving up and treating the worker as dead. Generous: this guards against a crashed/hung worker, not normal query latency. */
const CALL_TIMEOUT_MS = 30_000;

export interface SyncBridgeOptions {
  connectionString: string;
  ssl?: ClientConfig['ssl'];
  applicationName?: string;
}

interface OkReply {
  ok: true;
  rows?: unknown[];
  rowCount?: number | null;
  command?: string;
}
interface ErrReply {
  ok: false;
  error: { message: string; code?: string };
}
type Reply = OkReply | ErrReply;

/** A plain `Error` carrying the Postgres `code` field (`23505`, `40001`, ...) the way a real `pg` driver error does, so `retry.ts`/`isUniqueViolation` work identically whether the error crossed a real `pg.Client` call or this bridge. */
export class BridgeQueryError extends Error {
  readonly code: string | undefined;
  constructor(message: string, code: string | undefined) {
    super(message);
    this.name = 'BridgeQueryError';
    this.code = code;
  }
}

/**
 * Locates the compiled `sync-worker.{mjs,cjs}` `tsup.config.ts` builds as
 * its own entry from `src/sync/worker.ts`. Tried as two different layouts
 * because this module itself runs from two different locations depending
 * on how the caller loaded the package:
 *
 * - built (the published package, `dist/index.{mjs,cjs}`, this file
 *   bundled into it): `import.meta.url`/`__dirname` land in `dist/`, and
 *   the compiled worker is a sibling file right there.
 * - source (a test running directly against `src/index.ts`, no build
 *   step): `import.meta.url`/`__dirname` land in `src/sync/`, two
 *   directories below the package root, and the only executable worker
 *   script that can exist is still the one `tsup` produced under
 *   `dist/`, which a prior `tsup` build (this package's `pretest` script)
 *   must have already produced.
 *
 * Whichever layout resolves to a file that actually exists on disk wins;
 * if neither does, the error names the fix (`npm run build`) rather than
 * a bare `ENOENT` on a worker thread the caller never sees construct.
 */
function resolveWorkerPath(): string {
  const isCjs = typeof __dirname !== 'undefined';
  const here = isCjs ? __dirname : dirname(fileURLToPath(import.meta.url));
  const filename = isCjs ? 'sync-worker.cjs' : 'sync-worker.mjs';
  const candidates = [
    join(here, filename), // built: this file's own dist/ directory
    join(here, '..', '..', 'dist', filename), // source: src/sync/ -> package root/dist
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `@browserglass/store-postgres: could not find ${filename} (looked in: ${candidates.join(', ')}). Store.transaction() requires this package to be built first: run "npm run build" (tsup) in packages/store-postgres.`,
  );
}

/** A synchronous handle onto one live Postgres transaction, running on a dedicated worker thread. */
export class SyncBridge {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private readonly sync: Int32Array;
  private closed = false;

  constructor(options: SyncBridgeOptions) {
    const { port1, port2 } = new MessageChannel();
    const sab = new SharedArrayBuffer(4);
    this.sync = new Int32Array(sab);
    this.port = port1;
    this.worker = new Worker(resolveWorkerPath(), {
      workerData: {
        port: port2,
        sync: sab,
        connectionString: options.connectionString,
        ssl: options.ssl,
        applicationName: options.applicationName,
      },
      transferList: [port2],
    });
    // A worker thread that throws before it ever replies (a bad
    // connection string caught as a synchronous constructor throw inside
    // `pg`, for example) would otherwise leave the main thread's
    // `Atomics.wait` below to run out its full timeout for no reason; this
    // makes that case fail fast instead. Errors that happen mid reply
    // (after a command was already sent) are still delivered through the
    // normal reply channel, since the worker's own `try`/`catch` around
    // each command handles those.
    this.worker.on('error', (err) => {
      if (this.closed) return;
      // Unblocks a pending `Atomics.wait` immediately by writing a
      // synthetic error reply and notifying, so `call()` surfaces this
      // error on its very next wake rather than after the full timeout.
      try {
        port1.postMessage({
          ok: false,
          error: { message: `worker thread crashed: ${err.message}` },
        } satisfies Reply);
        Atomics.store(this.sync, 0, 1);
        Atomics.notify(this.sync, 0, 1);
      } catch {
        // Port already closed; nothing left to unblock.
      }
    });
    this.call({ type: 'connect' });
  }

  private call(command: unknown): {
    rows: unknown[];
    rowCount: number | null;
    command: string | undefined;
  } {
    if (this.closed) throw new Error('sync bridge: call after close()');
    Atomics.store(this.sync, 0, 0);
    this.port.postMessage(command);
    const waitResult = Atomics.wait(this.sync, 0, 0, CALL_TIMEOUT_MS);
    if (waitResult === 'timed-out') {
      throw new Error(
        `sync bridge: worker did not respond within ${CALL_TIMEOUT_MS}ms; the underlying Postgres transaction is presumed dead`,
      );
    }
    const received = receiveMessageOnPort(this.port);
    if (!received) {
      throw new Error('sync bridge: woke from Atomics.wait but no reply message was queued');
    }
    const reply = received.message as Reply;
    if (!reply.ok) throw new BridgeQueryError(reply.error.message, reply.error.code);
    return { rows: reply.rows ?? [], rowCount: reply.rowCount ?? null, command: reply.command };
  }

  /**
   * Runs one query against the transaction's connection, synchronously,
   * and returns its rows, row count, and `pg`'s own `command` tag
   * (`'SELECT'`, `'UPDATE'`, ...). `PgTx.raw` (`tx.ts`) needs `command` to
   * tell an empty `SELECT` apart from a writer statement with no
   * `RETURNING`; every other caller in this package only reads `rows`.
   */
  query<T>(
    sql: string,
    params: readonly unknown[],
  ): { rows: T[]; rowCount: number | null; command: string | undefined } {
    const result = this.call({ type: 'query', sql, params: [...params] });
    return { rows: result.rows as T[], rowCount: result.rowCount, command: result.command };
  }

  begin(isolation?: 'read-committed' | 'serializable'): void {
    this.call({ type: 'begin', isolation });
  }

  commit(): void {
    this.call({ type: 'commit' });
  }

  rollback(): void {
    this.call({ type: 'rollback' });
  }

  /** Ends the worker's `pg.Client` and terminates the worker thread. Never throws; always call this exactly once, in a `finally`. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      this.call({ type: 'end' });
    } catch {
      // The connection may already be gone (the error this transaction is
      // unwinding from might be a dropped connection); closing must not
      // itself throw.
    }
    this.port.close();
    await this.worker.terminate();
  }
}
