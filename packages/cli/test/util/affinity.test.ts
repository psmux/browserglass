import { describe, expect, it } from 'vitest';
import { buildAcquireRequest, parseAffinityArgs } from '../../src/util/drive.js';

/**
 * `--sticky-subject` / `--sticky-within-ms`, the CLI's spelling of the one
 * affinity concept every on-ramp shares.
 *
 * The assertion that matters most here is the two field one: a request
 * carrying `sticky.subject` without a matching `subject` finds nothing on
 * the second call, because the browser the first call launched was filed
 * under the CLI token's own sub instead. That failure is invisible from
 * the call site (a 201 and a working browser, every time), so it is
 * pinned here rather than left to a reviewer to notice.
 */
describe('buildAcquireRequest affinity', () => {
  it('sets BOTH sticky.subject (the selector) and subject (the tag) from one flag', () => {
    expect(buildAcquireRequest({ stickySubject: 'alice' })).toEqual({
      sticky: { subject: 'alice' },
      subject: 'alice',
    });
  });

  it('carries the window through as sticky.withinMs', () => {
    expect(buildAcquireRequest({ stickySubject: 'alice', stickyWithinMs: 900_000 })).toEqual({
      sticky: { subject: 'alice', withinMs: 900_000 },
      subject: 'alice',
    });
  });

  it('omits both fields entirely when no subject is given: a bare acquire launches, it does not reuse', () => {
    const body = buildAcquireRequest({ pool: 'default' });
    expect(body).toEqual({ pool: 'default' });
    expect(Object.keys(body)).not.toContain('sticky');
    expect(Object.keys(body)).not.toContain('subject');
  });

  it('combines with an ephemeral profile, the case a throwaway-but-mine browser needs', () => {
    const body = buildAcquireRequest({ stickySubject: 'alice', viewport: '800x600' });
    expect(body.sticky).toEqual({ subject: 'alice' });
    expect(body.profile).toBeUndefined();
  });

  it('leaves a persistent profile key alongside sticky for the router to reject, rather than duplicating that rule here', () => {
    // `E_CONFLICTING_SELECTORS` is the router's call, and one place should
    // own the wording a user sees. This only proves the CLI does not
    // silently drop one of the two.
    const body = buildAcquireRequest({ stickySubject: 'alice', profileKey: 'work' });
    expect(body.profile).toEqual({ mode: 'persistent', key: 'work' });
    expect(body.sticky).toEqual({ subject: 'alice' });
  });

  it('rejects --sticky-within-ms without --sticky-subject: a window with nothing to reattach to is a typo, not a request', () => {
    expect(() => buildAcquireRequest({ stickyWithinMs: 1000 })).toThrow(/needs --sticky-subject/);
  });

  it('rejects a non-positive --sticky-within-ms', () => {
    expect(() => buildAcquireRequest({ stickySubject: 'alice', stickyWithinMs: 0 })).toThrow(
      /positive number of milliseconds/,
    );
    expect(() => buildAcquireRequest({ stickySubject: 'alice', stickyWithinMs: -5 })).toThrow(
      /positive number of milliseconds/,
    );
  });
});

describe('parseAffinityArgs', () => {
  it('reads both flags off a citty args object, converting the window to a number', () => {
    expect(parseAffinityArgs({ 'sticky-subject': 'alice', 'sticky-within-ms': '60000' })).toEqual({
      stickySubject: 'alice',
      stickyWithinMs: 60_000,
    });
  });

  it('returns undefined for both when neither flag was passed', () => {
    expect(parseAffinityArgs({})).toEqual({ stickySubject: undefined, stickyWithinMs: undefined });
  });

  it('throws on a window that is not a number at all', () => {
    expect(() => parseAffinityArgs({ 'sticky-within-ms': 'soon' })).toThrow(
      /expected a positive number/,
    );
  });
});
