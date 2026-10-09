'use client';

import type { FormEvent, ReactElement } from 'react';
import { useState } from 'react';
import { cx } from './internal.js';
import type { DialogPromptProps } from './types.js';

/**
 * Built-in default for `dialog.opened`: an unanswered `confirm()`/`alert()`
 * freezes the remote page's screencast, so this renders whenever the app
 * has not supplied its own `onDialog` handler. `message`/`defaultPrompt`
 * are page controlled and always rendered as text.
 */
export function DialogPrompt({ dialog, onAnswer, className }: DialogPromptProps): ReactElement {
  const [text, setText] = useState(dialog.defaultPrompt ?? '');

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    onAnswer(true, dialog.kind === 'prompt' ? text : undefined);
  };

  return (
    <div
      className={cx('bgls-dialogprompt', className)}
      data-bgls-part="dialogprompt"
      role="alertdialog"
    >
      <form onSubmit={submit}>
        <p data-bgls-part="dialogprompt-message">{dialog.message}</p>
        {dialog.kind === 'prompt' && (
          <input
            data-bgls-part="dialogprompt-input"
            type="text"
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        )}
        <button type="submit" data-bgls-part="dialogprompt-accept">
          {dialog.kind === 'alert' ? 'OK' : 'Accept'}
        </button>
        {dialog.kind !== 'alert' && (
          <button
            type="button"
            data-bgls-part="dialogprompt-cancel"
            onClick={() => onAnswer(false)}
          >
            Cancel
          </button>
        )}
      </form>
    </div>
  );
}
