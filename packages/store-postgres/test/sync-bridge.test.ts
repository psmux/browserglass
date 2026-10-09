/**
 * Exercises the `SyncBridge`/`sync-worker` mechanism itself (`sync/
 * bridge.ts`, `sync/worker.ts`): the `worker_threads` spawn, the
 * `SharedArrayBuffer`/`Atomics.wait`/`Atomics.notify` handshake, the
 * `MessageChannel` command/reply round trip, and synchronous error
 * propagation back across it. This does NOT require a reachable Postgres
 * server to be meaningful: `pg.Client#connect()` against an address that
 * refuses the connection immediately (a loopback port nothing listens on)
 * still exercises the ENTIRE bridge end to end, including a real
 * asynchronous `pg` operation running on the worker thread and a real
 * error crossing back over the synchronous boundary to the constructor
 * call site, which is the one thing this package cannot get from any
 * other test file in an environment with no Postgres server installed
 * (see `store.test.ts`'s top comment for why that is the case here).
 *
 * What this file does NOT prove: that a successful `connect()`/`BEGIN`/
 * `query`/`COMMIT` sequence against a live server round-trips real data
 * correctly end to end. `test/concurrency.test.ts`'s
 * `Store.transaction()`/`StoreTx` test covers that, gated on
 * `BGLS_TEST_POSTGRES_URL`.
 */
import { describe, expect, it } from 'vitest';
import { BridgeQueryError, SyncBridge } from '../src/sync/bridge.js';

const UNREACHABLE_URL = 'postgres://user:pass@127.0.0.1:1/nope';

describe('SyncBridge against an unreachable server', () => {
  it("the constructor blocks synchronously, then throws a BridgeQueryError once the worker thread's pg.Client#connect() rejects", () => {
    let bridge: SyncBridge | undefined;
    try {
      expect(() => {
        bridge = new SyncBridge({ connectionString: UNREACHABLE_URL });
      }).toThrow(BridgeQueryError);
    } finally {
      // Constructing throws before `bridge` is ever assigned in the
      // failure case; nothing to close. Guarded for the (unexpected,
      // would-be-a-real-bug) case where a future change makes the
      // constructor succeed against a bad address.
      void bridge?.close();
    }
  }, 15_000);
});
