'use client';

import type { ReactElement } from 'react';
import { isSafeHref } from '../internal/dom.js';
import { cx } from './internal.js';
import type { ContextMenuItem, ContextMenuProps } from './types.js';

/**
 * The built-in item set, computed from `granted`/`hasControl`/`probe`
 * alone (the "missing capability means fewer items, not greyed out ones"
 * rule): a `view`-only token with
 * no link under the pointer produces an empty list.
 */
function builtInItems(
  granted: ReadonlySet<string>,
  hasControl: boolean,
  probe: ContextMenuProps['probe'],
): ContextMenuItem[] {
  const items: ContextMenuItem[] = [];
  const href = probe?.hit ? probe.href : undefined;
  if (href && isSafeHref(href)) {
    if (granted.has('tabs.manage')) items.push({ id: 'open-link', label: 'Open link in new tab' });
    items.push({ id: 'copy-link', label: 'Copy link address' });
  }
  if (granted.has('clipboard.read')) items.push({ id: 'copy', label: 'Copy' });
  if (granted.has('clipboard.write') && hasControl) items.push({ id: 'paste', label: 'Paste' });
  if (granted.has('capture')) items.push({ id: 'screenshot', label: 'Save screenshot' });
  return items;
}

/**
 * The right-click menu. Opens immediately with whatever needs no probe
 * (here: nothing does, so a probe still in flight simply produces an
 * empty list until it lands); link items appear once `probe` fills in. A
 * `view`-only token (or any grant set producing zero items, with no app
 * `items` supplied either) renders nothing at all, not an empty box. `href`s are re-validated client-side against
 * `http`/`https` and always shown as text, never placed in a live link.
 */
export function ContextMenu({
  open,
  x,
  y,
  granted,
  hasControl,
  probe,
  items: appItems,
  onAction,
  onClose,
  renderItem,
  className,
}: ContextMenuProps): ReactElement | null {
  if (!open) return null;
  const items = [...builtInItems(granted, hasControl, probe), ...(appItems ?? [])];
  if (items.length === 0) return null;

  return (
    <>
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: a full-viewport click catcher for dismissal, not an interactive control. */}
      <div
        data-bgls-part="contextmenu-scrim"
        onClick={onClose}
        style={{ position: 'fixed', inset: 0, zIndex: 1000 }}
      />
      <div
        className={cx('bgls-contextmenu', className)}
        data-bgls-part="contextmenu"
        role="menu"
        style={{ position: 'fixed', left: x, top: y, zIndex: 1001 }}
      >
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-bgls-part="contextmenu-item"
            role="menuitem"
            disabled={item.disabled}
            onClick={() => {
              onAction(item.id);
              onClose();
            }}
          >
            {renderItem ? renderItem(item) : item.label}
          </button>
        ))}
      </div>
    </>
  );
}
