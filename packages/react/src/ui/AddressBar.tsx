'use client';

import type { ChangeEvent, KeyboardEvent, ReactElement } from 'react';
import { useEffect, useRef, useState } from 'react';
import { cx } from './internal.js';
import type { AddressBarProps } from './types.js';

const BLOCKED_AUTO_DISMISS_MS = 8000;

/**
 * The address bar. Implements the focus/dirty rule exactly: while focused and the
 * field's value differs from the last server sent URL, the field stops
 * tracking `props.url` entirely (incoming values are stored but not
 * rendered), so a page redirecting twice during load never eats a URL the
 * user started typing. Tracking resumes on blur, commit (Enter), or Escape
 * (which reverts to the last server value and blurs).
 */
export function AddressBar({
  url,
  loading,
  canGoBack,
  canGoForward,
  canNavigate,
  securityState,
  onNavigate,
  onBack,
  onForward,
  onReload,
  onStop,
  blocked,
  onDismissBlocked,
  placeholder,
  renderAction,
  className,
}: AddressBarProps): ReactElement {
  const [draft, setDraft] = useState(url);
  const [focused, setFocused] = useState(false);
  const lastServerUrlRef = useRef(url);
  const mouseDownRef = useRef(false);
  const dirty = focused && draft !== lastServerUrlRef.current;

  // biome-ignore lint/correctness/useExhaustiveDependencies: `dirty` is deliberately excluded, this effect must react only to a new server URL arriving, not to `dirty` flipping on its own.
  useEffect(() => {
    lastServerUrlRef.current = url;
    if (!dirty) setDraft(url);
  }, [url]);

  useEffect(() => {
    if (!blocked) return;
    const id = setTimeout(() => onDismissBlocked?.(), BLOCKED_AUTO_DISMISS_MS);
    return () => clearTimeout(id);
  }, [blocked, onDismissBlocked]);

  if (!canNavigate) {
    return (
      <div
        className={cx('bgls-addressbar bgls-addressbar-readonly', className)}
        data-bgls-part="addressbar"
      >
        <span data-bgls-part="addressbar-security" data-bgls-security={securityState} />
        <span data-bgls-part="addressbar-url-text">{url}</span>
      </div>
    );
  }

  const commit = (): void => {
    onDismissBlocked?.();
    onNavigate(draft);
    setFocused(false);
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    onDismissBlocked?.();
    if (e.key === 'Enter') {
      commit();
    } else if (e.key === 'Escape') {
      setDraft(lastServerUrlRef.current);
      e.currentTarget.blur();
    }
  };

  return (
    <div className={cx('bgls-addressbar', className)} data-bgls-part="addressbar">
      {onBack && (
        <button
          type="button"
          data-bgls-part="addressbar-back"
          aria-label="Back"
          disabled={!canGoBack}
          onClick={onBack}
        >
          Back
        </button>
      )}
      {onForward && (
        <button
          type="button"
          data-bgls-part="addressbar-forward"
          aria-label="Forward"
          disabled={!canGoForward}
          onClick={onForward}
        >
          Forward
        </button>
      )}
      {onReload && !loading && (
        <button
          type="button"
          data-bgls-part="addressbar-reload"
          aria-label="Reload"
          onClick={onReload}
        >
          Reload
        </button>
      )}
      {onStop && loading && (
        <button type="button" data-bgls-part="addressbar-stop" aria-label="Stop" onClick={onStop}>
          Stop
        </button>
      )}
      <span data-bgls-part="addressbar-security" data-bgls-security={securityState} />
      <input
        data-bgls-part="addressbar-input"
        type="text"
        value={draft}
        placeholder={placeholder}
        onMouseDown={() => {
          mouseDownRef.current = true;
        }}
        onFocus={(e) => {
          setFocused(true);
          // Select all on focus, the platform convention, except when
          // focus was caused by a click that placed a caret (do not undo
          // that click).
          if (!mouseDownRef.current) e.currentTarget.select();
          mouseDownRef.current = false;
        }}
        onBlur={() => {
          setFocused(false);
          setDraft(lastServerUrlRef.current);
        }}
        onChange={(e: ChangeEvent<HTMLInputElement>) => setDraft(e.target.value)}
        onKeyDown={handleKeyDown}
      />
      {blocked && (
        <div data-bgls-part="addressbar-blocked" role="alert">
          Blocked by policy{blocked.rule ? `: ${blocked.rule}` : ''}
        </div>
      )}
      {renderAction?.()}
    </div>
  );
}
