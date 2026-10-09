import type { InputComposition, InputKey, InputMouse, InputText } from '@browserglass/protocol';
import type { FramePoint, FrameSize } from '../render/types.js';

/**
 * The subset of {@link CanvasRenderer} `InputCapture` depends on: the
 * client half of the coordinate transform, and the frame dims/generation
 * every input message stamps. Kept as a narrow interface rather than an
 * import of the concrete class so a test can supply a fake renderer.
 */
export interface InputCoordinateSource {
  toFrame(clientX: number, clientY: number): FramePoint;
  frameSize(): FrameSize;
}

/** One of the input envelope shapes `InputCapture` sends, minus the base fields (`v`, `ts`, `targetId`, `fw`, `fh`, `gen`, `leaseId`) it stamps itself. */
export type SendableInputMessage = InputMouse | InputKey | InputText | InputComposition;

/** Construction options for {@link InputCapture}. */
export interface InputCaptureOptions {
  /** Supplies the coordinate transform and current frame dims/generation. */
  renderer: InputCoordinateSource;
  /** The target this capture instance addresses. Change it with `setTargetId()`. */
  targetId: string;
  /** The current control lease id, stamped on every message. A lease change mints a new id; renewal keeps the same one. */
  leaseId: string;
  /** Sends one input envelope over the wire. `InputCapture` never touches a socket itself. */
  send: (msg: SendableInputMessage) => void;
  /** Disables keyboard and IME capture (pointer and wheel still work) when `false`. Default `true`. */
  keyboard?: boolean;
}

/** A button `InputCapture` believes is currently held down, and its last known frame-space position. Used by the stuck-button defences to synthesise a correctly positioned `up`. */
export interface HeldButton {
  x: number;
  y: number;
}
