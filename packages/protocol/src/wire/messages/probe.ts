import type { Envelope } from '../envelope.js';

/** The depth of detail returned by a hit test. `'hover'` rides on `view`; `'full'` additionally requires `probe`. */
export type ProbeDetail = 'hover' | 'full';

/** C to S: hit-test one point. No `gen` is required on the request; a stale probe is a wasted round trip, not a wrong action. */
export interface TargetProbe extends Envelope {
  t: 'target.probe';
  targetId: string;
  /** Frame space, device px, same basis as `input.*`. */
  x: number;
  y: number;
  /** Frame dims the client measured against. */
  fw: number;
  fh: number;
  /** Default `'hover'`. */
  detail?: ProbeDetail;
}

/** Viewport CSS px, NOT frame space. */
export interface ProbeRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** S to C: the hit-test result, stamped with the generation it was computed against. */
export interface TargetProbed extends Envelope {
  t: 'target.probed';
  targetId: string;
  detail: ProbeDetail;
  gen: number;
  /** False means nothing hit-testable (`'hover'` only). */
  hit: boolean;

  // present on both levels when hit=true
  rect?: ProbeRect;
  /** `'tag#id.class.class'`, UNTRUSTED, capped at 80 bytes. */
  label?: string;
  tagName?: string;
  /** Absolute href of the hit element or nearest ancestor anchor, UNTRUSTED. */
  href?: string | null;
  hrefFromAncestor?: boolean;

  // 'full' only
  /** Computed accessible name, UNTRUSTED, capped at `limits.maxProbeNameBytes`. */
  name?: string;
  role?: string;
  /** Allow-listed keys, UNTRUSTED values. */
  attributes?: Record<string, string>;
  /** Capped at `limits.maxProbeHtmlBytes`, UNTRUSTED. */
  outerHTML?: string;
  outerHTMLTruncated?: boolean;
  /** Outermost first, max 12. */
  ancestors?: Array<{ tagName: string; id?: string; classNames: string[] }>;
  ancestorsTruncated?: boolean;
}
