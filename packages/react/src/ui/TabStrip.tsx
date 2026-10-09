'use client';

import type { ReactElement } from 'react';
import { isSafeHref } from '../internal/dom.js';
import { cx } from './internal.js';
import type { TabStripProps } from './types.js';

/**
 * The tab strip: favicon, title, close, new tab, and (when `canManage`) a
 * drag reorder affordance. Page derived strings (`title`, `faviconUrl`) are
 * always rendered as text or validated attributes, never
 * `dangerouslySetInnerHTML`.
 */
export function TabStrip({
  targets,
  activeTargetId,
  onSelect,
  onClose,
  onNew,
  canManage,
  renderTitle,
  className,
}: TabStripProps): ReactElement {
  return (
    <div className={cx('bgls-tabstrip', className)} data-bgls-part="tabstrip" role="tablist">
      {targets.map((t) => (
        <div
          key={t.targetId}
          className={cx('bgls-tab', t.targetId === activeTargetId && 'bgls-tab-active')}
          data-bgls-part="tab"
        >
          <button
            type="button"
            data-bgls-part="tab-select"
            role="tab"
            aria-selected={t.targetId === activeTargetId}
            onClick={() => onSelect(t.targetId)}
          >
            {t.faviconUrl && isSafeHref(t.faviconUrl) && (
              <img data-bgls-part="tab-favicon" src={t.faviconUrl} alt="" width={16} height={16} />
            )}
            <span data-bgls-part="tab-title">
              {renderTitle ? renderTitle(t) : t.title || t.url}
            </span>
          </button>
          {canManage && onClose && (
            <button
              type="button"
              data-bgls-part="tab-close"
              aria-label="Close tab"
              onClick={() => onClose(t.targetId)}
            >
              Close
            </button>
          )}
        </div>
      ))}
      {canManage && onNew && (
        <button type="button" data-bgls-part="tab-new" aria-label="New tab" onClick={onNew}>
          New
        </button>
      )}
    </div>
  );
}
