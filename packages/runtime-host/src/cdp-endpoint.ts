/**
 * CDP endpoint discovery, including the Windows specifics and the stale CDP
 * race. `DevToolsActivePort` is
 * the fast path; `probeCdpIdentity` (`identity-probe.ts`) is the authority.
 * A leftover `DevToolsActivePort` from a previous run reads as an instant
 * success against the wrong port if it is not removed before spawn.
 */

import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { type CdpIdentity, probeCdpIdentity } from './identity-probe.js';

/** Removes a stale `DevToolsActivePort` file from a profile directory, before spawning into it. Safe to call when the file does not exist. */
export function unlinkStaleDevToolsActivePort(profilePath: string): void {
  const path = join(profilePath, 'DevToolsActivePort');
  if (existsSync(path)) rmSync(path, { force: true });
}

/** One `DevToolsActivePort` file's contents: the port on line 1, the browser's own devtools path on line 2. */
export interface DevToolsActivePortContents {
  port: number;
  browserPath: string;
}

function readDevToolsActivePort(profilePath: string): DevToolsActivePortContents | null {
  const path = join(profilePath, 'DevToolsActivePort');
  if (!existsSync(path)) return null;
  const content = readFileSync(path, 'utf8');
  const lines = content.split('\n');
  const portLine = lines[0]?.trim();
  const browserPath = lines[1]?.trim() ?? '';
  const port = portLine ? Number(portLine) : Number.NaN;
  if (!portLine || Number.isNaN(port)) return null;
  return { port, browserPath };
}

/** Polls for `DevToolsActivePort` to appear, up to `deadlineAt` (wall clock ms). */
export async function waitForDevToolsActivePort(
  profilePath: string,
  deadlineAt: number,
  pollIntervalMs = 100,
): Promise<DevToolsActivePortContents> {
  for (;;) {
    const found = readDevToolsActivePort(profilePath);
    if (found) return found;
    if (Date.now() >= deadlineAt) {
      throw new Error(`DevToolsActivePort did not appear in ${profilePath} before the deadline`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}

/**
 * The full launch-time CDP readiness sequence: wait for `DevToolsActivePort`
 * (the fast path), then require `probeCdpIdentity` to confirm the
 * invariant appropriate to the situation (`'fresh'` when there is no
 * incumbent GUID to exclude, `'reused'` when there is). Returns
 * the confirmed CDP URL and identity.
 */
export async function discoverCdpEndpoint(opts: {
  profilePath: string;
  deadlineAt: number;
  excludeBrowserGuid?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ cdpUrl: string; identity: CdpIdentity }> {
  const portFile = await waitForDevToolsActivePort(opts.profilePath, opts.deadlineAt);
  const cdpUrl = `http://127.0.0.1:${portFile.port}`;
  const remainingMs = Math.max(1000, opts.deadlineAt - Date.now());
  const identity = await probeCdpIdentity({
    cdpUrl,
    mode: opts.excludeBrowserGuid ? 'reused' : 'fresh',
    overallTimeoutMs: remainingMs,
    ...(opts.excludeBrowserGuid !== undefined
      ? { excludeBrowserGuid: opts.excludeBrowserGuid }
      : {}),
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
  });
  return { cdpUrl, identity };
}
