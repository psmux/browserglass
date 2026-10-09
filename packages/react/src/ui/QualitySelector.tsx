'use client';

import type { QualityProfile } from '@browserglass/client';
import type { ReactElement } from 'react';
import { cx } from './internal.js';
import type { QualitySelectorProps } from './types.js';

const LEVELS: Array<{ value: QualityProfile; label: string }> = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
];

/** Auto/Low/Medium/High; shows the level the adaptation controller actually settled on next to the Auto label. */
export function QualitySelector({
  quality,
  adaptedTo,
  onChange,
  showAuto = true,
  className,
}: QualitySelectorProps): ReactElement {
  return (
    <div
      className={cx('bgls-qualityselector', className)}
      data-bgls-part="qualityselector"
      role="radiogroup"
    >
      {showAuto && (
        <button
          type="button"
          data-bgls-part="qualityselector-auto"
          aria-pressed={quality === 'auto'}
          onClick={() => onChange('auto')}
        >
          Auto{quality === 'auto' && adaptedTo ? ` (${adaptedTo})` : ''}
        </button>
      )}
      {LEVELS.map((level) => (
        <button
          key={level.value}
          type="button"
          data-bgls-part="qualityselector-option"
          aria-pressed={quality === level.value}
          onClick={() => onChange(level.value)}
        >
          {level.label}
        </button>
      ))}
    </div>
  );
}
