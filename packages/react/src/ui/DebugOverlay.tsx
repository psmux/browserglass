'use client';

import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { DebugOverlayProps } from './types.js';

/** fps (painted, not received), RTT, backlog, dropped frames, codec, quality, decode p50/p95, bytes/sec, and the last close code. Toggled by the app via `Ctrl+Shift+D` when `<BrowserGlass debug>` is on. */
export function DebugOverlay({
  fps,
  rttMs,
  backlog,
  droppedFrames,
  bytesPerSec,
  decodeMsP50,
  decodeMsP95,
  codec,
  quality,
  resumeCount,
  lastCloseCode,
  position = 'top-right',
  expanded = true,
  className,
}: DebugOverlayProps): ReactElement | null {
  if (!expanded) return null;
  return (
    <div
      className={cx('bgls-debugoverlay', `bgls-debugoverlay-${position}`, className)}
      data-bgls-part="debugoverlay"
    >
      <div data-bgls-part="debugoverlay-row">fps: {fps}</div>
      <div data-bgls-part="debugoverlay-row">rtt: {rttMs}ms</div>
      <div data-bgls-part="debugoverlay-row">backlog: {backlog}</div>
      <div data-bgls-part="debugoverlay-row">dropped: {droppedFrames}</div>
      <div data-bgls-part="debugoverlay-row">bytes/s: {Math.round(bytesPerSec)}</div>
      <div data-bgls-part="debugoverlay-row">
        decode p50/p95: {decodeMsP50.toFixed(1)}/{decodeMsP95.toFixed(1)}ms
      </div>
      <div data-bgls-part="debugoverlay-row">codec: {codec ?? 'n/a'}</div>
      <div data-bgls-part="debugoverlay-row">quality: {quality ?? 'n/a'}</div>
      {resumeCount !== undefined && (
        <div data-bgls-part="debugoverlay-row">resumes: {resumeCount}</div>
      )}
      {lastCloseCode !== undefined && lastCloseCode !== null && (
        <div data-bgls-part="debugoverlay-row">last close: {lastCloseCode}</div>
      )}
    </div>
  );
}
