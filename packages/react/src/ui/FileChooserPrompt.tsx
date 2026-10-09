'use client';

import type { ChangeEvent, ReactElement } from 'react';
import { cx } from './internal.js';
import type { FileChooserPromptProps } from './types.js';

/**
 * Built-in default for `filechooser.opened`: without it the remote page's
 * `<input type="file">` hangs invisibly, since there is no way for the
 * viewer to see the file picker running inside the streamed browser.
 * `elementDescription` is page controlled and always rendered as text.
 */
export function FileChooserPrompt({
  chooser,
  onChoose,
  onCancel,
  className,
}: FileChooserPromptProps): ReactElement {
  const handleChange = (e: ChangeEvent<HTMLInputElement>): void => {
    if (e.target.files && e.target.files.length > 0) onChoose?.(e.target.files);
  };

  return (
    <div
      className={cx('bgls-filechooserprompt', className)}
      data-bgls-part="filechooserprompt"
      // biome-ignore lint/a11y/useSemanticElements: a native <dialog> needs imperative showModal()/close() calls this declarative render has no lifecycle hook to drive; matches <DialogPrompt/>'s own div-plus-role pattern.
      role="dialog"
    >
      <p data-bgls-part="filechooserprompt-message">
        {chooser.elementDescription || 'Choose a file'}
      </p>
      <input
        data-bgls-part="filechooserprompt-input"
        type="file"
        multiple={chooser.multiple}
        accept={chooser.accept.join(',')}
        onChange={handleChange}
      />
      <button type="button" data-bgls-part="filechooserprompt-cancel" onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
}
