import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { generateDevSigningKey } from '../src/dev-key.js';
import { readDevSession, writeDevSession } from '../src/session-file.js';

let dir: string | undefined;

afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
});

describe('session-file round trip', () => {
  it('writes and reads back an identical session', () => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-session-test-'));
    const key = generateDevSigningKey();
    const session = {
      schema: 'bgls.dev-session/1' as const,
      pid: 12345,
      startedAt: Date.now(),
      endpoint: 'http://127.0.0.1:7443',
      wsUrl: 'ws://127.0.0.1:7443/browserglass/socket',
      basePath: '/browserglass',
      tenantId: 'ten_00000000000000000000000000',
      appId: 'app_00000000000000000000000000',
      issuer: 'app_00000000000000000000000000',
      key,
    };
    writeDevSession(dir, session);
    const read = readDevSession(dir);
    expect(read).toEqual(session);
  });

  it('returns null for a missing session file, never throwing', () => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-session-test-'));
    expect(readDevSession(dir)).toBeNull();
  });
});
