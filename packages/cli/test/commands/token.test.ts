import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tokenCommand } from '../../src/commands/token.js';
import { generateDevSigningKey } from '../../src/dev-key.js';
import { writeDevSession } from '../../src/session-file.js';
import { EXIT_CODES } from '../../src/util/exit.js';
import { captureStdio, parseJsonLines } from '../support/capture-io.js';

// The whole point of this command is that `TOKEN=$(bgls token)` works, so
// every assertion here is about which stream a given line lands on. The
// mint itself is local (`mintLocalAdminToken` signs with the dev key on
// disk, no network), so these tests need a `dev-session.json` but never a
// running gateway.

const ENDPOINT = 'http://127.0.0.1:7443';

let dir: string | undefined;
let previousDataDir: string | undefined;

/** Writes a `dev-session.json` with a real dev signing key into a temp dir and points `BGLS_DATA_DIR` at it, so `resolveGatewayConnection` finds it. */
function withDevSession(): void {
  dir = mkdtempSync(join(tmpdir(), 'bgls-token-test-'));
  writeDevSession(dir, {
    schema: 'bgls.dev-session/1',
    pid: process.pid,
    startedAt: Date.now(),
    endpoint: ENDPOINT,
    wsUrl: 'ws://127.0.0.1:7443/browserglass/socket',
    basePath: '/browserglass',
    tenantId: 'ten_00000000000000000000000000',
    appId: 'app_00000000000000000000000000',
    issuer: 'app_00000000000000000000000000',
    key: generateDevSigningKey(),
  });
  process.env['BGLS_DATA_DIR'] = dir;
}

/** The `exp` claim of a minted JWT, in epoch seconds. */
function expiryOf(jwt: string): number {
  const payload = jwt.split('.')[1] as string;
  return (
    JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { readonly exp: number }
  ).exp;
}

beforeEach(() => {
  process.exitCode = undefined;
  previousDataDir = process.env['BGLS_DATA_DIR'];
});

afterEach(() => {
  // biome-ignore lint/performance/noDelete: assigning undefined to process.env stores the string "undefined"; the variable must be removed.
  if (previousDataDir === undefined) delete process.env['BGLS_DATA_DIR'];
  else process.env['BGLS_DATA_DIR'] = previousDataDir;
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  process.exitCode = undefined;
});

describe('bgls token', () => {
  it('prints the bare token on stdout and nothing else, so command substitution captures only the token', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: {} } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const out = io.stdout.join('');
    expect(out.endsWith('\n')).toBe(true);
    const token = out.trimEnd();
    expect(out).toBe(`${token}\n`);
    expect(token.split('.')).toHaveLength(3);
  });

  it('writes the endpoint note to stderr, never stdout', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: {} } as never);
    io.restore();

    expect(io.stderr.join('')).toContain(`token for ${ENDPOINT}/browserglass`);
    expect(io.stdout.join('')).not.toContain('token for');
  });

  it('--quiet drops the stderr note and still prints the token', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { quiet: true } } as never);
    io.restore();

    expect(io.stderr.join('')).toBe('');
    expect(io.stdout.join('').trimEnd().split('.')).toHaveLength(3);
  });

  it('--json prints exactly one JSON line carrying the token, endpoint, basePath and expiry', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { json: true } } as never);
    io.restore();

    expect(process.exitCode ?? 0).toBe(EXIT_CODES.ok);
    const lines = parseJsonLines(io.stdout);
    expect(lines).toHaveLength(1);
    const result = lines[0] as {
      token: string;
      endpoint: string;
      basePath: string;
      wsUrl: string;
      expiresAt: number;
    };
    expect(result.endpoint).toBe(ENDPOINT);
    expect(result.basePath).toBe('/browserglass');
    expect(result.wsUrl).toBe('ws://127.0.0.1:7443/browserglass/socket');
    expect(result.expiresAt).toBe(expiryOf(result.token));
    expect(io.stderr.join('')).toBe('');
  });

  it('defaults the lifetime to 600s, clear of the 300s jti replay ceiling', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { json: true } } as never);
    io.restore();

    const result = parseJsonLines(io.stdout)[0] as { token: string; expiresAt: number };
    expect(result.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(300);
    expect(result.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);
  });

  it('--ttl reaches the mint, up to the 900s cap', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { json: true, ttl: '900' } } as never);
    io.restore();

    const result = parseJsonLines(io.stdout)[0] as { token: string; expiresAt: number };
    expect(result.expiresAt - Math.floor(Date.now() / 1000)).toBeGreaterThan(880);
  });

  it('a --ttl past the 900s cap is a usage error, with nothing on stdout to mistake for a token', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { ttl: '901' } } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(io.stdout.join('')).toBe('');
    expect(io.stderr.join('')).toContain('maxTtlSeconds');
  });

  it('a non-numeric --ttl is a usage error before anything is minted', async () => {
    withDevSession();
    const io = captureStdio();
    await tokenCommand.run!({ args: { ttl: 'abc' } } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(io.stdout.join('')).toBe('');
    expect(io.stderr.join('')).toContain('--ttl must be a positive integer');
  });

  it('no dev-session.json and no --endpoint is a usage error on stderr, with empty stdout', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bgls-token-empty-'));
    process.env['BGLS_DATA_DIR'] = dir;
    const io = captureStdio();
    await tokenCommand.run!({ args: { json: true } } as never);
    io.restore();

    expect(process.exitCode).toBe(EXIT_CODES.usageError);
    expect(io.stdout.join('')).toBe('');
    expect(io.stderr.join('')).toContain('dev-session.json');
  });

  it('an explicit --endpoint/--token pair is echoed back rather than minted', async () => {
    const io = captureStdio();
    await tokenCommand.run!({
      args: { json: true, endpoint: ENDPOINT, token: 'not-a-jwt' },
    } as never);
    io.restore();

    const result = parseJsonLines(io.stdout)[0] as { token: string; expiresAt: number | null };
    expect(result.token).toBe('not-a-jwt');
    // An operator-supplied token need not be a JWT at all, so the expiry is
    // reported as unknown rather than guessed.
    expect(result.expiresAt).toBeNull();
  });
});
