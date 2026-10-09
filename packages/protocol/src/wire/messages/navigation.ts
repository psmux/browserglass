import type { Envelope } from '../envelope.js';

/** C to S: navigate a Target's main frame to `url`. */
export interface NavGoto extends Envelope {
  t: 'nav.goto';
  targetId: string;
  url: string;
  referrer?: string;
  waitUntil?: 'commit' | 'load' | 'networkidle';
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
