/**
 * The request gate's rule matcher.
 *
 * Small surface, but it decides what leaves the browser, so the escaping
 * rules get tested directly rather than through a socket. The case that
 * matters most is the literal dot: every real URL contains one, and a
 * pattern whose `.` silently became "any character" would match hosts its
 * author never named. On a deny rule that over-blocks; on an allow rule it
 * widens the hole, which is the direction worth a test.
 */

import type { GateRule } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { __gateMatchForTests } from '../../src/session/managed-session.js';

const { gatePatternToRegExp, matchGateRule } = __gateMatchForTests;
const matches = (pattern: string, url: string): boolean => gatePatternToRegExp(pattern).test(url);

describe('gatePatternToRegExp: `*` is the only metacharacter', () => {
  it('matches everything for a bare star', () => {
    expect(matches('*', 'https://a.example/x?y=1')).toBe(true);
  });

  it('treats a dot as a literal, not as "any character"', () => {
    expect(matches('https://a.example/x', 'https://a.example/x')).toBe(true);
    expect(matches('https://a.example/x', 'https://aXexample/x')).toBe(false);
  });

  it('treats a question mark as a literal, so a query string in a pattern means what it says', () => {
    expect(matches('https://a.example/?', 'https://a.example/x')).toBe(false);
    expect(matches('https://a.example/?', 'https://a.example/?')).toBe(true);
  });

  it('anchors both ends, so a pattern cannot match a host that merely contains it', () => {
    expect(matches('https://a.example/*', 'https://a.example/deep/path')).toBe(true);
    // The one that would be a real hole: an unanchored pattern would let
    // an attacker controlled host carry the allowed one in its path.
    expect(matches('https://a.example/*', 'https://evil.example/https://a.example/')).toBe(false);
  });

  it('lets a star span slashes and query strings', () => {
    expect(matches('*/submit*', 'https://a.example/forms/submit?id=1')).toBe(true);
  });

  it('does not let regexp syntax in a pattern change the match', () => {
    // A pattern that was accidentally treated as a regexp would make this
    // an alternation and match either host.
    expect(matches('https://(a|b).example/', 'https://a.example/')).toBe(false);
    expect(matches('https://(a|b).example/', 'https://(a|b).example/')).toBe(true);
  });
});

describe('matchGateRule: first match wins, and an unmatched request is allowed', () => {
  const rules: readonly GateRule[] = [
    { urlPattern: 'https://a.example/submit', verdict: 'ask' },
    { urlPattern: 'https://a.example/*', verdict: 'allow' },
    { urlPattern: '*', verdict: 'deny' },
  ];

  it('returns the first rule that matches, not the most specific one', () => {
    expect(matchGateRule(rules, 'https://a.example/submit', 'POST', 'XHR')?.verdict).toBe('ask');
    expect(matchGateRule(rules, 'https://a.example/other', 'GET', 'Script')?.verdict).toBe('allow');
    expect(matchGateRule(rules, 'https://b.example/x', 'GET', 'Script')?.verdict).toBe('deny');
  });

  it('returns undefined when nothing matches, which the caller reads as allow', () => {
    expect(
      matchGateRule(
        [{ urlPattern: 'https://a.example/x', verdict: 'deny' }],
        'https://b.example/',
        'GET',
        'Document',
      ),
    ).toBeUndefined();
  });

  it('a trailing catch-all is how a caller spells default deny, visibly', () => {
    const denyAll: readonly GateRule[] = [
      { urlPattern: 'https://allowed.example/*', verdict: 'allow' },
      { urlPattern: '*', verdict: 'deny' },
    ];
    expect(matchGateRule(denyAll, 'https://allowed.example/a', 'GET', 'Document')?.verdict).toBe(
      'allow',
    );
    expect(matchGateRule(denyAll, 'https://anything.else/', 'GET', 'Document')?.verdict).toBe(
      'deny',
    );
  });
});

describe('matchGateRule: method and resource type narrowing', () => {
  it('skips a rule whose methods do not include this one, case insensitively', () => {
    const rules: readonly GateRule[] = [{ urlPattern: '*', methods: ['post'], verdict: 'deny' }];
    expect(matchGateRule(rules, 'https://a.example/', 'POST', 'XHR')?.verdict).toBe('deny');
    expect(matchGateRule(rules, 'https://a.example/', 'GET', 'XHR')).toBeUndefined();
  });

  it('skips a rule whose resourceTypes do not include this one', () => {
    const rules: readonly GateRule[] = [
      { urlPattern: '*', resourceTypes: ['XHR', 'Fetch'], verdict: 'deny' },
    ];
    expect(matchGateRule(rules, 'https://a.example/', 'GET', 'Fetch')?.verdict).toBe('deny');
    expect(matchGateRule(rules, 'https://a.example/', 'GET', 'Image')).toBeUndefined();
  });

  it('an absent methods/resourceTypes means every method and every type', () => {
    const rules: readonly GateRule[] = [{ urlPattern: '*', verdict: 'deny' }];
    for (const m of ['GET', 'POST', 'DELETE']) {
      expect(matchGateRule(rules, 'https://a.example/', m, 'Document')?.verdict).toBe('deny');
    }
  });

  it('narrows a submit gate to exactly the shape a form post has, which is the motivating case', () => {
    const rules: readonly GateRule[] = [
      {
        urlPattern: 'https://shop.example.com/checkout*',
        methods: ['POST'],
        resourceTypes: ['XHR', 'Fetch', 'Document'],
        verdict: 'ask',
      },
    ];
    expect(
      matchGateRule(rules, 'https://shop.example.com/checkout/123', 'POST', 'Document')?.verdict,
    ).toBe('ask');
    // The same URL fetched as an image, or read with a GET, is not a
    // submission and must not pause anything.
    expect(
      matchGateRule(rules, 'https://shop.example.com/checkout/123', 'GET', 'Document'),
    ).toBeUndefined();
    expect(
      matchGateRule(rules, 'https://shop.example.com/checkout/logo.png', 'POST', 'Image'),
    ).toBeUndefined();
  });
});
