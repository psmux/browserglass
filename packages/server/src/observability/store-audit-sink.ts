import { createHash } from 'node:crypto';
import type { AuditEvent, AuditSink, AuditSinkEvent, Store, StoreTx } from '@browserglass/protocol';
import type { Logger } from '../config/logger.js';
import { noopLogger } from '../config/logger.js';

/**
 * Why this file exists: `audit_events` (`store-sqlite/migrations/0001_initial.sql`)
 * has a tamper evident hash chain (`prev_hash`, `hash`) and `BrowserRouter`
 * already calls `this.audit.emit(...)` for `instance.acquired`,
 * `instance.drive` and `instance.released` (`packages/router/src/router/BrowserRouter.ts`),
 * but `observability.auditSink` (`server/src/config/types.ts`) is optional
 * and nothing ever configured one, so every one of those calls went to
 * `wiring.ts`'s `noopAuditSink` and the table stayed empty in every real
 * deployment. This is the sink `config/resolve.ts` wires in as the
 * DEFAULT whenever a `Store` is configured and the operator did not supply
 * their own `observability.auditSink`, so a deployment that configures
 * nothing still gets a real, persisted audit trail.
 */

/** How long an emitted event may sit in memory before a periodic flush picks it up, absent `flushIntervalMs`. Independent of `observability.auditInputBatchWindowMs`, which windows `input.batch` counts before an `AuditSinkEvent` is even constructed; this constant windows already constructed events before they reach the store. */
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;
/** A flush fires early, without waiting for the timer, once the queue reaches this size. */
const DEFAULT_MAX_BATCH_SIZE = 500;
/** Hard ceiling on in memory events. Past this, `emit` drops the OLDEST queued event to make room for the newest: see `emit`'s own comment for why that direction, not the other one. */
const DEFAULT_MAX_QUEUE_SIZE = 5_000;

export interface StoreAuditSinkOptions {
  readonly store: Store;
  /** Used for every `AuditSinkEvent` variant that carries no `tid` of its own (`instance.released`, every session scoped kind: `viewer.*`, `control.*`, `input.batch`, `navigate`, `clipboard`, `file`). See `mapAuditSinkEvent`'s own comment for the full list and why this fallback is honest rather than a hack: `wiring.ts`'s `quotaProviderFromLimits` already relies on the same "one tenant, one app per gateway process" assumption for embedded mode. */
  readonly tenantId: string;
  /** Same fallback role as `tenantId`, for `appId`. */
  readonly appId?: string | null;
  /** Receives one `warn` per failed flush. Defaults to `noopLogger`, matching this sink's own best effort contract: a missing logger must not turn a swallowed failure into a thrown one. */
  readonly logger?: Logger;
  readonly flushIntervalMs?: number;
  readonly maxBatchSize?: number;
  readonly maxQueueSize?: number;
}

/**
 * Builds the row `Store.appendAuditChained` persists from one
 * `AuditSinkEvent`, filling in the two fields no variant carries:
 * `tenantId` (see {@link StoreAuditSinkOptions.tenantId}) and `occurredAt`
 * (assigned by the caller, not read from `event.at` directly; see
 * `appendChainedBatch`'s own comment on why).
 *
 * Every field the union does not have a dedicated column for (`caps`,
 * `counts`, `windowMs`, `profileKey`, `reused`, `local`, `leaseId`, `by`,
 * `code`, `bytes`, `sha256`, `key`, `op`, `limit`, `policy`) goes into
 * `detail`, matching `AuditEvent.detail`'s role as the catch all `Json`
 * column (`protocol/src/domain/store-types.ts`).
 */
function mapAuditSinkEvent(
  event: AuditSinkEvent,
  fallbackTenantId: string,
  fallbackAppId: string | null,
  occurredAt: string,
): Omit<AuditEvent, 'id' | 'prevHash' | 'hash'> {
  const base = { occurredAt, eventType: event.k };
  switch (event.k) {
    case 'auth.accepted':
      return {
        ...base,
        tenantId: event.tid,
        appId: event.aid,
        actorSub: event.sub,
        viewerId: event.vid,
        remoteIp: event.ip,
      };
    case 'auth.rejected':
      return {
        ...base,
        tenantId: event.tid ?? fallbackTenantId,
        outcome: 'rejected',
        remoteIp: event.ip,
        detail: { reason: event.reason, code: event.code },
      };
    case 'instance.acquired':
      return {
        ...base,
        tenantId: event.tid,
        appId: event.aid,
        instanceId: event.iid,
        nodeId: event.nid,
        detail: { profileKey: event.profileKey, reused: event.reused },
      };
    case 'instance.released':
      // No `tid`/`aid` on this variant at all (`extension-points.ts`'s
      // `AuditSinkEvent` union): `BrowserRouter.release()` emits it after
      // the instance row's own tenant scoping already did its job
      // (`assertScopeAllowsInstance`), so the fallback tenant below is
      // this build's single tenant, not a guess.
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        instanceId: event.iid,
        outcome: event.reason,
        detail: { durationMs: event.durationMs },
      };
    case 'instance.drive':
      return {
        ...base,
        tenantId: event.tid,
        appId: event.aid,
        instanceId: event.iid,
        nodeId: event.nid,
        detail: { local: event.local },
      };
    case 'viewer.attached':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        viewerId: event.vid,
        actorSub: event.sub,
        detail: { caps: event.caps },
      };
    case 'viewer.detached':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        viewerId: event.vid,
        detail: { code: event.code },
      };
    case 'control.granted':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        targetId: event.tgt,
        viewerId: event.vid,
        detail: { leaseId: event.leaseId },
      };
    case 'control.revoked':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        targetId: event.tgt,
        viewerId: event.vid,
        outcome: event.reason,
        detail: { leaseId: event.leaseId, by: event.by ?? null },
      };
    case 'input.batch':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        targetId: event.tgt,
        viewerId: event.vid,
        detail: { counts: event.counts, windowMs: event.windowMs },
      };
    case 'navigate':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        targetId: event.tgt,
        viewerId: event.vid,
        outcome: event.allowed ? 'allowed' : 'denied',
        detail: { url: event.url, policy: event.policy ?? null },
      };
    case 'clipboard':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        viewerId: event.vid,
        detail: { dir: event.dir, bytes: event.bytes },
      };
    case 'file':
      return {
        ...base,
        tenantId: fallbackTenantId,
        appId: fallbackAppId,
        sessionId: event.sid,
        viewerId: event.vid,
        detail: { dir: event.dir, name: event.name, bytes: event.bytes, sha256: event.sha256 },
      };
    case 'profile':
      return {
        ...base,
        tenantId: event.tid,
        actorSub: event.by,
        detail: { key: event.key, op: event.op },
      };
    case 'quota':
      return {
        ...base,
        tenantId: event.tid,
        appId: event.aid ?? fallbackAppId,
        outcome: event.action,
        detail: { limit: event.limit },
      };
  }
}

/**
 * The tamper evident hash: a SHA-256 digest over the previous row's hash
 * plus this row's own content, so altering any stored row invalidates
 * every hash chained after it. No hash function existed anywhere in this
 * codebase before this file (`appendAuditChained` computes and stores
 * `prev_hash` itself but only ever persists whatever `hash` the caller
 * hands it, `store-sqlite/src/store.ts`); this is a new, first
 * implementation, not a port of an existing algorithm, and there is
 * correspondingly no verifier anywhere yet that checks a row's `hash`
 * against its content. A future verifier MUST reuse this exact canonical
 * form, field order included, or it will report tampering that never
 * happened.
 */
function computeAuditHash(
  prevHash: string | null,
  row: Omit<AuditEvent, 'id' | 'prevHash' | 'hash'>,
): string {
  const canonical = JSON.stringify({
    prevHash,
    tenantId: row.tenantId,
    appId: row.appId ?? null,
    occurredAt: row.occurredAt,
    eventType: row.eventType,
    severity: row.severity ?? 'info',
    actorSub: row.actorSub ?? null,
    actorKind: row.actorKind ?? null,
    instanceId: row.instanceId ?? null,
    sessionId: row.sessionId ?? null,
    viewerId: row.viewerId ?? null,
    targetId: row.targetId ?? null,
    nodeId: row.nodeId ?? null,
    outcome: row.outcome ?? 'ok',
    detail: row.detail ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Appends one batch inside a SINGLE transaction, in emission order, and
 * hand computes every row's `hash` before calling `appendAuditChained`
 * rather than leaving the field null.
 *
 * `appendAuditChained` (`store-sqlite/src/store.ts`, ported verbatim to
 * `store-postgres/src/store.ts`) determines `prev_hash` itself, by
 * `SELECT hash FROM audit_events WHERE tenant_id = ? ORDER BY occurred_at
 * DESC LIMIT 1` immediately before every insert, and stores back exactly
 * the `hash` field it was given. So for this batch's computed `hash`
 * values to actually chain onto what the store persists as `prev_hash`,
 * two things must both hold, and this function is what makes them hold:
 *
 *  1. This function must run that identical query itself, once, before the
 *     loop, to learn the true on disk tail, then track the chain forward
 *     locally (`prevHash` reassigned each iteration) rather than
 *     re-querying per row: since every write in this transaction is this
 *     function's own, the local value and what the store's internal query
 *     would return are guaranteed to agree, without a race, ONLY as long
 *     as (2) also holds.
 *  2. Every row's `occurred_at` must be strictly increasing within the
 *     transaction. Two rows sharing a millisecond (routine: an
 *     `instance.acquired` and an `instance.drive` from the same `acquire()`
 *     call can carry the same `at`) would make `ORDER BY occurred_at DESC
 *     LIMIT 1` ambiguous, and an ambiguous tie is free to return either
 *     row, silently attaching the store's own `prev_hash` to a hash this
 *     function did not chain from. The loop below enforces this by
 *     clamping each row's assigned millisecond to `max(event.at, last + 1)`.
 *
 * All of it inside one `store.transaction(...)` call, so a flush that
 * fails partway rolls back completely: the chain either advances by the
 * whole batch or not at all, never a prefix of it (which is what "cannot
 * corrupt or reorder the chain" requires from batching in the first
 * place).
 */
function appendChainedBatch(
  tx: StoreTx,
  store: Store,
  tenantId: string,
  appId: string | null,
  batch: readonly AuditSinkEvent[],
): void {
  const tail = tx.raw<{ hash: string | null; occurred_at: string }>(
    'SELECT hash, occurred_at FROM audit_events WHERE tenant_id = ? ORDER BY occurred_at DESC LIMIT 1',
    [tenantId],
  )[0];
  let prevHash = tail?.hash ?? null;
  let lastMs = tail !== undefined ? Date.parse(tail.occurred_at) : 0;

  for (const event of batch) {
    const ms = Math.max(event.at, lastMs + 1);
    lastMs = ms;
    const occurredAt = new Date(ms).toISOString();

    const row = mapAuditSinkEvent(event, tenantId, appId, occurredAt);
    const hash = computeAuditHash(prevHash, row);
    store.appendAuditChained(tx, row.tenantId, { ...row, hash });
    prevHash = hash;
  }
}

/**
 * The default `AuditSink`, backed by the same `Store` the rest of this
 * gateway already persists to. Wired in by `config/resolve.ts` whenever
 * `config.store` is set and the operator did not supply their own
 * `observability.auditSink` (that check happens at the call site, not
 * here, so an explicit operator sink always wins outright).
 *
 * `emit` is synchronous and only ever pushes to an in memory array,
 * matching `AuditSink`'s own doc contract in
 * `protocol/src/domain/extension-points.ts`: "Must never throw, must
 * never block; batched and asynchronous, never on the hot path." The
 * actual store write happens later, off a timer or once the queue crosses
 * `maxBatchSize`, never inline with whatever call emitted the event
 * (an `acquire()`, a `release()`, ...).
 */
export function createStoreAuditSink(opts: StoreAuditSinkOptions): AuditSink {
  const { store, tenantId } = opts;
  const appId = opts.appId ?? null;
  const logger = opts.logger ?? noopLogger;
  const flushIntervalMs = opts.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const maxBatchSize = opts.maxBatchSize ?? DEFAULT_MAX_BATCH_SIZE;
  const maxQueueSize = opts.maxQueueSize ?? DEFAULT_MAX_QUEUE_SIZE;

  let queue: AuditSinkEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let inFlight: Promise<void> | undefined;

  function armTimer(): void {
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      void runFlush();
    }, flushIntervalMs);
    // Never keeps the process alive on its own: a gateway with a queued
    // event and nothing else to do must still be able to exit, and
    // `stop()`'s own phase 6 (`lifecycle/stop.ts`) calls `flush()`
    // directly for the shutdown path anyway.
    timer.unref?.();
  }

  async function doFlush(): Promise<void> {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (queue.length === 0) return;
    const batch = queue;
    queue = [];
    try {
      await store.transaction((tx) => appendChainedBatch(tx, store, tenantId, appId, batch));
    } catch (err) {
      // Best effort, matching `BrowserRouter.release()`'s internal
      // `.catch(() => undefined)` calls for exactly the same reason
      // (`packages/router/src/router/BrowserRouter.ts`, e.g. its capacity
      // eviction path around line 772: "Best effort, matching every other
      // internal `release()` call in this file") and `AuditSink`'s own
      // "must never throw, must never block" contract. Losing this batch
      // of audit rows is bad; failing the acquire, release, or drive call
      // that happened to be running when this timer fired because the
      // audit store hiccuped would be worse, and there is no caller left
      // to report the failure to by the time a timer driven flush runs.
      logger.warn(
        {
          component: 'server',
          batchSize: batch.length,
          error: err instanceof Error ? err.message : String(err),
        },
        'audit: flush failed; this batch of audit_events rows was dropped',
      );
    }
  }

  function runFlush(): Promise<void> {
    // Serialises flushes: a timer firing while a batch size triggered
    // flush is still awaiting its transaction must not open a second,
    // overlapping transaction against the same hash chain tail, which
    // `appendChainedBatch`'s correctness argument (see its own comment)
    // depends on there being exactly one writer in flight at a time.
    if (inFlight === undefined) {
      inFlight = doFlush().finally(() => {
        inFlight = undefined;
      });
    } else {
      inFlight = inFlight.then(() => doFlush());
    }
    return inFlight;
  }

  return {
    emit(event: AuditSinkEvent): void {
      if (queue.length >= maxQueueSize) {
        // Drop the OLDEST queued event, not the incoming one. A sink that
        // is falling behind (store down, disk full) should keep losing
        // history further back in time, not go deaf to what is happening
        // right now; the newest events are the ones an operator debugging
        // the outage actually wants once the store recovers.
        queue.shift();
      }
      queue.push(event);
      if (queue.length >= maxBatchSize) {
        void runFlush();
      } else {
        armTimer();
      }
    },
    flush(): Promise<void> {
      return runFlush();
    },
  };
}
