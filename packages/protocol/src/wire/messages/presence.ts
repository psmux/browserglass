import type { Envelope } from '../envelope.js';

/**
 * S to C: the full presence roster. Never carries `sub`, `tid`, `aid`, or
 * raw claims, so the roster cannot leak token identity;
 * `displayName`/`avatarUrl` come from the token, so the app
 * decides what is shared at issue time.
 */
export interface PresenceState extends Envelope {
  t: 'presence.state';
  viewers: Array<{
    viewerId: string;
    label: string;
    kind: 'human' | 'agent' | 'service';
    avatarUrl?: string;
    /** Stable per viewer, for cursors and badges. */
    colour: string;
    /** `targetId`s this viewer holds a lease on. */
    controlling: string[];
    /** `targetId`s this viewer is subscribed to. */
    watching: string[];
    idle: boolean;
    joinedAt: number;
  }>;
}

/**
 * Both directions: a viewer's pointer position, relayed to others with
 * `vid` set, never echoed back to the sender.
 */
export interface PresenceCursor extends Envelope {
  t: 'presence.cursor';
  targetId: string;
  /** Frame space. */
  x: number;
  y: number;
  fw: number;
  fh: number;
  action?: 'move' | 'click' | 'type' | 'scroll' | 'drag';
  label?: string;
}

/** Both directions: a viewer's visible viewport rect. Typed only, not wired yet. */
export interface PresenceViewport extends Envelope {
  t: 'presence.viewport';
  targetId: string;
  /** Visible rect, frame space. */
  x: number;
  y: number;
  w: number;
  h: number;
}
