import type { NodeId, NodeState } from '@browserglass/protocol';

/** One named preflight check's verdict. `fix` is set whenever `verdict` is not `'pass'`. */
export interface PreflightResult {
  readonly name: string;
  readonly verdict: 'pass' | 'warn' | 'fail' | 'skipped';
  readonly durationMs: number;
  readonly detail: string;
  readonly fix?: string;
  readonly observed?: Readonly<Record<string, unknown>>;
}

/** Returned by {@link start}. */
export interface StartReport {
  readonly startedAt: number;
  readonly durationMs: number;
  readonly mode: 'embedded' | 'supervised' | 'gateway';
  readonly preflight: readonly PreflightResult[];
  readonly store: {
    readonly driver: string;
    readonly migrationsApplied: number;
    readonly schemaVersion: number;
  };
  readonly runtimes: readonly {
    readonly name: string;
    readonly ready: boolean;
    readonly detail: string;
  }[];
  readonly nodes: readonly { readonly nodeId: NodeId; readonly state: NodeState }[];
  readonly pools: readonly {
    readonly name: string;
    readonly poolId: string;
    readonly created: boolean;
  }[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** Options accepted by {@link stop}. */
export interface StopOptions {
  readonly deadlineMs?: number;
  readonly closeCode?: number;
  readonly instances?: 'release' | 'leave';
  readonly immediate?: boolean;
}

/** Returned by {@link stop}. `stop` never throws; failures are reported here. */
export interface StopReport {
  readonly durationMs: number;
  readonly viewersClosed: number;
  readonly sessionsEnded: number;
  readonly instancesReleased: number;
  readonly instancesLeft: number;
  readonly storeFlushed: boolean;
  readonly auditFlushed: boolean;
  readonly deadlineExceeded: boolean;
  readonly forced: readonly { readonly what: string; readonly id: string }[];
}

/** Thrown by {@link start} when config validation already failed further upstream would be redundant; kept for symmetry with the other lifecycle errors below. */
export class LifecycleError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'LifecycleError';
    this.code = code;
  }
}

/** Thrown by {@link start} when `preflight.mode` is `'fail'` and a named check fails. */
export class PreflightError extends Error {
  readonly code = 'E_PREFLIGHT_FAILED' as const;
  readonly results: readonly PreflightResult[];
  constructor(results: readonly PreflightResult[]) {
    const failed = results.filter((r) => r.verdict === 'fail');
    super(
      `BrowserGlass preflight failed (${failed.length} check${failed.length === 1 ? '' : 's'}): ${failed
        .map((r) => `${r.name}: ${r.detail}${r.fix !== undefined ? ` Fix: ${r.fix}` : ''}`)
        .join(' | ')}`,
    );
    this.name = 'PreflightError';
    this.results = results;
  }
}

/** Thrown by {@link start} when the store cannot be opened or migrated. */
export class StoreError extends Error {
  readonly code: string;
  constructor(code: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'StoreError';
    this.code = code;
  }
}

/** Thrown by {@link start} when the local node cannot be registered (embedded/supervised) or the remote control plane is unreachable (gateway). */
export class RouterUnavailableError extends Error {
  readonly code = 'E_ROUTER_UNAVAILABLE' as const;
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = 'RouterUnavailableError';
  }
}
