import type { LeaseState } from '@browserglass/client';
import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { RequestControlButton } from '../../src/ui/RequestControlButton.js';

function lease(overrides: Partial<LeaseState> = {}): LeaseState {
  return {
    targetId: 'tgt_1',
    holderViewerId: null,
    holderLabel: null,
    grantedAt: null,
    expiresAt: null,
    mode: 'exclusive',
    holders: [],
    holderCount: 0,
    queue: [],
    queueLength: 0,
    queuePosition: null,
    ...overrides,
  };
}

const handlers = { onRequest: vi.fn(), onRelease: vi.fn() };

describe('<RequestControlButton/>', () => {
  describe('exclusive mode, unchanged', () => {
    it('offers to request, not to take, while somebody else holds the lease', () => {
      const { container } = render(
        <RequestControlButton
          lease={lease({ holderViewerId: 'other', holderLabel: 'Sam' })}
          myViewerId="me"
          canRequest
          {...handlers}
        />,
      );
      expect(container.textContent).toBe('Request control');
    });

    it('shows the queue position once queued', () => {
      const { container } = render(
        <RequestControlButton
          lease={lease({
            holderViewerId: 'other',
            holderLabel: 'Sam',
            queue: [
              { viewerId: 'first', label: 'First', requestedAt: 0, priority: 0 },
              { viewerId: 'me', label: 'Me', requestedAt: 0, priority: 0 },
            ],
            queueLength: 2,
          })}
          myViewerId="me"
          canRequest
          {...handlers}
        />,
      );
      expect(container.textContent).toBe('Waiting, 2 in queue');
    });
  });

  describe('shared mode', () => {
    /**
     * The requirement, in the user's own words, is control "immediately if
     * needed", so the button must never promise a wait it will not have.
     * A shared target holds no queue at all; this asserts the UI does not
     * invent one from a leftover queue entry either.
     */
    it('offers to take control outright while somebody else is already driving', () => {
      const { container } = render(
        <RequestControlButton
          lease={lease({ mode: 'shared', holderViewerId: 'other', holderLabel: 'Sam' })}
          myViewerId="me"
          canRequest
          {...handlers}
        />,
      );
      expect(container.textContent).toBe('Take control');
    });

    it('never shows a queue position, even with a stale queue entry on the lease', () => {
      const { container } = render(
        <RequestControlButton
          lease={lease({
            mode: 'shared',
            holderViewerId: 'other',
            queue: [{ viewerId: 'me', label: 'Me', requestedAt: 0, priority: 0 }],
            queueLength: 1,
          })}
          myViewerId="me"
          canRequest
          {...handlers}
        />,
      );
      expect(container.textContent).toBe('Take control');
    });

    /**
     * With N holders, `holderViewerId` names at most one of them, so every
     * other driver would be shown a "Take control" button for control they
     * already have. `iAmDriving` is how the caller (which has the presence
     * roster) settles that.
     */
    it('offers to stop when this viewer drives but is not the named holder', () => {
      const { container } = render(
        <RequestControlButton
          lease={lease({ mode: 'shared', holderViewerId: 'other', holderLabel: 'Sam' })}
          myViewerId="me"
          canRequest
          iAmDriving
          {...handlers}
        />,
      );
      expect(container.textContent).toBe('Stop controlling');
    });

    it('takes its mode from the explicit prop when the lease has not arrived yet', () => {
      const { container } = render(
        <RequestControlButton
          lease={null}
          myViewerId="me"
          canRequest
          mode="shared"
          {...handlers}
        />,
      );
      expect(container.querySelector('button')?.getAttribute('data-bgls-mode')).toBe('shared');
    });
  });

  it('stays disabled for a token without the control capability', () => {
    const { container } = render(
      <RequestControlButton
        lease={lease({ mode: 'shared' })}
        myViewerId="me"
        canRequest={false}
        {...handlers}
      />,
    );
    expect(container.querySelector('button')?.disabled).toBe(true);
  });
});
