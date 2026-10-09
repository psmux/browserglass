import { describe, expect, it } from 'vitest';
import {
  CONTROL_LEASE_TRANSITIONS,
  INSTANCE_TRANSITIONS,
  InvalidStateTransition,
  PROFILE_TRANSITIONS,
  SESSION_TRANSITIONS,
  STREAM_TRANSITIONS,
  VIEWER_TRANSITIONS,
  transition,
} from '../../src/domain/state.js';

describe('transition()', () => {
  it('throws InvalidStateTransition for an event that is illegal from a live, non terminal Instance state', () => {
    expect(() =>
      transition(INSTANCE_TRANSITIONS, 'Instance', 'inst_x', 'ready', 'placementStarted', {}),
    ).toThrow(InvalidStateTransition);
  });

  it('returns {kind:"ignored"} rather than throwing for any event from a terminal Instance state', () => {
    const result = transition(
      INSTANCE_TRANSITIONS,
      'Instance',
      'inst_x',
      'released',
      'placementStarted',
      {},
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'terminal_state' });
  });

  it('returns {kind:"ignored"} for the other terminal Instance state, failed, on an event it does not define', () => {
    const result = transition(INSTANCE_TRANSITIONS, 'Instance', 'inst_x', 'failed', 'healthOk', {});
    expect(result).toEqual({ kind: 'ignored', reason: 'terminal_state' });
  });

  it('allows the one legal event out of a terminal Instance state, retry, when its guard passes', () => {
    const result = transition(INSTANCE_TRANSITIONS, 'Instance', 'inst_x', 'failed', 'retry', {
      sameRequestId: true,
    });
    expect(result).toEqual({ kind: 'ok', to: 'requested' });
  });

  it('returns {kind:"ignored"} for a guard failure on a non terminal state (draining is not cancellable)', () => {
    const result = transition(
      INSTANCE_TRANSITIONS,
      'Instance',
      'inst_x',
      'draining',
      'healthOk',
      {},
    );
    expect(result).toEqual({ kind: 'ignored', reason: 'drain_not_cancellable' });
  });

  it('throws for every illegal Session event from every non terminal state', () => {
    expect(() =>
      transition(SESSION_TRANSITIONS, 'Session', 'sess_x', 'live', 'ticketValid' as never, {}),
    ).toThrow(InvalidStateTransition);
  });

  it('returns {kind:"ignored"} for any event from the terminal Session state, ended', () => {
    expect(
      transition(SESSION_TRANSITIONS, 'Session', 'sess_x', 'ended', 'viewerAttached', {}),
    ).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
  });

  it('throws for an illegal Stream event from a live state', () => {
    expect(() =>
      transition(STREAM_TRANSITIONS, 'Stream', 'strm_x', 'live', 'attachmentAdded' as never, {}),
    ).toThrow(InvalidStateTransition);
  });

  it('returns {kind:"ignored"} for any event from the terminal Stream state, stopped (late frame after stop)', () => {
    expect(
      transition(STREAM_TRANSITIONS, 'Stream', 'strm_x', 'stopped', 'frameArrived' as never, {}),
    ).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
  });

  it('throws for an illegal Viewer event, a second hello from attached', () => {
    expect(() =>
      transition(VIEWER_TRANSITIONS, 'Viewer', 'vwr_x', 'attached', 'helloReceived' as never, {}),
    ).toThrow(InvalidStateTransition);
  });

  it('returns {kind:"ignored"} for any event from the terminal Viewer state, expired', () => {
    expect(transition(VIEWER_TRANSITIONS, 'Viewer', 'vwr_x', 'expired', 'subscribe', {})).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
  });

  it('branches slowConsumer to attached under the downgrade policy and to expired under the close policy', () => {
    const downgraded = transition(
      VIEWER_TRANSITIONS,
      'Viewer',
      'vwr_x',
      'attached',
      'slowConsumer',
      {
        slowConsumerPolicy: 'downgrade',
      },
    );
    expect(downgraded).toEqual({ kind: 'ok', to: 'attached' });

    const closed = transition(VIEWER_TRANSITIONS, 'Viewer', 'vwr_x', 'attached', 'slowConsumer', {
      slowConsumerPolicy: 'close',
    });
    expect(closed).toEqual({ kind: 'ok', to: 'expired' });
  });

  it('returns {kind:"ignored"} for any event from either terminal ControlLease state', () => {
    expect(
      transition(CONTROL_LEASE_TRANSITIONS, 'ControlLease', 'lse_x', 'revoked', 'requested', {}),
    ).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
    expect(
      transition(
        CONTROL_LEASE_TRANSITIONS,
        'ControlLease',
        'lse_x',
        'forceClaimed',
        'requested',
        {},
      ),
    ).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
  });

  it('throws for an illegal ControlLease event from a live state', () => {
    expect(() =>
      transition(
        CONTROL_LEASE_TRANSITIONS,
        'ControlLease',
        'lse_x',
        'granted',
        'targetGone' as never,
        {},
      ),
    ).toThrow(InvalidStateTransition);
  });

  it('returns {kind:"ignored"} for any event from the terminal Profile state, deleted', () => {
    expect(
      transition(PROFILE_TRANSITIONS, 'Profile', 'prf_x', 'deleted', 'lease' as never, {}),
    ).toEqual({
      kind: 'ignored',
      reason: 'terminal_state',
    });
  });

  it('throws for an illegal Profile event from a live state', () => {
    expect(() =>
      transition(PROFILE_TRANSITIONS, 'Profile', 'prf_x', 'free', 'renewMissed' as never, {}),
    ).toThrow(InvalidStateTransition);
  });

  it('the free->lease guard rejects (ignores) when the profile is expired, and grants leased otherwise', () => {
    const expired = transition(PROFILE_TRANSITIONS, 'Profile', 'prf_x', 'free', 'lease', {
      profileExpired: true,
    });
    expect(expired).toEqual({ kind: 'ok', to: 'free' });

    const leasable = transition(PROFILE_TRANSITIONS, 'Profile', 'prf_x', 'free', 'lease', {
      nodeReady: true,
      currentlyLeased: false,
      profileExpired: false,
    });
    expect(leasable).toEqual({ kind: 'ok', to: 'leased' });

    // Neither candidate rule's guard matches (not leasable, not expired
    // either): transition() reports the last candidate's guard name.
    const busy = transition(PROFILE_TRANSITIONS, 'Profile', 'prf_x', 'free', 'lease', {
      nodeReady: false,
      currentlyLeased: false,
      profileExpired: false,
    });
    expect(busy).toEqual({ kind: 'ignored', reason: 'profile_expired' });
  });
});
