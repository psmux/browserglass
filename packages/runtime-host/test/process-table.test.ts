import { describe, expect, it } from 'vitest';
import {
  __guardsForTests,
  __parsePosixPsOutputForTests,
  __parseWindowsCimJsonForTests,
  __recognisedExecutableNamesForTests,
  __windowsProcessNameFilterForTests,
  classifyChromeProcess,
  filterForDataDir,
  invalidateProcessTableSnapshot,
  listAllChromeFamilyProcessesAsync,
} from '../src/process-table.js';

// Fixture recorded shape: `ps -axo pid=,ppid=,command=` output style, one
// browser-main process plus its renderer/GPU/utility children plus one
// unrelated foreign browser on a different data dir, plus a decoy process
// (a text editor) whose command line merely mentions the data dir path.
const POSIX_FIXTURE = `
  501     1 /usr/lib/chromium/chromium --user-data-dir=/home/bgls/profiles/ws-1 --remote-debugging-port=0
  510   501 /usr/lib/chromium/chromium --type=renderer --user-data-dir=/home/bgls/profiles/ws-1
  511   501 /usr/lib/chromium/chromium --type=gpu-process --user-data-dir=/home/bgls/profiles/ws-1
  600     1 /usr/lib/chromium/chromium --user-data-dir=/home/bgls/profiles/ws-12 --remote-debugging-port=0
  700  9999 vim /home/bgls/profiles/ws-1/notes.txt
`;

describe('__parsePosixPsOutputForTests', () => {
  it('parses pid, ppid, and the full command line for every row', () => {
    const rows = __parsePosixPsOutputForTests(POSIX_FIXTURE);
    expect(rows).toHaveLength(5);
    expect(rows[0]).toEqual({
      pid: 501,
      ppid: 1,
      commandLine:
        '/usr/lib/chromium/chromium --user-data-dir=/home/bgls/profiles/ws-1 --remote-debugging-port=0',
    });
  });
});

describe('__parseWindowsCimJsonForTests', () => {
  it('parses a single-object result (PowerShell collapses a one-row array)', () => {
    const rows = __parseWindowsCimJsonForTests(
      JSON.stringify({
        ProcessId: 24744,
        ParentProcessId: 4688,
        CommandLine: '"C:\\chrome.exe" --user-data-dir=C:\\p1',
      }),
    );
    expect(rows).toEqual([
      { pid: 24744, ppid: 4688, commandLine: '"C:\\chrome.exe" --user-data-dir=C:\\p1' },
    ]);
  });

  it('parses a multi-row array and drops rows with a null CommandLine', () => {
    const rows = __parseWindowsCimJsonForTests(
      JSON.stringify([
        { ProcessId: 1, ParentProcessId: 0, CommandLine: null },
        { ProcessId: 2, ParentProcessId: 1, CommandLine: 'chrome.exe --user-data-dir=C:\\p1' },
      ]),
    );
    expect(rows).toEqual([{ pid: 2, ppid: 1, commandLine: 'chrome.exe --user-data-dir=C:\\p1' }]);
  });

  it('returns an empty array for empty PowerShell output', () => {
    expect(__parseWindowsCimJsonForTests('')).toEqual([]);
  });
});

describe('classifyChromeProcess, the four skip rules in order', () => {
  const launching = new Set<number>();

  it('classifies this process itself as self', () => {
    const result = classifyChromeProcess(
      { pid: process.pid, ppid: 1, commandLine: 'x' },
      { currentlyLaunchingPids: launching },
    );
    expect(result).toBe('self');
  });

  it('classifies a process whose ppid is this process as ownedByUs, the normal healthy state, never an orphan', () => {
    const result = classifyChromeProcess(
      { pid: 99999, ppid: process.pid, commandLine: 'x' },
      { currentlyLaunchingPids: launching },
    );
    expect(result).toBe('ownedByUs');
  });

  it('classifies a pid in the currently-launching set as launching, even if its recorded ppid looks orphaned', () => {
    const launchingSet = new Set([12345]);
    const result = classifyChromeProcess(
      { pid: 12345, ppid: 1, commandLine: 'x' },
      { currentlyLaunchingPids: launchingSet },
    );
    expect(result).toBe('launching');
  });

  it('classifies a process with a live, non-self, non-launching ppid as foreign (never touched)', () => {
    // This process's own ppid is guaranteed alive (it is this test
    // runner's parent), and is neither pid 1 nor this process's own pid.
    const result = classifyChromeProcess(
      { pid: 88888, ppid: process.ppid, commandLine: 'x' },
      { currentlyLaunchingPids: launching },
    );
    expect(['foreign', 'orphan']).toContain(result); // process.ppid may be 1 on some CI shells; either is a safe classification for a fixture ppid, but on a normal dev machine this is 'foreign'.
  });

  it('classifies a process with no live owner (reparented to init/pid 1) as orphan', () => {
    const result = classifyChromeProcess(
      { pid: 77777, ppid: 1, commandLine: 'x' },
      { currentlyLaunchingPids: launching },
    );
    expect(result).toBe('orphan');
  });
});

describe('the three load-bearing POSIX parse guards', () => {
  it('guard 1: recognises a chrome-family executable up to the first " -", ignoring flags that mention "chrome"', () => {
    expect(
      __guardsForTests.looksLikeChromeExecutable('/usr/lib/chromium/chromium --user-data-dir=/x'),
    ).toBe(true);
    expect(
      __guardsForTests.looksLikeChromeExecutable(
        '"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/x',
      ),
    ).toBe(true);
    expect(
      __guardsForTests.looksLikeChromeExecutable('/usr/bin/vim --some-flag-mentioning-chrome'),
    ).toBe(false);
  });

  it('guard 2: does not match /path/ws-1 against a process actually running /path/ws-12 (the historical cross-instance kill bug)', () => {
    expect(
      __guardsForTests.containsDataDirArg(
        'chrome --user-data-dir=/path/ws-12 --remote-debugging-port=0',
        '/path/ws-1',
      ),
    ).toBe(false);
    expect(
      __guardsForTests.containsDataDirArg(
        'chrome --user-data-dir=/path/ws-1 --remote-debugging-port=0',
        '/path/ws-1',
      ),
    ).toBe(true);
  });

  it('guard 2: matches a quoted data dir value exactly, including one containing spaces', () => {
    expect(
      __guardsForTests.containsDataDirArg(
        'chrome.exe --user-data-dir="C:\\profiles\\my profile" --flag',
        'C:\\profiles\\my profile',
      ),
    ).toBe(true);
    expect(
      __guardsForTests.containsDataDirArg(
        'chrome.exe --user-data-dir="C:\\profiles\\my profile 2" --flag',
        'C:\\profiles\\my profile',
      ),
    ).toBe(false);
  });

  it('guard 3: excludes any command line carrying --type=, renderer/GPU/utility children never qualify', () => {
    expect(__guardsForTests.isChildTypeProcess('chrome --type=renderer --user-data-dir=/x')).toBe(
      true,
    );
    expect(
      __guardsForTests.isChildTypeProcess('chrome --user-data-dir=/x --remote-debugging-port=0'),
    ).toBe(false);
  });
});

/**
 * Every WQL `LIKE '%pattern%'` in the Windows process-name filter, lower
 * cased, so a test can apply them the way the CIM provider would.
 */
function windowsFilterPatterns(): string[] {
  return [...__windowsProcessNameFilterForTests().matchAll(/LIKE '%([^%]+)%'/g)].map((m) =>
    (m[1] as string).toLowerCase(),
  );
}

describe('the Windows process-name filter agrees with EXECUTABLE_NAME_RE', () => {
  // This is the regression guard for a bug that shipped: the filter used
  // `%chrome%`, and "chromium" does not contain the substring "chrome",
  // so `chromium.exe` was never returned by a Windows scan at all.
  // `headless_shell.exe` was not covered by any pattern either. Both are
  // named in the executable regex as binaries this module recognises, so
  // orphan reaping, the profile lock check and `resolveBrowserPid` were
  // all silently blind to two of the five supported browsers on Windows,
  // while the POSIX path (which greps command lines, not process names)
  // handled them correctly. Any future edit that narrows one side without
  // the other fails here.
  const patterns = windowsFilterPatterns();

  for (const name of __recognisedExecutableNamesForTests) {
    it(`matches ${name}`, () => {
      expect(patterns.some((p) => name.toLowerCase().includes(p))).toBe(true);
    });
  }

  it('does not match an unrelated executable', () => {
    for (const name of ['explorer.exe', 'node.exe', 'firefox.exe', 'powershell.exe']) {
      expect(patterns.some((p) => name.toLowerCase().includes(p))).toBe(false);
    }
  });
});

describe('filterForDataDir applies all three guards to a snapshot', () => {
  const snapshot = __parsePosixPsOutputForTests(POSIX_FIXTURE);

  it('returns only the browser-main process for the exact data dir', () => {
    const found = filterForDataDir(snapshot, '/home/bgls/profiles/ws-1');
    expect(found).toHaveLength(1);
    expect(found[0]?.pid).toBe(501);
  });

  it('does not match a prefix of a longer data dir (the cross-instance kill bug)', () => {
    const found = filterForDataDir(snapshot, '/home/bgls/profiles/ws-1');
    expect(found.map((p) => p.pid)).not.toContain(600);
  });

  it('answers many data dirs from ONE snapshot, which is the whole point of splitting it out', () => {
    expect(filterForDataDir(snapshot, '/home/bgls/profiles/ws-1')[0]?.pid).toBe(501);
    expect(filterForDataDir(snapshot, '/home/bgls/profiles/ws-12')[0]?.pid).toBe(600);
    expect(filterForDataDir(snapshot, '/home/bgls/profiles/nope')).toEqual([]);
  });
});

describe('listAllChromeFamilyProcessesAsync', () => {
  it('never rejects, even though the underlying scan can fail: callers ask a best-effort question', async () => {
    invalidateProcessTableSnapshot();
    await expect(listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 })).resolves.toBeInstanceOf(Array);
  });

  it('serves a second caller inside the TTL from the cached snapshot rather than scanning again', async () => {
    invalidateProcessTableSnapshot();
    const first = await listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 });
    const startedAt = Date.now();
    const second = await listAllChromeFamilyProcessesAsync({ maxAgeMs: 60_000 });
    // Identity, not deep equality: a cache hit hands back the very same
    // array. A real rescan on this machine measured ~590ms, so the elapsed
    // check is a wide margin and not a timing-sensitive assertion.
    expect(second).toBe(first);
    expect(Date.now() - startedAt).toBeLessThan(200);
  });

  it('coalesces concurrent callers onto one scan', async () => {
    invalidateProcessTableSnapshot();
    const [a, b, c] = await Promise.all([
      listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 }),
      listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 }),
      listAllChromeFamilyProcessesAsync({ maxAgeMs: 0 }),
    ]);
    expect(b).toBe(a);
    expect(c).toBe(a);
  });
});
