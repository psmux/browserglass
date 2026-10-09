/**
 * The router's minimal logging seam.
 *
 * `@browserglass/router` sits at layer 5 and depends on
 * `@browserglass/protocol` only, so it cannot import
 * `@browserglass/server`'s `Logger`. It does not need to: this interface is
 * a structural subset of that one (same fields-first, message-second shape,
 * which is also pino's), so a server built `Logger` is assignable here with
 * no adapter, and a deployment that already has one can simply pass it.
 *
 * Only `warn` is declared. The router has exactly one thing it must say
 * that nobody else can say for it, and widening this to a full five level
 * interface would invite general purpose logging into a control plane that
 * reports through `AuditSink` and `MetricsSink` everywhere else.
 */
export type RouterLogFields = Readonly<
  Record<string, string | number | boolean | null | undefined>
>;

/** Where the router reports a failure it deliberately does not throw on. Satisfied structurally by `@browserglass/server`'s `Logger`. */
export interface RouterLogger {
  warn(fields: RouterLogFields, message: string): void;
}

/**
 * The default {@link RouterLogger}: one line on `console.warn`.
 *
 * A library writing to the console by default is unusual, and the reason
 * it is right here is narrow. The only call sites are resource reclaim
 * failures on the release path, where the previous behaviour was
 * `.catch(() => undefined)`: a profile teardown that had never once
 * succeeded in a deployment looked exactly like one that always worked,
 * and the only symptom was a profile root quietly growing to gigabytes. A
 * leak that reports nothing is worse than a leak that is noisy, and these
 * lines are emitted only when a reclaim has actually failed, never on the
 * ordinary path. A deployment that wants them structured passes its own
 * `logger` and this is never constructed.
 */
export const consoleWarnRouterLogger: RouterLogger = {
  warn(fields, message) {
    const suffix = Object.keys(fields).length > 0 ? ` ${JSON.stringify(fields)}` : '';
    // eslint-disable-next-line no-console
    console.warn(`[warn] ${message}${suffix}`);
  },
};

/** Renders an unknown thrown value into the two log fields worth having: its error code, when it carries one, and its message. */
export function errorLogFields(err: unknown): { errorCode: string | null; error: string } {
  const asError = err as { code?: unknown; message?: unknown } | null;
  const code = typeof asError?.code === 'string' ? asError.code : null;
  const message = typeof asError?.message === 'string' ? asError.message : String(err);
  return { errorCode: code, error: message };
}
