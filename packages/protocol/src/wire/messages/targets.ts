import type { Envelope } from '../envelope.js';

/** The kind of a Chrome DevTools Protocol target. */
export type TargetKind = 'page' | 'iframe' | 'worker' | 'service_worker' | 'other';

/** The wire projection of a Target, sent in `welcome.targets` and the `target.*` messages. */
export interface TargetSummary {
  targetId: string;
  kind: TargetKind;
  title: string;
  url: string;
  faviconUrl: string | null;
  index: number;
  /** The OS window this target lives in, from `Browser.getWindowForTarget`. Null when unknown. */
  windowId: number | null;
  /**
   * True when this target is the active (compositing, live-streaming)
   * target of its own window. Meaning changed from per-instance to
   * per-window: a target can be `active` at the same time as a target in
   * another window, since each window compositing independently is the
   * whole point of `BrowserSpec.isolation: 'window'`.
   */
  active: boolean;
  audible: boolean;
  muted: boolean;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  openerTargetId: string | null;
  viewers: number;
  createdAt: number;
}

/** C to S: list targets, optionally filtered by kind. */
export interface TargetList extends Envelope {
  t: 'target.list';
  includeKinds?: TargetKind[];
}

/** S to C: reply to `target.list`. */
export interface TargetListed extends Envelope {
  t: 'target.listed';
  targets: TargetSummary[];
}

/** S to C: a new Target appeared. */
export interface TargetCreated extends Envelope {
  t: 'target.created';
  target: TargetSummary;
}

/** S to C: an existing Target changed. Carries a delta, not a full record. */
export interface TargetUpdated extends Envelope {
  t: 'target.updated';
  targetId: string;
  changed: Partial<TargetSummary>;
}

/** S to C: a Target closed. */
export interface TargetClosed extends Envelope {
  t: 'target.closed';
  targetId: string;
  reason: 'user' | 'page' | 'crash' | 'server';
}

/** C to S: bring a Target to the front. */
export interface TargetActivate extends Envelope {
  t: 'target.activate';
  targetId: string;
}

/**
 * C to S: open a new tab. The one non-idempotent operation in this group;
 * resending creates a second tab. Clients MUST NOT retry after a timeout
 * without first calling `target.list`.
 */
export interface TargetNew extends Envelope {
  t: 'target.new';
  url?: string;
  background?: boolean;
  openerTargetId?: string;
  /** Open this target in its own new OS window, rather than a tab of an existing one. */
  newWindow?: boolean;
}

/** C to S: close a Target. */
export interface TargetClose extends Envelope {
  t: 'target.close';
  targetId: string;
}

/** C to S: reorder Targets. Wired: handled in ws/connection.ts, which broadcasts the new order. Fire and forget, no reply. */
export interface TargetReorder extends Envelope {
  t: 'target.reorder';
  targetIds: string[];
}
