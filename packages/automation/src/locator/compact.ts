/**
 * Shrinks a page side script before it goes on the wire.
 *
 * The locator scripts in `./script.ts` are written to be read: indented,
 * with long comments explaining each branch. Sent as written, the waiter
 * came to 34582 bytes, over the gateway's `MAX_EVALUATE_SOURCE_BYTES`
 * (32768), and every locator verb that waits failed against a real gateway
 * with `INVALID_ARGUMENT`. The fake gateway in the unit tests never enforced
 * the ceiling, so nothing caught it.
 *
 * This works line by line and never edits inside a line. It drops blank
 * lines, lines that are a `//` comment, and block comments that start at the
 * beginning of a line. It strips leading and trailing whitespace from every
 * line it keeps. It keeps every line break between kept lines, so automatic
 * semicolon insertion sees the same line terminators it saw before.
 *
 * That is only safe when no literal spans a line break, because then every
 * line start is outside any string or regex, and a line that begins with
 * `//` or `/*` there can only be a comment. In JavaScript only a template
 * literal or a string with a trailing backslash continuation can cross a
 * line, so the function refuses (throws) when it sees a backtick or a line
 * ending in a backslash. It also refuses a `/*` or `*` + `/` anywhere it
 * cannot account for, rather than guess. A refusal fires at module load,
 * which means the test suite fails the moment someone writes a script it
 * cannot handle.
 *
 * `test/client/locator-compact.test.ts` checks the result independently:
 * esbuild must print the same program for the original and the compacted
 * text of every exported script.
 *
 * `clients/python/src/browserglass/locator/script.py` has a line for line
 * port of this function. Change both together.
 */
export function compactPageScript(source: string): string {
  if (source.includes('`')) {
    throw new Error(
      'compactPageScript: the source contains a backtick; template literals can span lines and are not supported',
    );
  }
  const kept: string[] = [];
  let inBlockComment = false;
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.endsWith('\\')) {
      throw new Error(
        `compactPageScript: line ${i + 1} ends in a backslash; a string continued across lines is not supported`,
      );
    }
    if (inBlockComment) {
      const close = line.indexOf('*/');
      if (close === -1) continue;
      if (line.slice(close + 2).trim() !== '') {
        throw new Error(
          `compactPageScript: line ${i + 1} has code after the end of a block comment`,
        );
      }
      inBlockComment = false;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('/*')) {
      const close = line.indexOf('*/', 2);
      if (close === -1) {
        inBlockComment = true;
        continue;
      }
      if (line.slice(close + 2).trim() !== '') {
        throw new Error(
          `compactPageScript: line ${i + 1} has code after a block comment on the same line`,
        );
      }
      continue;
    }
    if (line.includes('/*') || line.includes('*/')) {
      throw new Error(
        `compactPageScript: line ${i + 1} has a block comment marker that does not start the line`,
      );
    }
    kept.push(line);
  }
  if (inBlockComment) {
    throw new Error('compactPageScript: the source ends inside a block comment');
  }
  return kept.join('\n');
}
