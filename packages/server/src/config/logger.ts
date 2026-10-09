/**
 * Structured field bag passed to every {@link Logger} call. Values are kept
 * to JSON scalars only, so a sink can serialise them without a custom
 * replacer. Page content, clipboard contents, form values, and keystrokes
 * must never appear here, at any level.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | null | undefined>>;

/**
 * The logging seam `@browserglass/server` writes through. Fields first,
 * message second (matches pino, so an adapter for pino is the identity
 * function). `child` is optional: when present it is called once per
 * session and once per instance so subsequent records auto carry ids; when
 * absent, fields are merged into every call instead.
 */
export interface Logger {
  trace(fields: LogFields, message: string): void;
  debug(fields: LogFields, message: string): void;
  info(fields: LogFields, message: string): void;
  warn(fields: LogFields, message: string): void;
  error(fields: LogFields, message: string): void;
  child?(fields: LogFields): Logger;
}

const LEVEL_RANK: Readonly<Record<'trace' | 'debug' | 'info' | 'warn' | 'error', number>> = {
  trace: 0,
  debug: 1,
  info: 2,
  warn: 3,
  error: 4,
};

/** Field names that are always scrubbed to `[redacted]` before a log line is emitted, in addition to `logger.redact`. */
export const DEFAULT_LOG_REDACT: readonly string[] = Object.freeze([
  'token',
  'ticket',
  'cookie',
  'authorization',
  'password',
]);

function redactFields(fields: LogFields, redact: ReadonlySet<string>): LogFields {
  if (redact.size === 0) return fields;
  let out: Record<string, string | number | boolean | null | undefined> | undefined;
  for (const key of Object.keys(fields)) {
    if (redact.has(key.toLowerCase())) {
      out ??= { ...fields };
      out[key] = '[redacted]';
    }
  }
  return out ?? fields;
}

/**
 * Wraps a console-backed {@link Logger}. Used only when `logger.sink` is
 * unset; `createBrowserGlass` logs once at startup that this is happening.
 */
export function consoleLogger(opts: {
  readonly level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  readonly format: 'pretty' | 'json';
  readonly redact: readonly string[];
}): Logger {
  const minRank = LEVEL_RANK[opts.level];
  const redact = new Set(opts.redact.map((r) => r.toLowerCase()));

  function write(level: keyof typeof LEVEL_RANK, fields: LogFields, message: string): void {
    if (LEVEL_RANK[level] < minRank) return;
    const safe = redactFields(fields, redact);
    if (opts.format === 'json') {
      const line = JSON.stringify({ level, message, ...safe, time: Date.now() });
      // eslint-disable-next-line no-console
      console.log(line);
      return;
    }
    const suffix = Object.keys(safe).length > 0 ? ` ${JSON.stringify(safe)}` : '';
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}${suffix}`);
  }

  return {
    trace: (f, m) => write('trace', f, m),
    debug: (f, m) => write('debug', f, m),
    info: (f, m) => write('info', f, m),
    warn: (f, m) => write('warn', f, m),
    error: (f, m) => write('error', f, m),
  };
}

/** A {@link Logger} that discards every call. Used by tests and by `preflight` dry runs. */
export const noopLogger: Logger = Object.freeze({
  trace: () => undefined,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
});
