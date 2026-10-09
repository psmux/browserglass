/**
 * The `worker_threads` entry point behind {@link SyncBridge}
 * (`bridge.ts`). Runs in its own thread, owns exactly one `pg.Client` for
 * the lifetime of one `Store.transaction()` call, and executes each
 * command the main thread sends it (`connect`, `begin`, `query`, `commit`,
 * `rollback`, `end`) against that one client, replying over the same
 * `MessagePort` the main thread blocks on via `Atomics.wait`.
 *
 * Why this file exists at all: `@browserglass/protocol`'s `StoreTx`
 * interface (`get`/`insert`/`update`/`delete`/`raw`) is SYNCHRONOUS by
 * design (`store.ts`'s own top comment: "so nothing can `await` while the
 * write lock is held"), because `store-sqlite`'s `better-sqlite3` binding
 * is genuinely synchronous. `pg` has no synchronous query API: every
 * round trip is a real TCP conversation. Node has no way to block the
 * calling thread on network I/O without moving that I/O to a second
 * thread and blocking on `Atomics.wait` for it to finish, which is
 * exactly the architecture this file and `bridge.ts` implement together.
 * A worker thread's event loop can `await` normally; only the boundary
 * back to the main thread needs to look synchronous.
 */
import { parentPort, workerData } from 'node:worker_threads';
import type { MessagePort } from 'node:worker_threads';
import { Client } from 'pg';
import type { ClientConfig } from 'pg';
import { buildTypeOverrides } from '../engine.js';

interface WorkerData {
  readonly port: MessagePort;
  /** The raw `SharedArrayBuffer` `bridge.ts` allocated. A `SharedArrayBuffer` structured-clones as itself, not as whatever typed array view the sender happened to construct over it, so this side must wrap it in its own `Int32Array` view (below) rather than destructuring it as one directly. */
  readonly sync: SharedArrayBuffer;
  readonly connectionString: string;
  readonly ssl?: ClientConfig['ssl'];
  readonly applicationName?: string;
}

interface OkReply {
  ok: true;
  rows?: unknown[];
  rowCount?: number | null;
  /** `pg`'s own `QueryResult.command` (`'SELECT'`, `'UPDATE'`, `'INSERT'`, ...): the only way `PgTx.raw` (`tx.ts`) can tell an empty `SELECT` (zero matching rows, correctly `[]`) apart from a writer statement with no `RETURNING` (also `rows: []`, but reported as `[{ changes: rowCount }]` for parity with `store-sqlite`'s `SqliteTx.raw`). */
  command?: string;
}
interface ErrReply {
  ok: false;
  error: { message: string; code?: string };
}
type Reply = OkReply | ErrReply;

type Command =
  | { type: 'connect' }
  | { type: 'begin'; isolation?: 'read-committed' | 'serializable' }
  | { type: 'query'; sql: string; params: unknown[] }
  | { type: 'commit' }
  | { type: 'rollback' }
  | { type: 'end' };

const { port, sync: syncBuffer, connectionString, ssl, applicationName } = workerData as WorkerData;
const sync = new Int32Array(syncBuffer);

let client: Client | null = null;

function reply(msg: Reply): void {
  port.postMessage(msg);
  Atomics.store(sync, 0, 1);
  Atomics.notify(sync, 0, 1);
}

function errorReply(err: unknown): ErrReply {
  const message = err instanceof Error ? err.message : String(err);
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code?: unknown }).code)
      : undefined;
  return { ok: false, error: { message, ...(code !== undefined ? { code } : {}) } };
}

port.on('message', (cmd: Command) => {
  void (async () => {
    try {
      switch (cmd.type) {
        case 'connect': {
          client = new Client({
            connectionString,
            ssl,
            application_name: applicationName ?? 'browserglass-tx',
            types: buildTypeOverrides(),
            // Bounded, unlike `pg.Client`'s own default of no timeout at
            // all: a `connect()` against a host that never answers (a
            // dropped port on some platforms, rather than an immediate
            // `ECONNREFUSED`) would otherwise hang until
            // `SyncBridge`'s own `Atomics.wait` timeout fires, reporting a
            // confusing "worker did not respond" rather than the real,
            // specific connection failure.
            connectionTimeoutMillis: 10_000,
          });
          await client.connect();
          reply({ ok: true });
          break;
        }
        case 'begin': {
          if (!client) throw new Error('sync worker: begin before connect');
          await client.query(
            cmd.isolation === 'serializable' ? 'BEGIN ISOLATION LEVEL SERIALIZABLE' : 'BEGIN',
          );
          reply({ ok: true });
          break;
        }
        case 'query': {
          if (!client) throw new Error('sync worker: query before connect');
          const result = await client.query(cmd.sql, cmd.params);
          reply({
            ok: true,
            rows: result.rows,
            rowCount: result.rowCount,
            command: result.command,
          });
          break;
        }
        case 'commit': {
          if (!client) throw new Error('sync worker: commit before connect');
          await client.query('COMMIT');
          reply({ ok: true });
          break;
        }
        case 'rollback': {
          if (client) {
            // Best effort: a ROLLBACK issued after the connection is
            // already broken (the error that triggered the rollback was a
            // dropped connection) would itself throw; the transaction is
            // gone either way, so this never surfaces a second error over
            // the first one.
            await client.query('ROLLBACK').catch(() => undefined);
          }
          reply({ ok: true });
          break;
        }
        case 'end': {
          await client?.end().catch(() => undefined);
          reply({ ok: true });
          break;
        }
        default: {
          const exhaustive: never = cmd;
          throw new Error(`sync worker: unknown command ${JSON.stringify(exhaustive)}`);
        }
      }
    } catch (err) {
      reply(errorReply(err));
    }
  })();
});

// A worker thread with no active handles other than the port's listener
// would otherwise exit as soon as its initial script finishes running;
// `parentPort` itself keeps it alive, but referencing it here makes that
// dependency explicit for a reader rather than relying on an ambient
// Node.js default.
void parentPort;
