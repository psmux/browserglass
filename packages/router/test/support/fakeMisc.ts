/** No-op `AuditSink`/`MetricsSink` and a generous `QuotaProvider`, shared across router level tests. */

import type { AuditSink, AuditSinkEvent, MetricsSink, QuotaProvider } from '@browserglass/protocol';

/** An `AuditSink` that records every event it receives, for a test that wants to assert on them. */
export function createRecordingAuditSink(): AuditSink & { events: AuditSinkEvent[] } {
  const events: AuditSinkEvent[] = [];
  return {
    events,
    emit: (event: AuditSinkEvent) => {
      events.push(event);
    },
    flush: () => Promise.resolve(),
  };
}

/** A `MetricsSink` that does nothing. */
export const noopMetricsSink: MetricsSink = {
  counter: () => undefined,
  gauge: () => undefined,
  histogram: () => undefined,
};

/** A `QuotaProvider` with generous, fixed limits, for tests that are not specifically exercising quota narrowing. `overrides` lets a test set a tight limit (for example `maxInstances: 1`). */
export function createFakeQuotaProvider(
  overrides?: Partial<Awaited<ReturnType<QuotaProvider['limits']>>>,
): QuotaProvider {
  return {
    limits: () =>
      Promise.resolve({
        maxInstances: 1000,
        maxInstancesPerApp: 1000,
        maxInstancesPerUser: 1000,
        maxViewers: 1000,
        maxProfiles: 1000,
        maxProfileBytes: 1_000_000_000,
        maxSessionMinutesPerDay: 100_000,
        maxAcquiresPerMinute: 1000,
        maxFrameBytesPerMinute: 1_000_000_000,
        ...overrides,
      }),
  };
}
