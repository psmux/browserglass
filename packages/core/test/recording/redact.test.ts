import { describe, expect, it } from 'vitest';
import { REDACTED_META_KEYS, redactMeta, redactUrl } from '../../src/recording/redact.js';

describe('redactUrl', () => {
  it('redacts every credential-shaped query param, verbatim-ported from recorder.py', () => {
    const url = 'https://idp.example/callback?code=abc123&state=xyz&session_state=blah';
    expect(redactUrl(url)).toBe(
      'https://idp.example/callback?code=REDACTED&state=xyz&session_state=REDACTED',
    );
  });

  it('redacts a fragment-carried token (implicit-flow style)', () => {
    const url = 'https://app.example/#access_token=abcdef&token_type=bearer&expires_in=3600';
    expect(redactUrl(url)).toBe(
      'https://app.example/#access_token=REDACTED&token_type=bearer&expires_in=3600',
    );
  });

  it('leaves a URL with no credential-shaped params unchanged', () => {
    const url = 'https://example.com/dashboard?tab=overview&page=2';
    expect(redactUrl(url)).toBe(url);
  });

  it('is case-insensitive on the param name', () => {
    expect(redactUrl('https://x.example/?Access_Token=abc')).toBe(
      'https://x.example/?Access_Token=REDACTED',
    );
  });
});

describe('redactMeta', () => {
  it('drops every key in REDACTED_META_KEYS, case-insensitively', () => {
    const out = redactMeta({
      sessionId: 'sess_abc',
      ViewerId: 'vwr_xyz',
      PASSWORD: 'hunter2',
      note: 'kept',
    });
    expect(out).toEqual({ note: 'kept' });
    for (const key of Object.keys(out)) {
      expect(REDACTED_META_KEYS).not.toContain(key.toLowerCase());
    }
  });

  it('runs redactUrl over remaining string values that look like a URL', () => {
    const out = redactMeta({
      returnUrl: 'https://idp.example/cb?code=SECRET&x=1',
      title: 'not a url',
    });
    expect(out.returnUrl).toBe('https://idp.example/cb?code=REDACTED&x=1');
    expect(out.title).toBe('not a url');
  });

  it('never mutates the input object', () => {
    const input = { sessionId: 'sess_abc', note: 'kept' } as const;
    const snapshot = { ...input };
    redactMeta(input);
    expect(input).toEqual(snapshot);
  });

  it('passes non-string values through unchanged', () => {
    const out = redactMeta({ count: 3, ok: true, nested: { a: 1 } });
    expect(out).toEqual({ count: 3, ok: true, nested: { a: 1 } });
  });
});
