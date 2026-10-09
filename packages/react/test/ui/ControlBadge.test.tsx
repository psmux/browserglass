import type { LeaseState } from '@browserglass/client';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ControlBadge } from '../../src/ui/ControlBadge.js';
import type { Driver } from '../../src/usePresence.js';

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

function driver(viewerId: string, isMe = false): Driver {
  return { viewerId, label: viewerId, colour: '#64b5f6', isMe, connected: true, kind: 'human' };
}

function agent(viewerId: string): Driver {
  return {
    viewerId,
    label: viewerId,
    colour: '#c0a3ff',
    isMe: false,
    connected: true,
    kind: 'agent',
  };
}

describe('<ControlBadge/>', () => {
  it('still names the single holder when no drivers list is supplied', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ holderViewerId: 'other', holderLabel: 'Sam' })}
        myViewerId="me"
      />,
    );
    expect(container.textContent).toContain('Sam is driving');
  });

  /**
   * The reason the `drivers` prop exists. With three people on one tab,
   * "You are driving" is true and still leaves out the two other people
   * whose keystrokes are interleaving with this viewer's.
   */
  it('counts every concurrent driver rather than naming one', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ holderViewerId: 'me', holderLabel: 'Me', mode: 'shared' })}
        myViewerId="me"
        drivers={[driver('me', true), driver('a'), driver('b')]}
      />,
    );
    expect(container.textContent).toContain('You and 2 others are driving');
  });

  it('says "1 other", singular, for exactly two drivers', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ mode: 'shared' })}
        myViewerId="me"
        drivers={[driver('me', true), driver('a')]}
      />,
    );
    expect(container.textContent).toContain('You and 1 other are driving');
  });

  it('counts drivers without naming any of them when this viewer is only watching', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ mode: 'shared' })}
        myViewerId="me"
        drivers={[driver('a'), driver('b')]}
      />,
    );
    expect(container.textContent).toContain('2 people are driving');
  });

  it('says nobody is driving for an empty drivers list, even with a stale holder on the lease', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ holderViewerId: 'ghost', holderLabel: 'Ghost' })}
        myViewerId="me"
        drivers={[]}
      />,
    );
    expect(container.textContent).toContain('Nobody is driving');
  });

  it('draws one colour dot per driver, and rings the dot belonging to this viewer', () => {
    const { container } = render(
      <ControlBadge
        lease={lease({ mode: 'shared' })}
        myViewerId="me"
        drivers={[driver('me', true), driver('a'), driver('b')]}
      />,
    );
    const dots = container.querySelectorAll('[data-bgls-part="controlbadge-driver"]');
    expect(dots).toHaveLength(3);
    expect(dots[0]?.getAttribute('data-bgls-is-me')).toBe('true');
    expect(dots[1]?.getAttribute('data-bgls-is-me')).toBeNull();
  });

  /**
   * Counting an agent as a person is not a rounding error. A viewer decides
   * whether to type into a page a colleague is typing into, and decides
   * differently when the other writer is software that will not notice
   * them. So the sentence says which.
   */
  describe('an agent driver is not counted as a person', () => {
    it('names a lone agent as an agent', () => {
      const { container } = render(
        <ControlBadge lease={lease({ mode: 'shared' })} myViewerId="me" drivers={[agent('bot')]} />,
      );
      expect(container.textContent).toContain('bot (agent) is driving');
    });

    it('says "you and 1 agent", not "you and 1 other"', () => {
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[driver('me', true), agent('bot')]}
        />,
      );
      expect(container.textContent).toContain('You and 1 agent are driving');
      expect(container.textContent).not.toContain('other');
    });

    it('splits people from agents when both are present', () => {
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[driver('me', true), driver('a'), agent('bot')]}
        />,
      );
      expect(container.textContent).toContain('You, 1 other and 1 agent are driving');
    });

    it('never reports a negative count when this viewer is itself classified as an agent', () => {
      // Seen for real in the demo: two people share a workspace, both hold
      // tokens carrying the `automation` capability, and the gateway sets
      // `ViewerPresence.kind` from that capability
      // (`connection.ts`: `granted.has('automation') ? 'agent' : 'human'`).
      // Both humans therefore arrive as agents, and the old arithmetic
      // subtracted this viewer from a people-only tally that never counted
      // them, rendering "You, -1 others and 2 agents are driving".
      const meAsAgent: Driver = {
        viewerId: 'me',
        label: 'me',
        colour: '#c0a3ff',
        isMe: true,
        connected: true,
        kind: 'agent',
      };
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[meAsAgent, agent('other')]}
        />,
      );
      expect(container.textContent).not.toContain('-1');
      expect(container.textContent).toContain('You and 1 agent are driving');
    });

    it('never reports a negative count for a mixed room this viewer is an agent in', () => {
      const meAsAgent: Driver = {
        viewerId: 'me',
        label: 'me',
        colour: '#c0a3ff',
        isMe: true,
        connected: true,
        kind: 'agent',
      };
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[meAsAgent, agent('bot'), driver('sam')]}
        />,
      );
      expect(container.textContent).not.toContain('-1');
      expect(container.textContent).toContain('You, 1 other and 1 agent are driving');
    });

    it('counts a room of agents with nobody in it', () => {
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[agent('bot'), agent('bot2')]}
        />,
      );
      expect(container.textContent).toContain('2 agents are driving');
    });

    /**
     * Shape, not colour: the dot's colour is that viewer's presence colour
     * and ties the dot to their cursor on the canvas. The attribute is what
     * the shipped stylesheet squares the corners off.
     */
    it('marks each dot with what is behind it, unknown included', () => {
      const unknown: Driver = {
        viewerId: 'rest',
        label: 'REST',
        colour: '#7d8590',
        isMe: false,
        connected: true,
        kind: 'unknown',
      };
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[driver('a'), agent('bot'), unknown]}
        />,
      );
      const dots = container.querySelectorAll('[data-bgls-part="controlbadge-driver"]');
      expect([...dots].map((d) => d.getAttribute('data-bgls-driver-kind'))).toEqual([
        'human',
        'agent',
        'unknown',
      ]);
    });

    it('leaves the wording for people alone', () => {
      const { container } = render(
        <ControlBadge
          lease={lease({ mode: 'shared' })}
          myViewerId="me"
          drivers={[driver('me', true), driver('a'), driver('b')]}
        />,
      );
      expect(container.textContent).toContain('You and 2 others are driving');
    });
  });

  it('shows the lease mode only when asked, so an app with one mode never sees it', () => {
    const shared = lease({ mode: 'shared' });
    const withMode = render(<ControlBadge lease={shared} myViewerId="me" showMode />);
    expect(
      withMode.container.querySelector('[data-bgls-part="controlbadge-mode"]')?.textContent,
    ).toBe('shared');
    const withoutMode = render(<ControlBadge lease={shared} myViewerId="me" />);
    expect(withoutMode.container.querySelector('[data-bgls-part="controlbadge-mode"]')).toBeNull();
  });
});
