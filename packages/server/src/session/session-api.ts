/**
 * `SessionApi` (`bg.sessions`):
 * live, in-process session inspection and moderation actions, distinct from
 * `packages/server/src/rest/routes/sessions.ts`'s `GET /v1/sessions/:id`
 * REST routes (which read the durable `SessionRow`/viewer rows via
 * `Store`). This object reads and acts on exactly what is live in this
 * process's {@link SessionRegistry}, which is the correct source of truth
 * for `kick`/`grantControl`/`broadcast` (actions that only make sense
 * against a socket that is actually open right now).
 *
 * The five view types below (`SessionView`, `ViewerView`, `TargetView`,
 * `StreamView`, `ControlLeaseView`) are defined here. Each carries exactly what a caller inspecting a live session needs.
 */

import type { Capability, TargetSummary } from '@browserglass/protocol';
import { buildGoodbye } from '../wire/close.js';
import type { ManagedSession } from './managed-session.js';
import type { SessionRegistry } from './registry.js';

/** A live session, as `SessionApi.get`/`.list` report it. */
export interface SessionView {
  readonly sessionId: string;
  readonly instanceId: string;
  readonly tenantId: string;
  readonly appId: string;
  readonly state: string;
  readonly viewerCount: number;
}

/** One connected viewer, as `SessionApi.viewers` reports it. */
export interface ViewerView {
  readonly viewerId: string;
  readonly capabilities: readonly Capability[];
}

/** One target, as `SessionApi.targets` reports it (identical shape to the wire `TargetSummary`, since it is one). */
export type TargetView = TargetSummary;

/** One live stream subscription, as `SessionApi.streams` reports it. */
export interface StreamView {
  readonly streamId: number;
  readonly targetId: string;
  readonly viewerId: string;
}

/** One target's current control lease, as `SessionApi.grantControl` reports it. */
export interface ControlLeaseView {
  readonly targetId: string;
  readonly leaseId: string | null;
  readonly holderViewerId: string | null;
}

/** Filter accepted by `SessionApi.list`. */
export interface SessionFilter {
  readonly instanceId?: string;
  readonly tenantId?: string;
}

/** A single page of results, the `Page<T>` convention used elsewhere on this interface. */
export interface Page<T> {
  readonly items: readonly T[];
  readonly nextCursor: string | null;
}

class SessionApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'SessionApiError';
  }
}

function findManaged(registry: SessionRegistry, sessionId: string): ManagedSession {
  const found = registry.all().find((m) => m.sessionId === sessionId);
  if (!found) throw new SessionApiError('E_SESSION_NOT_FOUND', `No live session "${sessionId}".`);
  return found;
}

function toSessionView(m: ManagedSession): SessionView {
  return {
    sessionId: m.sessionId,
    instanceId: m.instanceId,
    tenantId: m.tenantId,
    appId: m.appId,
    state: m.coreSession.state,
    viewerCount: m.viewerCount,
  };
}

/** `SessionApi`. Every method reads or acts on `registry`'s live state. */
export interface SessionApi {
  get(sessionId: string): Promise<SessionView>;
  list(filter: SessionFilter): Promise<Page<SessionView>>;
  viewers(sessionId: string): Promise<readonly ViewerView[]>;
  targets(sessionId: string): Promise<readonly TargetView[]>;
  streams(sessionId: string): Promise<readonly StreamView[]>;
  kick(
    sessionId: string,
    viewerId: string,
    opts: { readonly reason?: string; readonly code?: number },
  ): Promise<void>;
  revokeControl(
    sessionId: string,
    targetId: string,
    opts: { readonly reason?: string },
  ): Promise<void>;
  grantControl(
    sessionId: string,
    targetId: string,
    viewerId: string,
    opts: { readonly force?: boolean },
  ): Promise<ControlLeaseView>;
  broadcast(
    sessionId: string,
    notice: { readonly level: 'info' | 'warn'; readonly text: string },
  ): Promise<number>;
  end(sessionId: string, opts: { readonly code?: number; readonly reason?: string }): Promise<void>;
}

/** Builds a {@link SessionApi} over `registry`. */
export function createSessionApi(registry: SessionRegistry): SessionApi {
  return {
    async get(sessionId) {
      return toSessionView(findManaged(registry, sessionId));
    },

    async list(filter) {
      const items = registry
        .all()
        .filter(
          (m) =>
            (filter.instanceId === undefined || m.instanceId === filter.instanceId) &&
            (filter.tenantId === undefined || m.tenantId === filter.tenantId),
        )
        .map(toSessionView);
      return { items, nextCursor: null };
    },

    async viewers(sessionId) {
      const managed = findManaged(registry, sessionId);
      return managed.allConnections().map((c) => ({ viewerId: c.viewerId, capabilities: [] }));
    },

    async targets(sessionId) {
      return findManaged(registry, sessionId).listTargets();
    },

    async streams(sessionId) {
      return findManaged(registry, sessionId).listStreams();
    },

    async kick(sessionId, viewerId, opts) {
      const managed = findManaged(registry, sessionId);
      const conn = managed.connectionFor(viewerId);
      if (!conn)
        throw new SessionApiError(
          'E_VIEWER_NOT_FOUND',
          `No live viewer "${viewerId}" on session "${sessionId}".`,
        );
      const code = opts.code ?? 4003;
      conn.sendEnvelope(buildGoodbye(code, opts.reason ?? 'Kicked by an administrator.'));
      conn.close(code, opts.reason ?? 'kicked');
    },

    async revokeControl(sessionId, targetId, opts) {
      const managed = findManaged(registry, sessionId);
      const result = await managed.revokeControl(
        {
          viewerId: 'bgls:admin',
          identity: 'bgls:admin',
          label: 'Admin',
          kind: 'human',
          capabilities: [],
          isAdmin: true,
        },
        targetId,
        'admin',
        opts.reason,
      );
      if (!result.ok)
        throw new SessionApiError(
          'E_TARGET_NOT_FOUND',
          `Target "${targetId}" has no active lease to revoke, or the holder no longer matches.`,
        );
    },

    async grantControl(sessionId, targetId, viewerId, opts) {
      const managed = findManaged(registry, sessionId);
      managed.requestControl(
        {
          viewerId,
          identity: viewerId,
          label: viewerId,
          kind: 'human',
          capabilities: ['control'],
          isAdmin: true,
        },
        targetId,
        { force: opts.force ?? true, queue: false },
      );
      return { targetId, leaseId: null, holderViewerId: viewerId };
    },

    async broadcast(sessionId, notice) {
      const managed = findManaged(registry, sessionId);
      let count = 0;
      for (const conn of managed.allConnections()) {
        conn.sendEnvelope({
          t: 'error',
          code: 'bgls.error.internal',
          category: 'internal',
          message: notice.text,
          fatal: false,
          retryable: false,
        });
        count += 1;
      }
      return count;
    },

    async end(sessionId, opts) {
      const managed = findManaged(registry, sessionId);
      const code = opts.code ?? 4000;
      for (const conn of managed.allConnections()) {
        conn.sendEnvelope(buildGoodbye(code, opts.reason ?? 'Session ended.'));
        conn.close(code, opts.reason ?? 'session_ended');
      }
    },
  };
}
