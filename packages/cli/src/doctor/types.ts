/**
 * Shared result shape for every `bgls doctor` check, `checks.ts` and
 * `deep.ts`. Mirrors `@browserglass/server`'s own `PreflightResult`
 * (`packages/server/src/lifecycle/types.ts`) so the two read the same at a
 * glance, without doctor depending on server's internal preflight module.
 */

/** One named check's verdict. `fail` and `warn` both carry a `fix`; `fail` is what makes `bgls doctor` exit non-zero. */
export interface DoctorCheckResult {
  readonly name: string;
  readonly group:
    | 'environment'
    | 'browser'
    | 'store'
    | 'profiles'
    | 'packages'
    | 'network'
    | 'plugins'
    | 'invariants';
  readonly verdict: 'pass' | 'warn' | 'fail' | 'skipped';
  readonly durationMs: number;
  readonly detail: string;
  readonly fix?: string;
  readonly observed?: Readonly<Record<string, unknown>>;
}

/** Runs `fn`, timing it and normalising a thrown error into a `fail` result, exactly like `@browserglass/server`'s internal `timed()`. */
export async function timedCheck(
  name: string,
  group: DoctorCheckResult['group'],
  fn: () => Promise<Omit<DoctorCheckResult, 'name' | 'group' | 'durationMs'>>,
): Promise<DoctorCheckResult> {
  const start = performance.now();
  try {
    const result = await fn();
    return { name, group, durationMs: performance.now() - start, ...result };
  } catch (err) {
    return {
      name,
      group,
      durationMs: performance.now() - start,
      verdict: 'fail',
      detail: `Check threw: ${err instanceof Error ? err.message : String(err)}`,
      fix: 'This is an internal bgls doctor bug; report it with the stack trace from --verbose output.',
    };
  }
}
