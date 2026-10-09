'use client';

import type { BrowserGlassClient, TargetSummary } from '@browserglass/client';
import { useCallback, useEffect, useState } from 'react';

/** Return shape of {@link useTargets}. */
export interface UseTargetsResult {
  targets: TargetSummary[];
  activeTargetId: string | null;
  loading: boolean;
  open: (
    url?: string,
    opts?: { background?: boolean; newWindow?: boolean },
  ) => Promise<TargetSummary>;
  close: (targetId: string) => Promise<void>;
  activate: (targetId: string) => Promise<void>;
  reorder: (targetIds: string[]) => Promise<void>;
  /** `false` when the token lacks `tabs.manage`. */
  canManage: boolean;
}

const EMPTY_TARGETS: TargetSummary[] = [];

interface TargetsState {
  targets: TargetSummary[];
  loading: boolean;
}

/**
 * Live tab list plus operations, already capability-checked, for tabs
 * *within* one instance/session. There is no hook for listing separate
 * browser instances; that is REST-based app code, and a
 * `useBrowserInstances` hook will not be created.
 */
export function useTargets(client: BrowserGlassClient | null): UseTargetsResult {
  const [state, setState] = useState<TargetsState>(() => ({
    targets: client ? [...client.targets] : EMPTY_TARGETS,
    loading: client !== null,
  }));

  useEffect(() => {
    if (!client) {
      setState({ targets: EMPTY_TARGETS, loading: false });
      return;
    }
    setState({ targets: [...client.targets], loading: client.targets.length === 0 });
    const offs = [
      client.on('connected', (ev) => setState({ targets: ev.targets, loading: false })),
      client.on('targets', (ev) => setState({ targets: ev.targets, loading: false })),
    ];
    return () => {
      for (const off of offs) off();
    };
  }, [client]);

  const open = useCallback(
    async (
      url?: string,
      opts?: { background?: boolean; newWindow?: boolean },
    ): Promise<TargetSummary> => {
      if (!client) throw new Error('useTargets(): no client');
      return client.tabs.new({
        ...(url !== undefined ? { url } : {}),
        ...(opts?.background !== undefined ? { background: opts.background } : {}),
        ...(opts?.newWindow !== undefined ? { newWindow: opts.newWindow } : {}),
      });
    },
    [client],
  );
  const close = useCallback(
    async (targetId: string): Promise<void> => {
      if (!client) return;
      await client.tabs.close(targetId);
    },
    [client],
  );
  const activate = useCallback(
    async (targetId: string): Promise<void> => {
      if (!client) return;
      await client.tabs.activate(targetId);
    },
    [client],
  );
  const reorder = useCallback(
    async (targetIds: string[]): Promise<void> => {
      if (!client) return;
      await client.tabs.reorder(targetIds);
    },
    [client],
  );

  // `TargetSummary.active` is now per OS window (window isolation gives
  // each window its own live target, not the Instance as a whole), so more
  // than one target in `state.targets` can be `active` at once. This picks
  // whichever one happens to sort first, the same "pick one" compromise
  // `core`'s deprecated `Session.activeTargetId` shim makes for callers
  // that still want a single id; a caller driving several windows at once
  // should read `t.active` per target instead of this field.
  const activeTargetId = state.targets.find((t) => t.active)?.targetId ?? null;

  return {
    targets: state.targets,
    activeTargetId,
    loading: state.loading,
    open,
    close,
    activate,
    reorder,
    canManage: client?.granted.has('tabs.manage') ?? false,
  };
}
