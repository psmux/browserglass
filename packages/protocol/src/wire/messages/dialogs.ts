import type { Envelope } from '../envelope.js';

/**
 * S to C, broadcast to all viewers: a JS dialog opened, blocking the
 * page's main thread and freezing the screencast for everyone. Only the
 * lease holder may answer.
 *
 * No emission site in packages/server/src yet, even though
 * `dialog.answer` is wired: a viewer can send an answer to a dialog the
 * server never told anyone was open.
 */
export interface DialogOpened extends Envelope {
  t: 'dialog.opened';
  dialogId: string;
  targetId: string;
  kind: 'alert' | 'confirm' | 'prompt' | 'beforeunload';
  /** UNTRUSTED page content. */
  message: string;
  /** UNTRUSTED. */
  defaultPrompt?: string;
  /** Origin that raised the dialog. */
  url: string;
}

/** C to S: the lease holder's answer to an open dialog. */
export interface DialogAnswer extends Envelope {
  t: 'dialog.answer';
  dialogId: string;
  accept: boolean;
  promptText?: string;
}

/**
 * S to C: every viewer that saw `dialog.opened` gets exactly one of these.
 * Same gap as `dialog.opened`: no emission site in packages/server/src
 * yet.
 */
export interface DialogClosed extends Envelope {
  t: 'dialog.closed';
  dialogId: string;
  targetId: string;
  reason: 'answered' | 'auto_dismissed' | 'target_gone';
  /** Set when `reason === 'answered'`. */
  accept?: boolean;
  byViewerId?: string;
  byLabel?: string;
}
