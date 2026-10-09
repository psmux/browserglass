/**
 * Vitest setup file (see `vitest.config.ts`). Points `os.tmpdir()` at the
 * long form of the temp directory before any test runs.
 *
 * On a Windows machine whose user name is long or has a space in it, TEMP
 * is often an 8.3 short path such as `C:\Users\RUNNER~1\AppData\Local\Temp`
 * (the GitHub Actions Windows runner is one). `load.ts` imports a plugin
 * through `pathToFileURL(absPath).href`, which encodes that `~` as `%7E`.
 * Node decodes it fine, so the shipped CLI is unaffected. Under vitest,
 * though, the dynamic import goes through vite-node, which looks the
 * still-encoded path up on disk, finds nothing, and every fixture plugin
 * written under the temp directory comes back as `load-failed` with
 * "Failed to load url ... Does the file exist?".
 *
 * `realpathSync.native` expands short names to their long form. It only
 * runs on Windows, and where TEMP is already a long path it hands back the
 * same directory, so other machines see no change.
 */
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

if (process.platform === 'win32') {
  const longTmp = realpathSync.native(tmpdir());
  process.env['TEMP'] = longTmp;
  process.env['TMP'] = longTmp;
}
