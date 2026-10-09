import type { Envelope } from '../envelope.js';

/** C to S: navigate a Target's main frame to `url`. */
export interface NavGoto extends Envelope {
  t: 'nav.goto';
  targetId: string;
  url: string;
  referrer?: string;
  /**
   * When the correlated `nav.state` reply is sent. Default `'commit'`.
   *
   * * `'commit'`: as soon as the navigation commits. The page is usually
   *   still loading (`loading: true`, often an empty `title`).
   * * `'load'`: after the new document's `load` event, so the reply has the
   *   loaded page's title and `loading: false`. A same-document navigation
   *   (fragment only) answers at once. If `load` has not fired within
   *   `timeoutMs` the reply is sent anyway with `loading: true`.
   * * `'networkidle'`: reserved. The reference gateway refuses it with
   *   `bgls.error.protocol.bad_envelope`.
   */
  waitUntil?: 'commit' | 'load' | 'networkidle';
  /** With `waitUntil: 'load'`: how long the server waits for the `load` event, ms. Default 30000, capped at 120000. A client's own request timeout must be longer than this. */
  timeoutMs?: number;
}

/** C to S: navigate back in history. */
export interface NavBack extends Envelope {
  t: 'nav.back';
  targetId: string;
}

/** C to S: navigate forward in history. */
export interface NavForward extends Envelope {
  t: 'nav.forward';
  targetId: string;
}

/** C to S: reload the current page. */
export interface NavReload extends Envelope {
  t: 'nav.reload';
  targetId: string;
  ignoreCache?: boolean;
}

/** C to S: stop an in-flight navigation. */
export interface NavStop extends Envelope {
  t: 'nav.stop';
  targetId: string;
}

/** S to C: emitted on every main-frame navigation, title change, load-state change, and history-state change; per Target. */
export interface NavState extends Envelope {
  t: 'nav.state';
  targetId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  securityState: 'secure' | 'insecure' | 'neutral' | 'unknown';
  /** Set when navigation failed. */
  errorText?: string;
  httpStatus?: number;
  redirectedFrom?: string;
}
