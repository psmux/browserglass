import { describe, expect, it } from 'vitest';
import { THUMB_CRISIS, THUMB_DEMOTE, THUMB_IDLE } from '../../src/stream/thumbnail.js';

describe('ThumbnailSpec presets', () => {
  it('THUMB_IDLE: 2000ms, 320x240, quality 45, maxBacklog 1', () => {
    expect(THUMB_IDLE).toEqual({
      intervalMs: 2000,
      maxWidth: 320,
      maxHeight: 240,
      quality: 45,
      maxBacklog: 1,
    });
  });

  it('THUMB_DEMOTE: 1000ms, 480x360, quality 45, maxBacklog 1', () => {
    expect(THUMB_DEMOTE).toEqual({
      intervalMs: 1000,
      maxWidth: 480,
      maxHeight: 360,
      quality: 45,
      maxBacklog: 1,
    });
  });

  it('THUMB_CRISIS: 4000ms, 320x240, quality 40, maxBacklog 1', () => {
    expect(THUMB_CRISIS).toEqual({
      intervalMs: 4000,
      maxWidth: 320,
      maxHeight: 240,
      quality: 40,
      maxBacklog: 1,
    });
  });

  it('every preset never queues more than one stale thumbnail', () => {
    for (const preset of [THUMB_IDLE, THUMB_DEMOTE, THUMB_CRISIS]) {
      expect(preset.maxBacklog).toBe(1);
    }
  });
});
