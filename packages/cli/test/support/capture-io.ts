import { vi } from 'vitest';

/**
 * Spies on `process.stdout.write`/`process.stderr.write` so a test can
 * assert directly on the CLI's central contract: `--json` mode's stdout is
 * valid JSON (or JSON Lines) and nothing else, with every human-readable
 * line (`Printer.info`/`warn`/`success`, which `consola` ultimately
 * writes through `console.log`/`console.error`, i.e. through these same
 * two streams) landing on stderr instead.
 */
export function captureStdio(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  return {
    stdout,
    stderr,
    restore: () => {
      outSpy.mockRestore();
      errSpy.mockRestore();
    },
  };
}

/** Parses every non-empty line of `lines.join('')` as one JSON value, throwing with the offending line's index and text if any line is not valid JSON. Used to assert a stream is genuine JSON Lines. */
export function parseJsonLines(lines: readonly string[]): unknown[] {
  const text = lines.join('');
  const rows = text.split('\n').filter((l) => l.length > 0);
  return rows.map((row, i) => {
    try {
      return JSON.parse(row) as unknown;
    } catch (err) {
      throw new Error(
        `parseJsonLines(): line ${i} is not valid JSON: ${row}\n${err instanceof Error ? err.message : String(err)}`,
      );
    }
  });
}
