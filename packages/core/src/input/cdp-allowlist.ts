/**
 * The CDP method allowlist input dispatch is restricted to: every command this package's input module
 * sends to Chrome passes through {@link sendInputCommand}, which throws for
 * anything not in {@link ALLOWED_INPUT_METHODS} and, for
 * `Input.dispatchKeyEvent` specifically, refuses params lacking
 * `key-events.ts`'s hardened brand.
 *
 * This is the input channel's remote-code-execution boundary:
 * the only CDP surface reachable from a viewer's input messages is this
 * closed set of `Input.*` methods, with every params object built field by
 * field from validated values. No caller anywhere in this module spreads a
 * client-supplied object (`{...msg}`) into a CDP params object; that pattern
 * is banned by lint and by this rule.
 */

import type { CdpSessionId } from '../cdp/types.js';
import { isHardenedKeyEvent } from './key-events.js';

/** The seven `Input.*` methods input dispatch may call. Anything else throws. */
export const ALLOWED_INPUT_METHODS = Object.freeze([
  'Input.dispatchMouseEvent',
  'Input.dispatchKeyEvent',
  'Input.dispatchTouchEvent',
  'Input.dispatchDragEvent',
  'Input.insertText',
  'Input.imeSetComposition',
  'Input.setIgnoreInputEvents',
] as const);

/** One of {@link ALLOWED_INPUT_METHODS}. */
export type AllowedInputMethod = (typeof ALLOWED_INPUT_METHODS)[number];

const ALLOWED_SET: ReadonlySet<string> = new Set(ALLOWED_INPUT_METHODS);

/** Thrown by {@link sendInputCommand} for a method outside the allowlist, or unbranded `Input.dispatchKeyEvent` params. */
export class InputCdpAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputCdpAllowlistError';
  }
}

/** Whether `method` is one of {@link ALLOWED_INPUT_METHODS}. */
export function isAllowedInputMethod(method: string): method is AllowedInputMethod {
  return ALLOWED_SET.has(method);
}

/** The minimal `CdpBridge` surface {@link sendInputCommand} needs, to keep this module's coupling to `../cdp/**` narrow. */
export interface InputCdpSender {
  send(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: CdpSessionId,
  ): Promise<unknown>;
}

/**
 * Sends one CDP `Input.*` command through the allowlist. Throws
 * {@link InputCdpAllowlistError} synchronously (before touching the bridge)
 * for a method not in {@link ALLOWED_INPUT_METHODS}, or for
 * `Input.dispatchKeyEvent` params that were not produced by
 * `key-events.ts`'s `buildKeyEvent`/`hardenKeyEvent` (checked via the
 * hardened brand, never by shape inspection).
 */
export function sendInputCommand(
  bridge: InputCdpSender,
  method: string,
  params: Record<string, unknown>,
  sessionId: CdpSessionId,
): Promise<unknown> {
  if (!isAllowedInputMethod(method)) {
    throw new InputCdpAllowlistError(`CDP method not on the input allowlist: ${method}`);
  }
  if (method === 'Input.dispatchKeyEvent' && !isHardenedKeyEvent(params)) {
    throw new InputCdpAllowlistError(
      'Input.dispatchKeyEvent params must be produced by buildKeyEvent or hardenKeyEvent (missing the hardened brand)',
    );
  }
  return bridge.send(method, params, sessionId);
}
