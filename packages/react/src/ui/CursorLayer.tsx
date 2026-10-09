'use client';

import type { ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { cx } from './internal.js';
import type { CursorLayerProps } from './types.js';

/** How often the layer re-renders purely so that cursors which have gone stale disappear. */
const STALE_SWEEP_MS = 1000;

/**
 * Other viewers' live cursors, drawn over one pane.
 *
 * This is the component that makes several people driving one tab read as
 * collaboration rather than as a haunted browser. Two drivers typing into
 * the same focused input interleave their characters at the CDP level, and
 * nothing in this layer or anywhere else prevents that: it is what "control
 * immediately, no queue" means. What this fixes is the attribution. A
 * pointer moving under someone else's name, in the same colour as their row
 * in the viewer list and the same colour as the dot on the control badge,
 * turns "my typing is going wrong" into "Sam is typing too", which is a
 * thing a person can act on.
 *
 * Rendered through `<BrowserGlass overlay={...}>`, because `toClient` (the
 * pane renderer's frame-to-screen mapping, letterboxing and scale included)
 * exists nowhere else.
 */
export function CursorLayer({
  cursors,
  targetId,
  myViewerId,
  toClient,
  drivingViewerIds,
  staleAfterMs = 8000,
  className,
}: CursorLayerProps): ReactElement {
  const layerRef = useRef<HTMLDivElement | null>(null);
  /**
   * The layer's own top-left in viewport coordinates. `toClient` answers in
   * viewport space (it is built for `clientX`/`clientY` arithmetic), while
   * the markers are positioned inside this layer, so the two have to be
   * reconciled somewhere. Doing it here, once per geometry change, rather
   * than per cursor per frame, keeps a 25Hz stream of positions from
   * forcing a layout read each time one arrives.
   */
  const [origin, setOrigin] = useState<{ left: number; top: number }>({ left: 0, top: 0 });
  const [, setSweep] = useState(0);

  useEffect(() => {
    const el = layerRef.current;
    if (!el) return;
    const measure = (): void => {
      const r = el.getBoundingClientRect();
      setOrigin((prev) =>
        prev.left === r.left && prev.top === r.top ? prev : { left: r.left, top: r.top },
      );
    };
    measure();
    // `true` for capture: a pane can sit inside any scrolling ancestor the
    // application happens to have, and scroll does not bubble.
    window.addEventListener('scroll', measure, true);
    window.addEventListener('resize', measure);
    // jsdom has no ResizeObserver, and this component is rendered in tests.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => measure());
    observer?.observe(el);
    return () => {
      window.removeEventListener('scroll', measure, true);
      window.removeEventListener('resize', measure);
      observer?.disconnect();
    };
  }, []);

  const now = Date.now();
  const visible: Array<{
    key: string;
    left: number;
    top: number;
    label: string;
    colour: string;
    driving: boolean;
  }> = [];
  for (const cursor of cursors) {
    if (cursor.targetId !== targetId) continue;
    if (cursor.viewerId === myViewerId) continue;
    if (now - cursor.at > staleAfterMs) continue;
    const point = toClient(cursor.x, cursor.y);
    visible.push({
      key: cursor.viewerId,
      left: point.clientX - origin.left,
      top: point.clientY - origin.top,
      label: cursor.label || 'Someone',
      colour: cursor.colour || '#7db1ff',
      driving: drivingViewerIds?.includes(cursor.viewerId) ?? false,
    });
  }

  // Staleness is a function of the clock, not of any prop, so without this
  // the last cursor a departing viewer sent would stay on screen until
  // something unrelated re-rendered the pane. Only runs while there is
  // something on screen that could go stale.
  const anyVisible = visible.length > 0;
  useEffect(() => {
    if (!anyVisible) return;
    const id = setInterval(() => setSweep((s) => s + 1), STALE_SWEEP_MS);
    return () => clearInterval(id);
  }, [anyVisible]);

  return (
    <div
      ref={layerRef}
      className={cx('bgls-cursorlayer', className)}
      data-bgls-part="cursorlayer"
      aria-hidden="true"
    >
      {visible.map((c) => (
        <div
          key={c.key}
          data-bgls-part="cursor"
          data-bgls-driving={c.driving || undefined}
          style={{ transform: `translate3d(${c.left}px, ${c.top}px, 0)`, color: c.colour }}
        >
          {/*
           * Drawn rather than a character, because a text pointer inherits
           * the page font and lands at a different size on every machine.
           * Filled for a driver, hollow for a watcher: whose pointer this
           * is and whether it can change anything are two separate
           * questions, and both get answered without a legend.
           */}
          <svg width="14" height="18" viewBox="0 0 14 18" data-bgls-part="cursor-arrow" role="img">
            <title>{c.driving ? `${c.label} is driving` : `${c.label} is watching`}</title>
            <path
              d="M1 1 L1 14 L4.6 10.7 L7 16.4 L9.8 15.2 L7.4 9.7 L12 9.4 Z"
              fill={c.driving ? 'currentColor' : 'none'}
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          <span data-bgls-part="cursor-label" style={{ backgroundColor: c.colour }}>
            {c.label}
          </span>
        </div>
      ))}
    </div>
  );
}
