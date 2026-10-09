import type { InputComposition, InputKey, InputMouse, InputText } from '@browserglass/protocol';
import { ClickCounter } from './clickCounter.js';
import { buttonName, modMask } from './modifiers.js';
import type {
  HeldButton,
  InputCaptureOptions,
  InputCoordinateSource,
  SendableInputMessage,
} from './types.js';
import { normalizeWheelDelta } from './wheel.js';

/** A `key` that counts as a single printable character, astral safe (`[...s].length === 1`), matching the convention `@browserglass/core`'s key builder uses. */
function isPrintableKey(key: string): boolean {
  return [...key].length === 1;
}

/**
 * Captures pointer, wheel, keyboard, and IME input on one canvas and turns
 * it into wire `input.*` messages, addressed at one target. Owns none of
 * the transport: every message is handed to the `send` callback supplied
 * at construction, and every method that needs the coordinate transform or
 * current frame generation reads it from the supplied `renderer`.
 *
 * Binds pointer events, not mouse events, so mouse/pen/touch share one code
 * path and `setPointerCapture` correctly handles "press inside the canvas,
 * drag outside it" with no document level listeners. Applies
 * `overscroll-behavior: contain` and `touch-action: none` to the container
 * so the host page cannot rubber-band or claim the first touch move.
 */
export class InputCapture {
  private readonly canvas: HTMLCanvasElement;
  private readonly container: HTMLElement;
  private readonly renderer: InputCoordinateSource;
  private readonly send: (msg: SendableInputMessage) => void;
  private readonly keyboardEnabled: boolean;

  private targetId: string;
  private leaseId: string;

  private readonly clickCounter = new ClickCounter();
  private readonly heldButtons = new Map<string, HeldButton>();

  private pendingMove: {
    clientX: number;
    clientY: number;
    buttons: number;
    modifiers: ModifierSnapshot;
  } | null = null;
  private moveRafId = 0;

  private wheelAccumDx = 0;
  private wheelAccumDy = 0;
  private wheelAccumModifiers = 0;
  private wheelLastClientX = 0;
  private wheelLastClientY = 0;
  private wheelRafId = 0;

  private readonly imeInput: HTMLInputElement;
  private compositionActive = false;

  private destroyed = false;

  constructor(canvas: HTMLCanvasElement, container: HTMLElement, options: InputCaptureOptions) {
    this.canvas = canvas;
    this.container = container;
    this.renderer = options.renderer;
    this.targetId = options.targetId;
    this.leaseId = options.leaseId;
    this.send = options.send;
    this.keyboardEnabled = options.keyboard !== false;

    this.container.style.overscrollBehavior = 'contain';
    this.container.style.touchAction = 'none';
    // The hidden IME input is positioned absolutely against the container,
    // which only works once the container establishes a positioning
    // context; do not override an app-chosen non-static position.
    if (
      typeof getComputedStyle === 'function' &&
      getComputedStyle(this.container).position === 'static'
    ) {
      this.container.style.position = 'relative';
    }

    this.imeInput = createHiddenImeInput();
    this.container.appendChild(this.imeInput);

    this.canvas.addEventListener('pointerdown', this.onPointerDown);
    this.canvas.addEventListener('pointermove', this.onPointerMove);
    this.canvas.addEventListener('pointerup', this.onPointerUp);
    this.canvas.addEventListener('pointercancel', this.onPointerCancelOrLost);
    this.canvas.addEventListener('lostpointercapture', this.onPointerCancelOrLost);
    // Imperative, { passive: false }, never a JSX prop: a passive listener
    // cannot preventDefault(), and React's onWheel is passive since React
    // 17.
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });

    if (this.keyboardEnabled) {
      this.imeInput.addEventListener('keydown', this.onKeyDown);
      this.imeInput.addEventListener('keyup', this.onKeyUp);
      this.imeInput.addEventListener('beforeinput', this.onBeforeInput as EventListener);
      this.imeInput.addEventListener('compositionstart', this.onCompositionStart);
      this.imeInput.addEventListener('compositionupdate', this.onCompositionUpdate);
      this.imeInput.addEventListener('compositionend', this.onCompositionEnd);
      this.imeInput.addEventListener('blur', this.onImeBlur);
    }
  }

  /** Changes the target this capture instance addresses. */
  setTargetId(targetId: string): void {
    this.targetId = targetId;
  }

  /** Updates the control lease id stamped on every message. A fresh grant mints a new id; a renewal keeps the same one and does not need this call. */
  setLeaseId(leaseId: string): void {
    this.leaseId = leaseId;
  }

  /**
   * Stuck-button defence 3 of 3: sends a synthetic `up` for every button
   * currently believed down, at its last known position, with
   * `buttons: 0`. The caller must invoke this on any reconnect and on any
   * `gen` change while a button is held, before anything else: the server
   * drops it harmlessly if the lease is gone, but skipping it costs a
   * wedged remote page.
   */
  releaseStuckButtons(): void {
    this.synthesizeUpsForAllHeld();
  }

  /**
   * IME step 6: cancels an active composition by sending
   * `kind:'end', text:''`, which clears remote composition state. The
   * caller must invoke this on blur, unmount, or any reconnect; it is also
   * wired to the hidden IME input's own `blur` event.
   */
  cancelComposition(): void {
    if (!this.compositionActive) return;
    this.compositionActive = false;
    this.imeInput.value = '';
    this.send({ ...this.baseFields(), t: 'input.composition', kind: 'end', text: '' });
  }

  /** Removes every listener and the hidden IME input. Idempotent. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    if (this.moveRafId) cancelAnimationFrame(this.moveRafId);
    if (this.wheelRafId) cancelAnimationFrame(this.wheelRafId);
    this.canvas.removeEventListener('pointerdown', this.onPointerDown);
    this.canvas.removeEventListener('pointermove', this.onPointerMove);
    this.canvas.removeEventListener('pointerup', this.onPointerUp);
    this.canvas.removeEventListener('pointercancel', this.onPointerCancelOrLost);
    this.canvas.removeEventListener('lostpointercapture', this.onPointerCancelOrLost);
    this.canvas.removeEventListener('wheel', this.onWheel);
    this.imeInput.removeEventListener('keydown', this.onKeyDown);
    this.imeInput.removeEventListener('keyup', this.onKeyUp);
    this.imeInput.removeEventListener('beforeinput', this.onBeforeInput as EventListener);
    this.imeInput.removeEventListener('compositionstart', this.onCompositionStart);
    this.imeInput.removeEventListener('compositionupdate', this.onCompositionUpdate);
    this.imeInput.removeEventListener('compositionend', this.onCompositionEnd);
    this.imeInput.removeEventListener('blur', this.onImeBlur);
    this.imeInput.remove();
  }

  private baseFields(): {
    v: 1;
    ts: number;
    targetId: string;
    fw: number;
    fh: number;
    gen: number;
    leaseId: string;
  } {
    const { fw, fh, gen } = this.renderer.frameSize();
    return { v: 1, ts: Date.now(), targetId: this.targetId, fw, fh, gen, leaseId: this.leaseId };
  }

  private positionImeInput(clientX: number, clientY: number): void {
    const box = this.container.getBoundingClientRect();
    this.imeInput.style.left = `${clientX - box.left}px`;
    this.imeInput.style.top = `${clientY - box.top}px`;
  }

  private synthesizeUpsForAllHeld(): void {
    if (this.heldButtons.size === 0) return;
    const base = this.baseFields();
    for (const [button, pos] of this.heldButtons) {
      const msg: InputMouse = {
        ...base,
        t: 'input.mouse',
        kind: 'up',
        x: pos.x,
        y: pos.y,
        button: button as NonNullable<InputMouse['button']>,
        buttons: 0,
        modifiers: 0,
      };
      this.send(msg);
    }
    this.heldButtons.clear();
  }

  private readonly onPointerDown = (e: PointerEvent): void => {
    this.canvas.setPointerCapture(e.pointerId);
    this.positionImeInput(e.clientX, e.clientY);
    if (this.keyboardEnabled) {
      // Keyboard input only reaches the remote page through the hidden IME
      // input, so it has to still hold focus once this event finishes.
      // A pointerdown's default action moves focus to the nearest focusable
      // element under the cursor, and `<BrowserGlass/>` gives its container
      // `tabIndex={0}` so the component can be tabbed to. That container
      // therefore won the focus back immediately after the `focus()` call
      // below, on every single click, and every keystroke went to a div with
      // no listeners on it: clicking a pane worked, typing into it did
      // nothing at all. Preventing the default focus change is what makes
      // the line below stick.
      e.preventDefault();
      this.imeInput.focus({ preventScroll: true });
    }
    const p = this.renderer.toFrame(e.clientX, e.clientY);
    if (!p.inside) return;
    const button = buttonName(e.button);
    const clickCount = this.clickCounter.next(e.clientX, e.clientY, e.button, performance.now());
    this.heldButtons.set(button, { x: p.x, y: p.y });
    const msg: InputMouse = {
      ...this.baseFields(),
      t: 'input.mouse',
      kind: 'down',
      x: p.x,
      y: p.y,
      button,
      buttons: e.buttons,
      modifiers: modMask(e),
      clickCount,
    };
    this.send(msg);
  };

  private readonly onPointerMove = (e: PointerEvent): void => {
    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    const last = events.length > 0 ? events[events.length - 1]! : e;

    if (this.heldButtons.size > 0) {
      const p = this.renderer.toFrame(last.clientX, last.clientY);
      for (const button of this.heldButtons.keys())
        this.heldButtons.set(button, { x: p.x, y: p.y });
    }

    this.pendingMove = {
      clientX: last.clientX,
      clientY: last.clientY,
      buttons: last.buttons,
      modifiers: modMask(last),
    };
    if (this.moveRafId) return;
    this.moveRafId = requestAnimationFrame(() => {
      this.moveRafId = 0;
      const mv = this.pendingMove;
      this.pendingMove = null;
      if (!mv) return;
      const p = this.renderer.toFrame(mv.clientX, mv.clientY);
      const dragging = this.heldButtons.size > 0;
      // No button held: stop sending once the pointer leaves the drawn
      // rect. Button held: keep sending, unclamped, so the server sees the
      // pointer pinned to the edge for drag-past-edge behaviour.
      if (!p.inside && !dragging) return;
      const msg: InputMouse = {
        ...this.baseFields(),
        t: 'input.mouse',
        kind: 'move',
        x: p.x,
        y: p.y,
        button: 'none',
        buttons: mv.buttons,
        modifiers: mv.modifiers,
      };
      this.send(msg);
    });
  };

  private readonly onPointerUp = (e: PointerEvent): void => {
    const button = buttonName(e.button);
    const held = this.heldButtons.get(button);
    const p = held ?? this.renderer.toFrame(e.clientX, e.clientY);
    this.heldButtons.delete(button);
    const msg: InputMouse = {
      ...this.baseFields(),
      t: 'input.mouse',
      kind: 'up',
      x: p.x,
      y: p.y,
      button,
      buttons: e.buttons,
      modifiers: modMask(e),
    };
    this.send(msg);
  };

  private readonly onPointerCancelOrLost = (): void => {
    // Stuck-button defence 2 of 3: pointercancel and lostpointercapture
    // both synthesise an up at the last known position.
    this.synthesizeUpsForAllHeld();
  };

  private readonly onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    const [dx, dy] = normalizeWheelDelta(e.deltaX, e.deltaY, e.deltaMode, this.canvas.height);
    this.wheelAccumDx += dx;
    this.wheelAccumDy += dy;
    this.wheelAccumModifiers = modMask(e);
    this.wheelLastClientX = e.clientX;
    this.wheelLastClientY = e.clientY;
    if (this.wheelRafId) return;
    this.wheelRafId = requestAnimationFrame(() => {
      this.wheelRafId = 0;
      const totalDx = this.wheelAccumDx;
      const totalDy = this.wheelAccumDy;
      this.wheelAccumDx = 0;
      this.wheelAccumDy = 0;
      const p = this.renderer.toFrame(this.wheelLastClientX, this.wheelLastClientY);
      if (!p.inside) return;
      const msg: InputMouse = {
        ...this.baseFields(),
        t: 'input.mouse',
        kind: 'wheel',
        x: p.x,
        y: p.y,
        button: 'none',
        buttons: 0,
        modifiers: this.wheelAccumModifiers,
        dx: totalDx,
        dy: totalDy,
      };
      this.send(msg);
    });
  };

  private readonly onKeyDown = (e: KeyboardEvent): void => {
    // IME step 2: while a composition is active, key events belong to the
    // IME and must not be forwarded at all.
    if (this.compositionActive) return;
    e.preventDefault();
    const msg: InputKey = {
      ...this.baseFields(),
      t: 'input.key',
      kind: 'down',
      key: e.key,
      code: e.code,
      modifiers: modMask(e),
      repeat: e.repeat,
      location: e.location as 0 | 1 | 2 | 3,
      ...(isPrintableKey(e.key) ? { text: e.key } : {}),
    };
    this.send(msg);
  };

  private readonly onKeyUp = (e: KeyboardEvent): void => {
    if (this.compositionActive) return;
    e.preventDefault();
    const msg: InputKey = {
      ...this.baseFields(),
      t: 'input.key',
      kind: 'up',
      key: e.key,
      code: e.code,
      modifiers: modMask(e),
      location: e.location as 0 | 1 | 2 | 3,
    };
    this.send(msg);
  };

  private readonly onBeforeInput = (e: InputEvent): void => {
    if (this.compositionActive) return;
    if (e.inputType === 'insertText' && e.data) {
      // IME step 5: autocorrect, swipe typing, dictation, and paste/bulk
      // insert with no active composition go through input.text.
      e.preventDefault();
      this.imeInput.value = '';
      const msg: InputText = { ...this.baseFields(), t: 'input.text', text: e.data };
      this.send(msg);
    } else if (e.inputType === 'deleteContentBackward') {
      e.preventDefault();
      this.imeInput.value = '';
      const base = this.baseFields();
      this.send({
        ...base,
        t: 'input.key',
        kind: 'down',
        key: 'Backspace',
        code: 'Backspace',
        modifiers: 0,
      } as InputKey);
      this.send({
        ...base,
        t: 'input.key',
        kind: 'up',
        key: 'Backspace',
        code: 'Backspace',
        modifiers: 0,
      } as InputKey);
    }
  };

  private readonly onCompositionStart = (e: CompositionEvent): void => {
    this.compositionActive = true;
    const msg: InputComposition = {
      ...this.baseFields(),
      t: 'input.composition',
      kind: 'start',
      text: e.data ?? '',
    };
    this.send(msg);
  };

  private readonly onCompositionUpdate = (e: CompositionEvent): void => {
    const msg: InputComposition = {
      ...this.baseFields(),
      t: 'input.composition',
      kind: 'update',
      text: e.data ?? '',
      ...(this.imeInput.selectionStart !== null
        ? { selectionStart: this.imeInput.selectionStart }
        : {}),
      ...(this.imeInput.selectionEnd !== null ? { selectionEnd: this.imeInput.selectionEnd } : {}),
    };
    this.send(msg);
  };

  private readonly onCompositionEnd = (e: CompositionEvent): void => {
    this.compositionActive = false;
    this.imeInput.value = '';
    const msg: InputComposition = {
      ...this.baseFields(),
      t: 'input.composition',
      kind: 'end',
      text: e.data ?? '',
    };
    this.send(msg);
  };

  private readonly onImeBlur = (): void => {
    this.cancelComposition();
  };
}

/** A CDP-order modifier bitmask, already packed. */
type ModifierSnapshot = number;

/** Builds the 1x1, opacity 0 input element IME composition and non-suppressed keyboard events are routed through. Positioned under the caret's last known client-space location, never at `(0,0)`: mobile IMEs position their candidate window relative to the focused element. */
function createHiddenImeInput(): HTMLInputElement {
  const input = document.createElement('input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-hidden', 'true');
  input.setAttribute('tabindex', '-1');
  Object.assign(input.style, {
    position: 'absolute',
    width: '1px',
    height: '1px',
    opacity: '0',
    border: '0',
    padding: '0',
    margin: '0',
    overflow: 'hidden',
    left: '0px',
    top: '0px',
  });
  return input;
}
