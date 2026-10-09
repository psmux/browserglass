'use client';

import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { StatusBarProps } from './types.js';

/** Truncates `s` in the middle (never the end, so the host stays visible), inserting `...` at the cut point. */
function truncateMiddle(s: string, max: number): string {
  if (s.length <= max) return s;
  const half = Math.floor((max - 3) / 2);
  return `${s.slice(0, half)}...${s.slice(s.length - half)}`;
}

/**
 * The status bar: a 2px load progress line, a security icon, and the
 * current hover link target. Deliberately minimal, not allowed to grow
 * into a toolbar.
 */
export function StatusBar({
  progress,
  loading,
  hoverUrl,
  securityState,
  compact,
  className,
}: StatusBarProps): ReactElement {
  return (
    <div
      className={cx('bgls-statusbar', compact && 'bgls-statusbar-compact', className)}
      data-bgls-part="statusbar"
    >
      <div
        data-bgls-part="statusbar-progress"
        data-bgls-loading={loading}
        style={{
          width: progress !== null ? `${Math.round(progress * 100)}%` : loading ? undefined : '0%',
        }}
      />
      <span data-bgls-part="statusbar-security" data-bgls-security={securityState} />
      {hoverUrl !== undefined && hoverUrl !== null && (
        <span data-bgls-part="statusbar-hover-url">{truncateMiddle(hoverUrl, 80)}</span>
      )}
    </div>
  );
}
