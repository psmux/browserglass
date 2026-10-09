'use client';

import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { ViewerListProps } from './types.js';

/** Avatars/initials, presence colour, driving/idle indicators, plus an optional kick affordance for `admin` tokens. */
export function ViewerList({
  viewers,
  myViewerId,
  onKick,
  canKick,
  compact,
  showDriving = true,
  className,
}: ViewerListProps): ReactElement {
  return (
    <ul
      className={cx('bgls-viewerlist', compact && 'bgls-viewerlist-compact', className)}
      data-bgls-part="viewerlist"
    >
      {viewers.map((v) => (
        <li
          key={v.viewerId}
          data-bgls-part="viewer"
          data-bgls-idle={v.idle}
          data-bgls-driving={v.controlling.length > 0}
        >
          <span data-bgls-part="viewer-avatar" style={{ backgroundColor: v.colour }}>
            {v.label.slice(0, 1).toUpperCase()}
          </span>
          <span data-bgls-part="viewer-label">
            {v.label}
            {v.viewerId === myViewerId ? ' (you)' : ''}
          </span>
          {/*
           * A marker, not a count. The list answers "who is in the room and
           * which of them can change what I am looking at"; which specific
           * tabs a given person is driving belongs on the tabs themselves,
           * where the answer is next to the thing it is about. The tooltip
           * carries the number for anyone who wants it.
           */}
          {showDriving && v.controlling.length > 0 && (
            <span
              data-bgls-part="viewer-driving"
              title={`Driving ${v.controlling.length} tab${v.controlling.length === 1 ? '' : 's'}`}
              aria-label={`${v.label} is driving ${v.controlling.length} tab${v.controlling.length === 1 ? '' : 's'}`}
            />
          )}
          {canKick && onKick && v.viewerId !== myViewerId && (
            <button
              type="button"
              data-bgls-part="viewer-kick"
              aria-label={`Remove ${v.label}`}
              onClick={() => onKick(v.viewerId)}
            >
              Remove
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
