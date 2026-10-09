import type { Envelope } from '../envelope.js';

/** C to S: read the remote browser's clipboard. Typed only, not wired yet: `clipboard.read` already has a capability entry in wire/capability-check.ts, but ws/connection.ts has no dispatch handler for it, so a call fails with bgls.error.protocol.unknown_type. */
export interface ClipboardRead extends Envelope {
  t: 'clipboard.read';
  targetId: string;
  cut?: boolean;
}

/** C to S: write to the remote browser's clipboard. Typed only, not wired yet. */
export interface ClipboardWrite extends Envelope {
  t: 'clipboard.write';
  targetId: string;
  text: string;
  mime?: 'text/plain' | 'text/html';
}

/**
 * S to C, addressed to the requesting Viewer only: a `clipboard.read`
 * reply. Broadcasting this message would be a data leak.
 */
export interface ClipboardData extends Envelope {
  t: 'clipboard.data';
  targetId: string;
  text: string;
  mime: string;
  truncated: boolean;
  re?: string;
}
