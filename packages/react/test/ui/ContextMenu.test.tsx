import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ContextMenu } from '../../src/ui/ContextMenu.js';

/**
 * A view-only token renders a context menu with no items as nothing, not
 * an empty box.
 */
describe('<ContextMenu/>', () => {
  it('renders nothing for a view-only grant set with no probe hit', () => {
    const { container } = render(
      <ContextMenu
        open
        x={10}
        y={10}
        granted={new Set(['view'])}
        hasControl={false}
        probe={null}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders nothing for a view-only grant set even once the probe lands with a hit but no link', () => {
    const { container } = render(
      <ContextMenu
        open
        x={10}
        y={10}
        granted={new Set(['view'])}
        hasControl={false}
        probe={{ targetId: 'tgt_1', detail: 'hover', gen: 1, hit: true }}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('renders the built-in Copy item once clipboard.read is granted', () => {
    const { getByText } = render(
      <ContextMenu
        open
        x={10}
        y={10}
        granted={new Set(['view', 'clipboard.read'])}
        hasControl={false}
        probe={null}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(getByText('Copy')).toBeTruthy();
  });

  it('renders nothing when closed, regardless of grants', () => {
    const { container } = render(
      <ContextMenu
        open={false}
        x={10}
        y={10}
        granted={new Set(['view', 'clipboard.read', 'capture', 'tabs.manage'])}
        hasControl={false}
        probe={null}
        onAction={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(container.innerHTML).toBe('');
  });
});
