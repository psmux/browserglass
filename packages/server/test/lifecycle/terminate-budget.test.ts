import { PROFILE_CLEAR_BUDGET_MS } from '@browserglass/runtime-host';
import { describe, expect, it } from 'vitest';
import {
  MIRRORED_PROFILE_CLEAR_BUDGET_MS_FOR_TEST,
  TERMINATE_LADDER_BUDGET_MS_FOR_TEST,
} from '../../src/lifecycle/stop.js';

/**
 * Guards the one invariant `stop.ts` cannot guard for itself.
 *
 * Phase 5 of `stop()` wraps `nodeTransport.terminate()`, whose step 5
 * (`confirmProfileClear`, `runtime-host/src/terminate.ts`) cannot report
 * success before `PROFILE_CLEAR_BUDGET_MS` has elapsed when a straggler
 * survives the first kill attempt. If this package's own budget is the
 * smaller of the two, phase 5 gives up and reports
 * `deadlineExceeded: true` before a single `terminate()` call could ever
 * legitimately finish. That already happened once: a hardcoded 12000ms
 * here drifted while `PROFILE_CLEAR_BUDGET_MS` was independently raised
 * from 5000ms to 15000ms.
 *
 * The obvious fix, importing the constant, is not available: a VALUE
 * import of `@browserglass/runtime-host` from `packages/server/src` is
 * bundled into `dist/index.mjs` by tsup, dragging in a `better-sqlite3`
 * import this package does not declare, which makes the built package
 * unloadable (`ERR_MODULE_NOT_FOUND`). `config/types.ts` documents the
 * no-dependency-edge rule this violates, four times over.
 *
 * So `stop.ts` mirrors the number as a literal, and this test, which is
 * never bundled and may freely use the devDependency, is what keeps the
 * mirror honest.
 */
describe('stop(): the terminate ladder budget versus runtime-host', () => {
  it('mirrors runtime-host PROFILE_CLEAR_BUDGET_MS exactly', () => {
    expect(MIRRORED_PROFILE_CLEAR_BUDGET_MS_FOR_TEST).toBe(PROFILE_CLEAR_BUDGET_MS);
  });

  it('grants phase 5 strictly more time than one confirm-dead budget', () => {
    // Strictly greater, not greater-or-equal: an equal budget still loses
    // the race, because the ladder needs time for `killProcessTree` and
    // the router's own teardown on top of the confirm scan.
    expect(TERMINATE_LADDER_BUDGET_MS_FOR_TEST).toBeGreaterThan(PROFILE_CLEAR_BUDGET_MS);
  });
});
