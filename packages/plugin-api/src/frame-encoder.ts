/**
 * The `frame-encoder` extension point: a file to file transform over frames
 * a recording has already written to disk, with no live target and no
 * session in the picture: neither reference plugin needs a browser.
 *
 * What is absent from {@link EncodeRequest} is the point, and it is the
 * same point `packages/protocol/src/domain/arg-lists.ts` makes for launch
 * arguments: no codec string, no container name, no bitrate, no filter
 * graph, and above all no options passthrough. An `encoderArgs: string[]`
 * field would turn `bgls record export` into a shell for whoever can type
 * a `bgls` invocation, which is `ARG_DENY`'s failure mode reproduced in
 * our own CLI. The plugin chooses its own encoder settings; the caller
 * chooses a path and a frame rate.
 */
import type { PluginManifest } from './manifest.js';

/** One exported frame, exactly the record `runRecordExport` already writes into `manifest.json`. */
export interface EncoderFrame {
  readonly frameIndex: number;
  /** File name within {@link EncodeRequest.inputDir}. Never a path. */
  readonly file: string;
  /**
   * Milliseconds since the base of THIS frame's {@link sidEpoch}, not since
   * the recording started. The base resets when the epoch does, so this
   * value is only comparable between two frames that share a `sidEpoch`.
   */
  readonly tsDeltaMs: number;
  /**
   * The stream reconfiguration epoch this frame was captured under.
   *
   * Carried because without it `tsDeltaMs` is unusable across a boundary.
   * `packages/core/src/recording/types.ts` records `gen` and `sidEpoch`
   * separately, deliberately, because a `sidEpoch` bump alone (a resize, a
   * quality change, a resume) is meaningful on its own. Such a bump resets
   * the `tsDeltaMs` base WITHOUT restarting {@link frameIndex}, so an
   * encoder deriving per frame duration from consecutive deltas sees one
   * non-positive delta and, with no epoch to compare, cannot tell a reset
   * from a clock anomaly.
   *
   * The reference plugin found this by hitting it. It degraded to a
   * default duration for that one frame, which is the right behaviour and
   * is still a guess. Comparing `sidEpoch` turns the guess into a fact.
   */
  readonly sidEpoch: number;
  readonly byteLength: number;
}

/** Everything a `frame-encoder` plugin is handed. Nothing else. */
export interface EncodeRequest {
  /** Absolute. Contains exactly the files named in {@link EncodeRequest.frames}. */
  readonly inputDir: string;
  readonly frames: readonly EncoderFrame[];
  /** Absolute. The host has already created the parent directory. */
  readonly outPath: string;
  /** Frames per second. Absent means the plugin derives one from `tsDeltaMs`. */
  readonly fps?: number;
}

/** Two words, for the same reason `RequestVerdict` (`packages/core/src/interception/request-gate.ts`) has two. */
export type EncodeOutcome = 'encoded' | 'unsupported';

export interface EncodeResult {
  readonly outcome: EncodeOutcome;
  /** Printed to the human. Never executed, never parsed. */
  readonly detail: string;
  /** 0 unless `outcome` is `'encoded'`. The host stats the output file itself and does not trust this. */
  readonly bytesWritten: number;
}

/** A plugin that turns exported frames into a video file. */
export interface FrameEncoderPlugin extends PluginManifest {
  readonly kind: 'frame-encoder';
  encode(req: EncodeRequest, signal: AbortSignal): Promise<EncodeResult>;
}
