/**
 * Process exit codes every `bgls` command uses: `0` success, `1` operational failure, `2` usage error, `3`
 * precondition failed (used heavily by `bgls doctor`).
 *
 * `4` to `6` extend that same scheme for the browser-driving commands
 * (`instances *`, `swarm run`): a script piping `bgls`'s `--json` output
 * needs to branch on more than "it failed somehow", so a driving command
 * that fails maps its error onto the narrowest of these four that
 * applies, falling back to `operationalFailure` only when none does. See
 * `mapDriveErrorToExitCode()` in `commands/instances-cmd.ts` for that
 * mapping.
 *
 * - `4` `notFound`: the instance or target named on the command line does
 *   not exist (a REST 404, or `AutomationError` codes `NOT_FOUND` /
 *   `TARGET_CLOSED` / `INSTANCE_GONE`).
 * - `5` `policyDenied`: the token minted for this call was narrowed below
 *   what the action needs, or another viewer holds the lease
 *   (`AutomationError` codes `POLICY_DENIED` / `LEASE_NOT_HELD` /
 *   `LEASE_REVOKED`).
 * - `6` `timeout`: connecting to the instance, or the action itself,
 *   never got a reply in time (`AutomationError` code `TIMEOUT`, or every
 *   `connectAutomation()` retry in `util/drive.ts` being exhausted).
 */
export const EXIT_CODES = {
  ok: 0,
  operationalFailure: 1,
  usageError: 2,
  preconditionFailed: 3,
  notFound: 4,
  policyDenied: 5,
  timeout: 6,
} as const;

/** One of {@link EXIT_CODES}'s values. */
export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

/**
 * Thrown by a command implementation to end the process with a specific
 * exit code. The message is assumed already printed to the user (via the
 * command's own `Printer`); `BglsExit.message` exists only for logs/tests.
 */
export class BglsExit extends Error {
  readonly code: ExitCode;
  constructor(code: ExitCode, message: string) {
    super(message);
    this.name = 'BglsExit';
    this.code = code;
  }
}
