import { execFile } from 'node:child_process';
/**
 * Real concurrency, not a mock: two separate OS processes, each with its
 * own `better-sqlite3` connection to the same database file, racing
 * `acquireProfileLease` for one profile at the same instant. This is the
 * only way to exercise
 * `idx_profile_lease_live`, `SQLITE_BUSY`, and the retry/backoff path
 * against genuine simultaneous writers rather than one JS thread's
 * cooperative scheduling.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { freshStore, seedBasics } from './helpers.js';

const execFileAsync = promisify(execFile);

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKER = join(HERE, 'fixtures', 'lease-worker.mjs');
const DIST_ENTRY = join(HERE, '..', 'dist', 'index.mjs');

interface WorkerResult {
  pid: number;
  lease: { id: string; fence: number } | null;
}

function runWorker(
  dbPath: string,
  tenantId: string,
  profileId: string,
  nodeId: string,
  ttlMs: number,
): Promise<WorkerResult> {
  return execFileAsync(process.execPath, [
    WORKER,
    dbPath,
    tenantId,
    profileId,
    nodeId,
    String(ttlMs),
  ]).then(({ stdout }) => JSON.parse(stdout) as WorkerResult);
}

// This suite needs the package built (`pnpm --filter @browserglass/store-sqlite build`)
// because the worker process runs against the real dist/index.mjs, not
// against TypeScript source a bare `node` process cannot load.
describe.skipIf(!existsSync(DIST_ENTRY))(
  'acquireProfileLease under real multi-process concurrency',
  () => {
    it('two OS processes racing for one profile lease produce exactly one winner and one null', async () => {
      const f = freshStore();
      const { tenant, node, profile } = await seedBasics(f.store);
      f.db.close(); // release the setup connection so it cannot itself hold the writer lock during the race

      const [a, b] = await Promise.all([
        runWorker(f.dbPath, tenant.id, profile.id, node.id, 30000),
        runWorker(f.dbPath, tenant.id, profile.id, node.id, 30000),
      ]);

      const winners = [a, b].filter((r) => r.lease !== null);
      const losers = [a, b].filter((r) => r.lease === null);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      expect(winners[0]!.lease!.fence).toBe(1);

      // Reopen to verify durable state: exactly one live lease row survives.
      const db2 = (await import('../src/engine.js')).openSqlite(f.dbPath);
      const liveCount = db2
        .prepare(
          'SELECT COUNT(*) AS n FROM profile_leases WHERE profile_id = ? AND released_at IS NULL',
        )
        .get(profile.id) as { n: number };
      expect(liveCount.n).toBe(1);
      db2.close();

      f.cleanup();
    }, 20000);
  },
);
