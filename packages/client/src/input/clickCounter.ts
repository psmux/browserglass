/** Consecutive-click windows: 500ms and 5 CSS px, the platform convention. */
const CLICK_WINDOW_MS = 500;
const CLICK_DISTANCE_PX = 5;

/**
 * Computes `clickCount` client side: the server cannot reconstruct it
 * across a variable-latency network. Increments while consecutive `down`
 * events on the same button arrive within {@link CLICK_WINDOW_MS} and
 * {@link CLICK_DISTANCE_PX} of the previous one, otherwise resets to 1.
 */
export class ClickCounter {
  private count = 0;
  private lastTimeMs = 0;
  private lastClientX = 0;
  private lastClientY = 0;
  private lastButton = -1;

  /** Records one `pointerdown` and returns its click count. */
  next(clientX: number, clientY: number, button: number, nowMs: number): number {
    const withinTime = nowMs - this.lastTimeMs <= CLICK_WINDOW_MS;
    const withinDistance =
      Math.abs(clientX - this.lastClientX) <= CLICK_DISTANCE_PX &&
      Math.abs(clientY - this.lastClientY) <= CLICK_DISTANCE_PX;
    if (withinTime && withinDistance && button === this.lastButton) {
      this.count += 1;
    } else {
      this.count = 1;
    }
    this.lastTimeMs = nowMs;
    this.lastClientX = clientX;
    this.lastClientY = clientY;
    this.lastButton = button;
    return this.count;
  }

  /** Resets the counter, e.g. on stuck-button recovery so a synthetic sequence does not inflate the next real click's count. */
  reset(): void {
    this.count = 0;
    this.lastTimeMs = 0;
    this.lastButton = -1;
  }
}
