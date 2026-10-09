import { describe, expect, it } from 'vitest';
import {
  REDACTED_PATH,
  clientSafeErrorMessage,
  redactServerPaths,
} from '../../src/wire/sanitize.js';

describe('redactServerPaths', () => {
  it('removes a Windows drive path, either separator style', () => {
    const msg =
      "ENOENT: no such file or directory, open 'C:\\Users\\someone\\AppData\\Local\\Temp\\bgls\\downloads\\pdf_1'";
    const out = redactServerPaths(msg);
    expect(out).not.toContain('someone');
    expect(out).toContain(REDACTED_PATH);
    expect(redactServerPaths('failed at D:/data/bgls/x.pdf')).toBe(`failed at ${REDACTED_PATH}`);
  });

  it('removes POSIX paths under system roots and UNC paths', () => {
    expect(redactServerPaths("open '/home/alice/bgls-data/downloads/pdf_1'")).toBe(
      `open '${REDACTED_PATH}'`,
    );
    expect(redactServerPaths('mkdir /tmp/bgls/x failed')).toBe(`mkdir ${REDACTED_PATH} failed`);
    expect(redactServerPaths('at \\\\fileserver\\share\\bgls\\x')).toBe(`at ${REDACTED_PATH}`);
  });

  it('removes the literal home directory wherever it appears', () => {
    const home = process.env['HOME'] ?? process.env['USERPROFILE'];
    if (home === undefined || home.length <= 3) return;
    expect(redactServerPaths(`could not read ${home}/x/y`)).not.toContain(home);
  });

  it('leaves URLs and ordinary text alone', () => {
    const msg = 'navigation to https://example.com/home/tmp/page failed: net::ERR_ABORTED';
    expect(redactServerPaths(msg)).toBe(msg);
    expect(redactServerPaths('target "tgt_abc" is gone')).toBe('target "tgt_abc" is gone');
    expect(redactServerPaths('see /v1/downloads/abc')).toBe('see /v1/downloads/abc');
  });
});

describe('clientSafeErrorMessage', () => {
  it('replaces a Node system error with the fallback plus its errno code', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open 'C:\\secret\\x'"), {
      code: 'EACCES',
      syscall: 'open',
      path: 'C:\\secret\\x',
    });
    expect(clientSafeErrorMessage(err, 'Could not save.')).toBe('Could not save. (EACCES)');
  });

  it('keeps a BrowserGlass error message, minus any server path', () => {
    expect(clientSafeErrorMessage(new Error('target tgt_1 has no live CDP session'), 'x')).toBe(
      'target tgt_1 has no live CDP session',
    );
    expect(clientSafeErrorMessage(new Error('bad file /var/lib/bgls/a'), 'x')).toBe(
      `bad file ${REDACTED_PATH}`,
    );
    expect(clientSafeErrorMessage(42, 'fallback text')).toBe('fallback text');
  });
});
