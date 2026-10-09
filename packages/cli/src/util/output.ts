/**
 * Output handling shared by every `bgls` command: a `consola` instance
 * tuned by `--quiet`/`--verbose`/`--no-color`, and the `--json` versus
 * human-readable result split every command honours (every command
 * supports `--json`).
 */

import { createConsola } from 'consola';
import type { ConsolaInstance } from 'consola';

/** Parsed global flags every command reads before doing anything else. See `context.ts`'s `GLOBAL_ARGS`. */
export interface GlobalFlags {
  readonly config?: string;
  readonly endpoint?: string;
  readonly token?: string;
  readonly json: boolean;
  readonly quiet: boolean;
  readonly verbose: boolean;
  readonly noColor: boolean;
  readonly profile?: string;
}

/**
 * Wraps a `consola` instance with the `--json` split: `result()` prints
 * structured data as JSON when `--json` is set, and otherwise defers to a
 * caller-supplied human formatter. Human-facing log lines (`info`/`warn`/
 * `error`/`success`) are suppressed entirely in `--json` mode so a
 * command's stdout is valid JSON and nothing else, and `--quiet` further
 * suppresses everything below `warn`.
 */
export class Printer {
  readonly json: boolean;
  readonly verbose: boolean;
  private readonly consola: ConsolaInstance;

  constructor(flags: GlobalFlags) {
    this.json = flags.json;
    this.verbose = flags.verbose;
    this.consola = createConsola({
      level: flags.verbose ? 5 : flags.quiet ? 1 : 3,
      formatOptions: { colors: !flags.noColor, date: false },
    });
  }

  /** Debug-level, `--verbose` only. */
  debug(message: string, ...args: unknown[]): void {
    if (!this.json) this.consola.debug(message, ...args);
  }

  /** Informational line. Suppressed in `--json` mode. */
  info(message: string, ...args: unknown[]): void {
    if (!this.json) this.consola.info(message, ...args);
  }

  /** Warning line. Suppressed in `--json` mode. */
  warn(message: string, ...args: unknown[]): void {
    if (!this.json) this.consola.warn(message, ...args);
  }

  /** Error line. Always shown, even in `--json` mode, on `process.stderr` so it never corrupts a piped JSON stdout stream. */
  error(message: string, ...args: unknown[]): void {
    this.consola.error(message, ...args);
  }

  /** Success line. Suppressed in `--json` mode. */
  success(message: string, ...args: unknown[]): void {
    if (!this.json) this.consola.success(message, ...args);
  }

  /**
   * Emits a command's structured result: `JSON.stringify(data)` to stdout
   * in `--json` mode (compact, one line, machine-parseable), or
   * `human(data)` otherwise. `human` is expected to call `this.info`/
   * `console.log`/etc itself.
   */
  result<T>(data: T, human: (data: T) => void): void {
    if (this.json) {
      process.stdout.write(`${JSON.stringify(data)}\n`);
    } else {
      human(data);
    }
  }
}
