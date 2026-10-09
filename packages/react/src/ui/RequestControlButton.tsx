'use client';

import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { RequestControlButtonProps } from './types.js';

/** Three states in one control: "Take control" (free), "Request control" leading to "Waiting, N in queue" (held by someone else), "Release" (held by this viewer). In a shared lease there is no queue and no waiting state: the grant is immediate. Disabled with a tooltip when the token lacks `control`. */
export function RequestControlButton({
  lease,
  myViewerId,
  canRequest,
  requesting,
  onRequest,
  onRelease,
  reason,
  iAmDriving,
  mode,
  className,
}: RequestControlButtonProps): ReactElement {
  const holderViewerId = lease?.holderViewerId ?? null;
  // `mode` omitted falls back to the lease's own mode, and a lease that
  // does not exist yet is treated as exclusive: that is the SDK default,
  // and promising an immediate grant that then queues would be the worse
  // way to be wrong.
  const effectiveMode = mode ?? lease?.mode ?? 'exclusive';
  const shared = effectiveMode === 'shared';
  const driving = iAmDriving ?? (holderViewerId !== null && holderViewerId === myViewerId);
  const myQueueIndex = lease?.queue.findIndex((q) => q.viewerId === myViewerId) ?? -1;
  const myQueuePosition = myQueueIndex >= 0 ? myQueueIndex + 1 : null;

  if (!canRequest) {
    return (
      <button
        type="button"
        className={cx('bgls-requestcontrol', className)}
        data-bgls-part="requestcontrol"
        data-bgls-mode={effectiveMode}
        disabled
        title="This viewer cannot request control"
      >
        Take control
      </button>
    );
  }

  if (driving) {
    return (
      <button
        type="button"
        className={cx('bgls-requestcontrol', className)}
        data-bgls-part="requestcontrol"
        data-bgls-mode={effectiveMode}
        data-bgls-state="driving"
        onClick={onRelease}
        title={
          shared
            ? 'Stop driving. Everyone else driving this tab keeps their control.'
            : 'Give up control. The next viewer in the queue gets it.'
        }
      >
        {shared ? 'Stop controlling' : 'Release control'}
      </button>
    );
  }

  // The queue is an exclusive-mode concept. Nobody waits for a shared
  // lease, so a shared target never reaches this branch even when the
  // server still has a stale queue entry from a mode change.
  if (!shared && myQueuePosition !== null) {
    return (
      <button
        type="button"
        className={cx('bgls-requestcontrol', className)}
        data-bgls-part="requestcontrol"
        data-bgls-mode={effectiveMode}
        data-bgls-state="queued"
        disabled
      >
        Waiting, {myQueuePosition} in queue
      </button>
    );
  }

  return (
    <button
      type="button"
      className={cx('bgls-requestcontrol', className)}
      data-bgls-part="requestcontrol"
      data-bgls-mode={effectiveMode}
      data-bgls-state="idle"
      disabled={requesting}
      onClick={() => onRequest(reason)}
      title={
        shared
          ? 'Granted straight away. Whoever is already driving keeps driving.'
          : holderViewerId === null
            ? 'Nobody holds this tab. Control is yours as soon as you ask.'
            : 'Somebody else holds this tab. You will be queued behind them.'
      }
    >
      {shared || holderViewerId === null ? 'Take control' : 'Request control'}
    </button>
  );
}
