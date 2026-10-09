/**
 * `ThumbnailSpec` and its three named presets. The thumbnail rate shows up
 * in four different, mutually inconsistent places (`THUMBNAIL_PROFILE` at
 * 0.5 fps, slow-consumer stage 1 at "1 fps, 480 px", `hidden:true` at "1 fps", and
 * egress pressure above 85 percent at "1 frame per 4 s"); this file is the
 * one parameterised shape those four collapse into.
 */

import type { ThumbnailSpec } from './types.js';

/**
 * The default tab-strip thumbnail: 0.5 fps, 320x240, quality 45. Captured
 * via `screenshot-poll`, deliberately never a second `Page.startScreencast`
 * (running screencast on N
 * background tabs fights Chrome's own background-tab throttling).
 */
export const THUMB_IDLE: ThumbnailSpec = Object.freeze({
  intervalMs: 2000,
  maxWidth: 320,
  maxHeight: 240,
  quality: 45,
  maxBacklog: 1,
});

/** Slow-consumer stage 1 demotion, and a hidden (backgrounded) tab: 1 fps, 480x360. */
export const THUMB_DEMOTE: ThumbnailSpec = Object.freeze({
  intervalMs: 1000,
  maxWidth: 480,
  maxHeight: 360,
  quality: 45,
  maxBacklog: 1,
});

/** Node egress pressure above 85 percent: every non-controller thumbnail cut to 1 frame per 4 s. */
export const THUMB_CRISIS: ThumbnailSpec = Object.freeze({
  intervalMs: 4000,
  maxWidth: 320,
  maxHeight: 240,
  quality: 40,
  maxBacklog: 1,
});
