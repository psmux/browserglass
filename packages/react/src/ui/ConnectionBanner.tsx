'use client';

import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { ConnectionBannerProps } from './types.js';

/**
 * Invisible in `live` and the first `afterAttempt - 1` reconnect attempts;
 * "Reconnecting, attempt N" plus a Retry action from `afterAttempt` on; a
 * fatal panel with the close code, remediation text, and a Copy button.
 * Never shows a raw close code as the primary message, the code is
 * secondary, small print alongside the human readable remediation.
 */
export function ConnectionBanner({
  state,
  attempt,
  error,
  afterAttempt = 3,
  onRetry,
  className,
}: ConnectionBannerProps): ReactElement | null {
  if (state === 'fatal') {
    const remediation =
      error?.error?.remediation ?? error?.message ?? 'The connection could not be established.';
    const details = `${error?.code ?? 'unknown'}: ${error?.message ?? 'Connection failed'}`;
    return (
      <div
        className={cx('bgls-connectionbanner bgls-connectionbanner-fatal', className)}
        data-bgls-part="connectionbanner"
        role="alert"
      >
        <p data-bgls-part="connectionbanner-message">{remediation}</p>
        <button
          type="button"
          data-bgls-part="connectionbanner-copy"
          onClick={() => {
            void navigator.clipboard?.writeText(details);
          }}
        >
          Copy details
        </button>
        <span data-bgls-part="connectionbanner-code">{error?.code}</span>
      </div>
    );
  }

  if (state === 'reconnecting' && attempt >= afterAttempt) {
    return (
      <div
        className={cx('bgls-connectionbanner bgls-connectionbanner-reconnecting', className)}
        data-bgls-part="connectionbanner"
      >
        <span data-bgls-part="connectionbanner-message">Reconnecting, attempt {attempt}</span>
        {onRetry && (
          <button type="button" data-bgls-part="connectionbanner-retry" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }

  return null;
}
