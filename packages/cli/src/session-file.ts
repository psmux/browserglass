/**
 * `<dataDir>/dev-session.json`: the local discovery file `bgls serve`
 * writes on startup so a sibling `bgls doctor`/`bgls inspect` invocation,
 * run later from the same directory with no `--endpoint`/`--token`, can
 * find the gateway and mint its own admin token from the same dev signing
 * key (see `dev-key.ts`). Local development only.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DevSigningKey } from './dev-key.js';

const SESSION_SCHEMA = 'bgls.dev-session/1' as const;
const SESSION_FILENAME = 'dev-session.json';

/** The full contents of a `dev-session.json` file. */
export interface BglsDevSession {
  readonly schema: typeof SESSION_SCHEMA;
  readonly pid: number;
  readonly startedAt: number;
  /** `http(s)://host:port`. */
  readonly endpoint: string;
  /** `ws(s)://host:port<basePath>/socket`. */
  readonly wsUrl: string;
  readonly basePath: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly issuer: string;
  readonly key: DevSigningKey;
}

/** Absolute path to the session file under `dataDir`. */
export function sessionFilePath(dataDir: string): string {
  return join(dataDir, SESSION_FILENAME);
}

/**
 * Writes the session file, creating `dataDir` if needed. Best effort mode
 * 0o600 on POSIX (Windows ACLs are left at their default; this file is
 * dev-tooling convenience, not a production secret store).
 */
export function writeDevSession(dataDir: string, session: BglsDevSession): void {
  mkdirSync(dataDir, { recursive: true });
  const path = sessionFilePath(dataDir);
  writeFileSync(path, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 });
}

/** Reads and validates the session file, or returns `null` when absent or unreadable. Never throws. */
export function readDevSession(dataDir: string): BglsDevSession | null {
  try {
    const raw = readFileSync(sessionFilePath(dataDir), 'utf8');
    const parsed = JSON.parse(raw) as Partial<BglsDevSession>;
    if (parsed.schema !== SESSION_SCHEMA || typeof parsed.endpoint !== 'string') return null;
    return parsed as BglsDevSession;
  } catch {
    return null;
  }
}

/** The default data directory `bgls serve` and its siblings use when `--profiles-dir`/`--data-dir` is not given: `./bgls-data` under the current working directory. */
export function defaultDataDir(): string {
  return process.env['BGLS_DATA_DIR'] ?? join(process.cwd(), 'bgls-data');
}
