'use client';

import type {
  BrowserGlassClient,
  ControlOutcome,
  ControlRequestOptions,
  ControlYieldResult,
} from '@browserglass/client';
import { useCallback, useEffect, useState } from 'react';

/** Return shape of {@link useControlLease}. */
export interface UseControlLeaseResult {
  hasControl: boolean;
  holder: { viewerId: string; label: string } | null;
  expiresAt: number | null;
  /** 1-based; `null` when not queued. */
  queuePosition: number | null;
  queueLength: number;
  requesting: boolean;
  request: (opts?: ControlRequestOptions) => Promise<ControlOutcome>;
  release: () => Promise<void>;
  /**
   * Asks the agents driving this target to stand down, leaving every person
   * driving it alone. Shared mode only; on an exclusive target
   * {@link request} is what takes a tab off an agent, and this throws
   * `bgls.error.control.not_shared` rather than doing nothing.
   *
   * Separate from {@link request} on purpose, and NOT folded into it. They
   * are two different acts and a caller genuinely wants both orders
   * available: taking control does not ask anybody to stop, and asking an
   * agent to stop does not make the caller a driver. A takeover button
   * usually wants both, in that order, so the person's claim never depends
   * on the agent agreeing to anything.
   */
  yieldAgents: (reason?: string) => Promise<ControlYieldResult>;
  /** `true` when the token has `control`. */
  canRequest: boolean;
  lastLostReason: string | null;
}

interface LeaseSnapshot {
  hasControl: boolean;
  holder: { viewerId: string; label: string } | null;
  expiresAt: number | null;
  queuePosition: number | null;
  queueLength: number;
  lastLostReason: string | null;
}

const EMPTY_SNAPSHOT: LeaseSnapshot = {
  hasControl: false,
  holder: null,
  expiresAt: null,
  queuePosition: null,
  queueLength: 0,
  lastLostReason: null,
};

/** Everything a "request control" button needs. */
export function useControlLease(
  client: BrowserGlassClient | null,
  targetId: string | null,
): UseControlLeaseResult {
  const [snapshot, setSnapshot] = useState<LeaseSnapshot>(EMPTY_SNAPSHOT);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    setSnapshot(EMPTY_SNAPSHOT);
    if (!client || !targetId) return;

    const apply = (): void => {
      const lease = client.leases.get(targetId);
      setSnapshot((s) => ({
        hasControl: client.hasControl(targetId),
        holder: lease?.holderViewerId
          ? { viewerId: lease.holderViewerId, label: lease.holderLabel ?? '' }
          : null,
        expiresAt: lease?.expiresAt ?? null,
        queuePosition: lease?.queuePosition ?? null,
        queueLength: lease?.queueLength ?? 0,
        lastLostReason: s.lastLostReason,
      }));
    };
    apply();

    const offs = [
      client.on('control', apply),
      client.on('controllost', (ev) => {
        if (ev.targetId !== targetId) return;
        setSnapshot((s) => ({ ...s, lastLostReason: ev.reason }));
        apply();
      }),
      client.on('controlpreempted', (ev) => {
        if (ev.targetId !== targetId) return;
        apply();
      }),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client, targetId]);

  const request = useCallback(
    async (opts?: ControlRequestOptions): Promise<ControlOutcome> => {
      if (!client || !targetId) throw new Error('useControlLease(): no client or targetId');
      setRequesting(true);
      try {
        return await client.requestControl(targetId, opts);
      } finally {
        setRequesting(false);
      }
    },
    [client, targetId],
  );

  const release = useCallback(async (): Promise<void> => {
    if (!client || !targetId) return;
    await client.releaseControl(targetId);
  }, [client, targetId]);

  const yieldAgents = useCallback(
    async (reason?: string): Promise<ControlYieldResult> => {
      if (!client || !targetId) throw new Error('useControlLease(): no client or targetId');
      return client.yieldControl(targetId, reason);
    },
    [client, targetId],
  );

  return {
    ...snapshot,
    requesting,
    request,
    release,
    yieldAgents,
    canRequest: client?.granted.has('control') ?? false,
  };
}
