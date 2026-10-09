/**
 * `files/safe-name.ts`. This is the path safety suite, and it is written
 * as an attack list rather than as a feature list, because that is what
 * the function is for: the filename is the one piece of caller input that
 * becomes a real path component anywhere in the upload feature, and every
 * case below is a way somebody has historically escaped a directory with
 * one.
 */

import { resolve, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FALLBACK_SAFE_NAME,
  MAX_SAFE_NAME_BYTES,
  PathEscapeError,
  containedPath,
  safeFileName,
} from '../../src/files/safe-name.js';

describe('safeFileName: traversal', () => {
  it('keeps only the last component of a POSIX path', () => {
    expect(safeFileName('../../../etc/passwd')).toBe('passwd');
    expect(safeFileName('/etc/shadow')).toBe('shadow');
    expect(safeFileName('a/b/c/report.pdf')).toBe('report.pdf');
  });

  it('keeps only the last component of a Windows path, on every platform', () => {
    // Split on BOTH separators regardless of `process.platform`: the
    // attacker picks the string, not the host.
    expect(safeFileName('..\\..\\windows\\win.ini')).toBe('win.ini');
    expect(safeFileName('C:\\Windows\\System32\\config\\SAM')).toBe('SAM');
  });

  it('reduces a UNC path to its last component', () => {
    expect(safeFileName('\\\\attacker\\share\\payload.exe')).toBe('payload.exe');
    // A UNC path with nothing after the share reduces to the share name,
    // which is an ordinary component and harmless once joined.
    expect(safeFileName('\\\\attacker\\share')).toBe('share');
  });

  it('refuses the bare relative names outright', () => {
    expect(safeFileName('.')).toBe(FALLBACK_SAFE_NAME);
    expect(safeFileName('..')).toBe(FALLBACK_SAFE_NAME);
    expect(safeFileName('')).toBe(FALLBACK_SAFE_NAME);
    // A name that is nothing but separators has no last component at all.
    expect(safeFileName('///')).toBe(FALLBACK_SAFE_NAME);
  });

  it('does not leave a separator anywhere in the result', () => {
    for (const raw of ['a/b', 'a\\b', '../x', 'C:\\x\\y', '\\\\h\\s\\f']) {
      const safe = safeFileName(raw);
      expect(safe).not.toContain('/');
      expect(safe).not.toContain('\\');
    }
  });
});

describe('safeFileName: hostile characters', () => {
  it('strips NUL and other control characters', () => {
    // The classic NUL truncation trick: on a C API, `report.pdf\0.exe`
    // creates `report.pdf` while any string-length check sees the `.exe`.
    expect(safeFileName('report.pdf\u0000.exe')).toBe('report.pdf_.exe');
    expect(safeFileName('a\u0007b\u001Fc')).toBe('a_b_c');
  });

  it('strips the NTFS alternate data stream separator', () => {
    // `report.pdf:evil` writes to a hidden stream of `report.pdf` on NTFS,
    // so a later reader of `report.pdf` sees bytes nobody staged.
    expect(safeFileName('report.pdf:evil')).toBe('report.pdf_evil');
  });

  it('strips the remaining NTFS-forbidden set', () => {
    expect(safeFileName('a<b>c"d|e?f*g')).toBe('a_b_c_d_e_f_g');
  });
});

describe('safeFileName: Windows quirks', () => {
  it('strips trailing dots and spaces, which Windows drops silently', () => {
    // Without this, `report.pdf.` and `report.pdf` are two records naming
    // one file on disk.
    expect(safeFileName('report.pdf.')).toBe('report.pdf');
    expect(safeFileName('report.pdf   ')).toBe('report.pdf');
    expect(safeFileName('report.pdf . . ')).toBe('report.pdf');
  });

  it('renames reserved device names, with or without an extension', () => {
    expect(safeFileName('CON')).toBe('_CON');
    expect(safeFileName('con.txt')).toBe('_con.txt');
    expect(safeFileName('NUL.pdf.gz')).toBe('_NUL.pdf.gz');
    expect(safeFileName('COM1')).toBe('_COM1');
    expect(safeFileName('lpt9.log')).toBe('_lpt9.log');
  });

  it('leaves names that merely start like a device name alone', () => {
    expect(safeFileName('console.log')).toBe('console.log');
    expect(safeFileName('contract.pdf')).toBe('contract.pdf');
    expect(safeFileName('com10.txt')).toBe('com10.txt');
  });
});

describe('safeFileName: length', () => {
  it('truncates to the byte budget, keeping the extension', () => {
    const safe = safeFileName(`${'a'.repeat(500)}.pdf`);
    expect(new TextEncoder().encode(safe).byteLength).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES);
    expect(safe.endsWith('.pdf')).toBe(true);
  });

  it('measures bytes, not characters, and does not split a character', () => {
    // 300 emoji is 1200 UTF-8 bytes but only 300 code points, so a
    // character-count cap would let it through.
    const safe = safeFileName(`${'\u{1F600}'.repeat(300)}.pdf`);
    const bytes = new TextEncoder().encode(safe);
    expect(bytes.byteLength).toBeLessThanOrEqual(MAX_SAFE_NAME_BYTES);
    // A split surrogate pair would decode to U+FFFD.
    expect(safe).not.toContain('\uFFFD');
  });
});

describe('containedPath', () => {
  const dir = resolve('/srv/uploads/abc');

  it('accepts an ordinary name', () => {
    expect(containedPath(dir, 'report.pdf')).toBe(resolve(dir, 'report.pdf'));
  });

  it('rejects a traversal that got past the sanitiser', () => {
    // The sanitiser would never produce this. That is the point: this is
    // the check that does not depend on the sanitiser being right.
    expect(() => containedPath(dir, `..${sep}..${sep}etc${sep}passwd`)).toThrow(PathEscapeError);
    expect(() => containedPath(dir, '..')).toThrow(PathEscapeError);
  });

  it('rejects a sibling directory sharing the parent as a string prefix', () => {
    // `/srv/uploads/abc-evil` passes a naive startsWith('/srv/uploads/abc')
    // test. The separator-terminated comparison is what catches it.
    expect(() => containedPath(dir, `..${sep}abc-evil${sep}x`)).toThrow(PathEscapeError);
  });

  it('rejects the directory itself', () => {
    expect(() => containedPath(dir, '.')).toThrow(PathEscapeError);
  });

  it('rejects an absolute name, which resolve() would otherwise honour', () => {
    // `resolve(parent, '/etc/passwd')` is `/etc/passwd`: an absolute
    // second argument discards the first entirely.
    expect(() => containedPath(dir, resolve('/etc/passwd'))).toThrow(PathEscapeError);
  });

  it('accepts every output of safeFileName for a hostile input set', () => {
    const hostile = [
      '../../../etc/passwd',
      '..\\..\\windows\\win.ini',
      '\\\\attacker\\share\\payload.exe',
      'report.pdf\u0000.exe',
      'report.pdf:evil',
      'CON',
      '.',
      '..',
      '',
      '/',
      `${'a'.repeat(4000)}.pdf`,
    ];
    for (const raw of hostile) {
      expect(() => containedPath(dir, safeFileName(raw))).not.toThrow();
    }
  });
});
