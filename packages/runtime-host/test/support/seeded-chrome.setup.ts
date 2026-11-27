/**
 * Per worker half of `seeded-chrome.ts` (wired as a `setupFiles` entry).
 * Points `os.tmpdir()` at the run folder the global setup made, so every
 * test profile lands where teardown removes it, and turns the unseeded
 * profile guard on explicitly.
 */
import { inject } from 'vitest';
import type {} from './seeded-chrome.js';

const root = inject('bglsTestTmp');
if (root) {
  process.env['BGLS_TEST_TMP'] = root;
  process.env['TMPDIR'] = root;
  process.env['TMP'] = root;
  process.env['TEMP'] = root;
}
process.env['BGLS_REQUIRE_SEEDED_PROFILE'] = '1';
