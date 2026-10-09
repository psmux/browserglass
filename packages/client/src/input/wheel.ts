/** `WheelEvent.deltaMode` values this module normalises. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/** CSS px per line, the constant Chrome effectively uses; Firefox reports lines where Chrome reports pixels for the same gesture. */
const PX_PER_LINE = 16;

/**
 * Normalises a wheel event's delta to CSS px, regardless of `deltaMode`:
 * mode `0` (pixel) passes through, mode `1` (line) multiplies by
 * {@link PX_PER_LINE}, mode `2` (page) multiplies by the frame height so a
 * "page" scroll means one frame's worth of remote page.
 */
export function normalizeWheelDelta(
  deltaX: number,
  deltaY: number,
  deltaMode: number,
  frameHeightPx: number,
): [dx: number, dy: number] {
  let scale = 1;
  if (deltaMode === DOM_DELTA_LINE) scale = PX_PER_LINE;
  else if (deltaMode === DOM_DELTA_PAGE) scale = frameHeightPx;
  return [deltaX * scale, deltaY * scale];
}
