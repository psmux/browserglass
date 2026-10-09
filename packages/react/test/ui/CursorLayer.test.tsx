import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { CursorLayer } from '../../src/ui/CursorLayer.js';
import type { PresenceCursor } from '../../src/usePresence.js';

/**
 * jsdom reports every `getBoundingClientRect()` as zeros, so the layer's
 * origin is (0, 0) here and a cursor lands exactly where `toClient` puts
 * it. That is what makes these position assertions deterministic; the
 * origin subtraction itself is only doing work in a real browser, where
 * the pane is not at the top left of the viewport.
 */
const identityToClient = (x: number, y: number): { clientX: number; clientY: number } => ({
  clientX: x,
  clientY: y,
});

function cursor(overrides: Partial<PresenceCursor> & { viewerId: string }): PresenceCursor {
  return {
    targetId: 'tgt_1',
    x: 10,
    y: 20,
    label: overrides.viewerId,
    colour: '#64b5f6',
    at: Date.now(),
    ...overrides,
  };
}

describe('<CursorLayer/>', () => {
  it('draws one cursor per other viewer on this target', () => {
    const { container } = render(
      <CursorLayer
        cursors={[cursor({ viewerId: 'a' }), cursor({ viewerId: 'b' })]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={identityToClient}
      />,
    );
    expect(container.querySelectorAll('[data-bgls-part="cursor"]')).toHaveLength(2);
  });

  it('ignores cursors belonging to another target', () => {
    const { container } = render(
      <CursorLayer
        cursors={[cursor({ viewerId: 'a', targetId: 'tgt_2' })]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={identityToClient}
      />,
    );
    expect(container.querySelectorAll('[data-bgls-part="cursor"]')).toHaveLength(0);
  });

  /** This viewer already has a real pointer on screen; a second one 40ms behind it is worse than none. */
  it('never draws this viewer their own cursor', () => {
    const { container } = render(
      <CursorLayer
        cursors={[cursor({ viewerId: 'me' })]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={identityToClient}
      />,
    );
    expect(container.querySelectorAll('[data-bgls-part="cursor"]')).toHaveLength(0);
  });

  it('drops a cursor nobody has moved since the stale window, rather than leaving a ghost on the page', () => {
    const { container } = render(
      <CursorLayer
        cursors={[
          cursor({ viewerId: 'fresh' }),
          cursor({ viewerId: 'gone', at: Date.now() - 30_000 }),
        ]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={identityToClient}
        staleAfterMs={8000}
      />,
    );
    const drawn = container.querySelectorAll('[data-bgls-part="cursor-label"]');
    expect(drawn).toHaveLength(1);
    expect(drawn[0]?.textContent).toBe('fresh');
  });

  it('positions a cursor by mapping frame coordinates through the pane renderer', () => {
    const { container } = render(
      <CursorLayer
        cursors={[cursor({ viewerId: 'a', x: 640, y: 400 })]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={(x, y) => ({ clientX: x / 2, clientY: y / 2 })}
      />,
    );
    const el = container.querySelector('[data-bgls-part="cursor"]') as HTMLElement;
    expect(el.style.transform).toBe('translate3d(320px, 200px, 0)');
  });

  /** Whose pointer this is and whether it can change anything are two questions; the arrow answers the second one by being filled or hollow. */
  it('marks a driver differently from a watcher', () => {
    const { container } = render(
      <CursorLayer
        cursors={[cursor({ viewerId: 'driver' }), cursor({ viewerId: 'watcher' })]}
        targetId="tgt_1"
        myViewerId="me"
        toClient={identityToClient}
        drivingViewerIds={['driver']}
      />,
    );
    const all = container.querySelectorAll('[data-bgls-part="cursor"]');
    expect(all[0]?.getAttribute('data-bgls-driving')).toBe('true');
    expect(all[1]?.getAttribute('data-bgls-driving')).toBeNull();
  });
});
