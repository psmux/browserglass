/**
 * `rest/routes/uploads.ts` and `routes/targets.ts`'s `setTargetFiles`, end
 * to end through `dispatchRest` with real EdDSA token issuance and a real
 * `UploadStore` against a temp directory.
 *
 * This is the on-ramp a plain HTTP caller uses: for example a Python
 * script holding a PDF to upload and no `bgls.v1` socket. Every test below is
 * written as that caller's own sequence, because the interesting failures
 * (a chunk route whose body got JSON-parsed, an attach route that leaks a
 * path) only show up from the outside.
 *
 * Built with a hand-constructed `RestContext` rather than
 * `createBrowserGlass`, matching `targets.test.ts`'s own harness and for
 * the same reason: the routes need `ctx.driver`/`ctx.uploads` injected so
 * their own logic (validation, capability gating, error envelopes) is
 * exercised without launching a browser.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Capability, Principal, TargetSummary } from '@browserglass/protocol';
import { newId } from '@browserglass/protocol';
import type { BrowserRouter, DriveResolution } from '@browserglass/router';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  type AppSigningKey,
  InProcessJtiCache,
  TokenApiImpl,
  generateEd25519KeyMaterial,
  jwtAuthResolver,
} from '../../src/auth/index.js';
import { resolveConfig } from '../../src/config/resolve.js';
import { type UploadStore, createUploadStore } from '../../src/files/upload-store.js';
import { HookRegistry } from '../../src/hooks/dispatch.js';
import { fetchResponseFromNode, nodeRequestFromFetch } from '../../src/rest/fetch-bridge.js';
import { dispatchRest } from '../../src/rest/router.js';
import type { RestContext, RestSessionDriver } from '../../src/rest/types.js';

/** A router stand-in that admits one instance. See `targets.test.ts` for the fuller version; this suite only needs the happy path plus one non local case. */
function fakeRouter(local = true): BrowserRouter {
  return {
    async driveInstance(instanceId: string, _principal: Principal): Promise<DriveResolution> {
      if (instanceId !== 'inst_1')
        throw { httpStatus: 404, code: 'E_INSTANCE_NOT_FOUND', message: 'no such instance' };
      return { instanceId, nodeId: local ? 'nod_local' : 'nod_other', sessionId: 'sess_1', local };
    },
  } as unknown as BrowserRouter;
}

interface Attached {
  readonly targetId: string;
  readonly selector: string;
  readonly paths: readonly string[];
}

/**
 * A driver that resolves upload ids through the REAL store, exactly the
 * way `session/rest-driver.ts` does, and records the PATHS it would have
 * handed to CDP. Recording the paths is the point: it is what lets a test
 * assert that a caller naming ids only ever produces paths inside the
 * staging root.
 */
function recordingDriver(uploads: UploadStore, attached: Attached[]): RestSessionDriver {
  return {
    listTargets: async () => [] as TargetSummary[],
    createTarget: async () => ({}) as TargetSummary,
    closeTarget: async () => undefined,
    navigate: async () => null,
    screenshot: async () => ({ format: 'png' as const, data: '', width: 0, height: 0 }),
    click: async () => undefined,
    type: async () => undefined,
    async setInputFiles(_drive, targetId, req) {
      const paths: string[] = [];
      const files: string[] = [];
      for (const uploadId of req.uploadIds) {
        paths.push(await uploads.pathFor(uploadId, req.tenantId));
        files.push(uploads.status(uploadId, req.tenantId).name);
      }
      attached.push({ targetId, selector: req.selector, paths });
      for (const uploadId of req.uploadIds) uploads.touch(uploadId, req.tenantId);
      return { files };
    },
  };
}

interface Harness {
  readonly ctx: RestContext;
  readonly uploads: UploadStore;
  readonly attached: Attached[];
  readonly root: string;
  readonly issueToken: (caps: readonly Capability[]) => Promise<string>;
}

let harness: Harness;

async function buildHarness(
  opts: { readonly local?: boolean; readonly withUploads?: boolean } = {},
): Promise<Harness> {
  const tenantId = newId('ten');
  const appId = newId('app');
  const keyMaterial = generateEd25519KeyMaterial();
  const signingKey: AppSigningKey = {
    kid: 'test-key',
    alg: 'EdDSA',
    publicKey: keyMaterial.publicKey,
    privateKey: keyMaterial.privateKey,
    status: 'active',
  };

  const resolved = resolveConfig({
    mode: 'gateway',
    tenantId,
    appId,
    router: { endpoint: 'https://router.example.com' },
    auth: { keys: [signingKey], issuer: appId },
  });

  const jtiCache = new InProcessJtiCache(resolved.auth.jtiCacheSize);
  const resolver = jwtAuthResolver({
    keys: resolved.auth.keys,
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });
  const tokenApi = new TokenApiImpl({
    keys: resolved.auth.keys,
    defaultTtlSeconds: resolved.auth.defaultTtlSeconds,
    maxTtlSeconds: resolved.auth.maxTtlSeconds,
    maxCaps: resolved.auth.maxCaps,
    tenantAllowedCaps: resolved.auth.maxCaps,
    clock: { now: () => Date.now() },
    tenantId: resolved.tenantId,
    appId: resolved.appId,
    issuer: resolved.auth.issuer,
    clockSkewSeconds: resolved.auth.clockSkewSeconds,
    jtiCache,
  });

  const root = await mkdtemp(join(tmpdir(), 'bgls-rest-upload-'));
  const uploads = createUploadStore({ root, logger: resolved.logger.sink, sweepIntervalMs: 0 });
  const attached: Attached[] = [];

  const ctx: RestContext = {
    config: resolved,
    getRouter: () => fakeRouter(opts.local ?? true),
    store: undefined,
    tokens: tokenApi,
    resolver,
    hooks: new HookRegistry(undefined, { globalTimeoutMs: 5000, logger: resolved.logger.sink }),
    logger: resolved.logger.sink,
    isAccepting: () => true,
    isReady: () => true,
    driver: recordingDriver(uploads, attached),
    ...(opts.withUploads === false ? {} : { uploads }),
  };

  return {
    ctx,
    uploads,
    attached,
    root,
    async issueToken(caps) {
      return tokenApi.issue({
        sub: newId('usr'),
        caps,
        scope: { kind: 'global' },
        tenantId,
        appId,
        ttlSeconds: 300,
      });
    },
  };
}

/**
 * One REST call, with a FRESH token minted for it.
 *
 * A token is single use here, and that is real behaviour rather than a
 * test artefact: `jwtAuthResolver` checks `jti` against
 * `InProcessJtiCache`, so replaying one token across the four calls of an
 * upload sequence answers 401 on the second. A caller doing this for real
 * asks for a token per request (or configures no jti cache); this helper
 * does the former, which also keeps every test honest about the capability
 * each individual route actually needs.
 */
async function call(
  h: Harness,
  method: string,
  path: string,
  opts?: {
    readonly caps?: readonly Capability[];
    readonly body?: unknown;
    readonly raw?: Uint8Array;
  },
): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
  const token = await h.issueToken(opts?.caps ?? ['upload']);
  const headers = new Headers();
  headers.set('authorization', `Bearer ${token}`);
  let body: BodyInit | undefined;
  if (opts?.raw !== undefined) {
    headers.set('content-type', 'application/octet-stream');
    body = opts.raw as unknown as BodyInit;
  } else if (
    opts?.body !== undefined &&
    method !== 'GET' &&
    method !== 'HEAD' &&
    method !== 'DELETE'
  ) {
    headers.set('content-type', 'application/json');
    body = JSON.stringify(opts.body);
  }
  const request = new Request(`http://localhost${path}`, { method, headers, body });
  const { req, res, done } = nodeRequestFromFetch(request);
  await dispatchRest(h.ctx, req, res, new URL(request.url).pathname);
  const response = fetchResponseFromNode(await done);
  const status = response.status;
  const text = await response.text();
  return { status, body: text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

/** Stages one completed upload and returns its id. Three calls, three tokens. */
async function stageViaRest(h: Harness, name: string, bytes: Uint8Array): Promise<string> {
  const init = await call(h, 'POST', '/v1/upload/init', {
    body: { name, sizeBytes: bytes.byteLength },
  });
  const uploadId = init.body['uploadId'] as string;
  if (bytes.byteLength > 0) await call(h, 'PUT', `/v1/upload/${uploadId}`, { raw: bytes });
  await call(h, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
  return uploadId;
}

beforeEach(async () => {
  harness = await buildHarness();
});

afterEach(async () => {
  await harness.uploads.dispose();
  await rm(harness.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("the Python caller's whole sequence", () => {
  it('stages an invoice in one PUT and attaches it', async () => {
    const bytes = new TextEncoder().encode('%PDF-1.7 an invoice, notionally');

    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'invoice.pdf', sizeBytes: bytes.byteLength, mime: 'application/pdf' },
    });
    expect(init.status).toBe(201);
    const uploadId = init.body['uploadId'] as string;
    expect(typeof uploadId).toBe('string');
    expect(init.body['name']).toBe('invoice.pdf');

    const put = await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: bytes });
    expect(put.status).toBe(200);
    expect(put.body['receivedBytes']).toBe(bytes.byteLength);

    const done = await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
    expect(done.status).toBe(200);
    expect(done.body['status']).toBe('ready');
    expect(done.body['sha256']).toMatch(/^[0-9a-f]{64}$/);

    const set = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: 'input[type=file]', uploadIds: [uploadId] },
    });
    expect(set.status).toBe(200);
    expect(set.body['files']).toEqual(['invoice.pdf']);

    // The bytes that would reach Chrome are the bytes that were sent.
    expect(harness.attached).toHaveLength(1);
    expect(await readFile(harness.attached[0]?.paths[0] as string)).toEqual(Buffer.from(bytes));
  });

  it('accepts a chunked transfer and reports the resume point', async () => {
    const bytes = new Uint8Array(3000).map((_, i) => i % 251);
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'big.bin', sizeBytes: 3000 },
    });
    const uploadId = init.body['uploadId'] as string;

    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: bytes.subarray(0, 1000) });
    // A caller that dropped mid transfer reads its offset back rather than
    // guessing; that is why PUT appends at the current offset instead of
    // taking a caller-declared one.
    const status = await call(harness, 'GET', `/v1/upload/${uploadId}`);
    expect(status.body['receivedBytes']).toBe(1000);
    expect(status.body['status']).toBe('staging');

    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: bytes.subarray(1000, 2500) });
    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: bytes.subarray(2500) });
    const done = await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
    expect(done.status).toBe(200);
    expect(done.body['sizeBytes']).toBe(3000);
  });

  it('does not JSON-parse the chunk body, which is what rawBody exists for', async () => {
    // Binary that is not valid UTF-8 and certainly not valid JSON. Without
    // RestRoute.rawBody the shared body reader would have consumed the
    // stream and answered E_BAD_JSON before the handler ever ran.
    const bytes = new Uint8Array([0x00, 0xff, 0xfe, 0x7b, 0x22, 0x80, 0x81]);
    const uploadId = await stageViaRest(harness, 'a.bin', bytes);
    const set = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: [uploadId] },
    });
    expect(set.status).toBe(200);
    expect(new Uint8Array(await readFile(harness.attached[0]?.paths[0] as string))).toEqual(bytes);
  });

  it('deletes a staged upload and answers the same whether or not it existed', async () => {
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a.bin', sizeBytes: 1 },
    });
    const uploadId = init.body['uploadId'] as string;
    expect((await call(harness, 'DELETE', `/v1/upload/${uploadId}`)).status).toBe(200);
    // Idempotent, and a never-seen id answers the same way: a
    // distinguishable 404 would confirm which ids exist.
    expect((await call(harness, 'DELETE', `/v1/upload/${uploadId}`)).status).toBe(200);
    expect((await call(harness, 'DELETE', '/v1/upload/never_existed')).status).toBe(200);
  });
});

describe('path safety at the route boundary', () => {
  it('has no route that accepts a path, so a path in the body is simply ignored', async () => {
    // The attack this closes: {"selector": "#f", "path": "/etc/shadow"}.
    // There is no path field, no localPath, and no fallback, so the
    // request fails on the missing uploadIds rather than reading a file.
    const res = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', path: '/etc/shadow', files: ['/etc/shadow'] },
    });
    expect(res.status).toBe(400);
    expect(res.body['error']).toMatchObject({ code: 'E_MISSING_PARAM' });
    expect(harness.attached).toHaveLength(0);
  });

  it('refuses an uploadId that looks like a path', async () => {
    const res = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: ['../../../etc/shadow'] },
    });
    // Not found, because it is not an id this tenant staged. The id never
    // reaches the filesystem in any form.
    expect(res.status).toBe(404);
    expect(harness.attached).toHaveLength(0);
  });

  it('keeps a traversal filename inside the staging root and renames it', async () => {
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: '../../../../etc/cron.d/evil', sizeBytes: 2 },
    });
    expect(init.body['name']).toBe('evil');
    const uploadId = init.body['uploadId'] as string;
    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: new Uint8Array([1, 2]) });
    await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
    await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: [uploadId] },
    });
    const path = harness.attached[0]?.paths[0] as string;
    expect(path.startsWith(harness.root)).toBe(true);
    expect(path.endsWith('evil')).toBe(true);
  });

  it('never returns a filesystem path to the caller', async () => {
    // A returned path is both an information leak and an invitation to
    // send one back. Neither the completion reply nor the attach reply
    // carries one.
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a.txt', sizeBytes: 1 },
    });
    const uploadId = init.body['uploadId'] as string;
    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: new Uint8Array([1]) });
    const done = await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
    const set = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: [uploadId] },
    });
    for (const body of [init.body, done.body, set.body]) {
      expect(JSON.stringify(body)).not.toContain(harness.root);
      expect(JSON.stringify(body)).not.toContain(tmpdir());
    }
  });
});

describe('capability gating', () => {
  // control and navigate are what a driving token carries. Neither
  // implies the right to put a document into a form.
  const DRIVING: readonly Capability[] = ['view', 'control', 'navigate', 'capture'];

  it('refuses every JSON upload route without the upload capability', async () => {
    for (const [method, path, body] of [
      ['POST', '/v1/upload/init', { name: 'a', sizeBytes: 1 }],
      ['GET', '/v1/upload/x', undefined],
      ['POST', '/v1/upload/x/complete', {}],
      ['DELETE', '/v1/upload/x', undefined],
      ['POST', '/v1/instances/inst_1/targets/tgt_1/files', { selector: '#f', uploadIds: ['x'] }],
    ] as const) {
      const res = await call(harness, method, path, {
        caps: DRIVING,
        ...(body !== undefined ? { body } : {}),
      });
      expect({ path, status: res.status }).toEqual({ path, status: 403 });
    }
  });

  it('refuses the chunk route without the upload capability', async () => {
    const res = await call(harness, 'PUT', '/v1/upload/x', {
      caps: ['control'],
      raw: new Uint8Array([1]),
    });
    expect(res.status).toBe(403);
  });

  it('allows an upload token, and only an upload token', async () => {
    const res = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a', sizeBytes: 0 },
    });
    expect(res.status).toBe(201);
  });
});

describe('validation and honest failures', () => {
  it('requires name and sizeBytes on init', async () => {
    expect(
      (await call(harness, 'POST', '/v1/upload/init', { body: { sizeBytes: 1 } })).status,
    ).toBe(400);
    expect((await call(harness, 'POST', '/v1/upload/init', { body: { name: 'a' } })).status).toBe(
      400,
    );
  });

  it('maps the store refusals onto honest HTTP statuses', async () => {
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a.bin', sizeBytes: 4 },
    });
    const uploadId = init.body['uploadId'] as string;

    // Over the declared size: 413, not a generic 500.
    const over = await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: new Uint8Array(5) });
    expect(over.status).toBe(413);

    // Short: 400 with a code naming what is wrong.
    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: new Uint8Array(2) });
    const short = await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, { body: {} });
    expect(short.status).toBe(400);
    expect(short.body['error']).toMatchObject({ code: 'E_UPLOAD_SIZE_MISMATCH' });

    // Unknown id: 404.
    expect((await call(harness, 'GET', '/v1/upload/nope')).status).toBe(404);
  });

  it('refuses to attach an upload that was never completed, as a 409 rather than a 500', async () => {
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a.bin', sizeBytes: 4 },
    });
    const res = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: [init.body['uploadId']] },
    });
    expect(res.status).toBe(409);
    expect(res.body['error']).toMatchObject({ code: 'E_UPLOAD_NOT_READY' });
  });

  it('rejects a hash mismatch and discards the bytes', async () => {
    const init = await call(harness, 'POST', '/v1/upload/init', {
      body: { name: 'a.bin', sizeBytes: 2 },
    });
    const uploadId = init.body['uploadId'] as string;
    await call(harness, 'PUT', `/v1/upload/${uploadId}`, { raw: new Uint8Array([1, 2]) });
    const bad = await call(harness, 'POST', `/v1/upload/${uploadId}/complete`, {
      body: { sha256: 'f'.repeat(64) },
    });
    expect(bad.status).toBe(400);
    expect((await call(harness, 'GET', `/v1/upload/${uploadId}`)).status).toBe(404);
  });

  it('answers 503, not 501, when no staging area is wired', async () => {
    // These routes used to be blind 501 stubs. A gateway that has the
    // feature but no store wired is a different, honest condition.
    const noStore = await buildHarness({ withUploads: false });
    try {
      const res = await call(noStore, 'POST', '/v1/upload/init', {
        body: { name: 'a', sizeBytes: 1 },
      });
      expect(res.status).toBe(503);
      expect(res.body['error']).toMatchObject({ code: 'E_UPLOADS_UNAVAILABLE' });
    } finally {
      await noStore.uploads.dispose();
      await rm(noStore.root, { recursive: true, force: true });
    }
  });

  it('no longer answers 501 for any upload route', async () => {
    for (const [method, path] of [
      ['POST', '/v1/upload/init'],
      ['GET', '/v1/upload/x'],
      ['POST', '/v1/upload/x/complete'],
      ['DELETE', '/v1/upload/x'],
      ['PUT', '/v1/upload/x'],
    ] as const) {
      const res = await call(harness, method, path, { body: { name: 'a', sizeBytes: 1 } });
      expect({ path, is501: res.status === 501 }).toEqual({ path, is501: false });
    }
  });
});

describe('multiple files', () => {
  it('attaches several uploads in the order given', async () => {
    const ids: string[] = [];
    for (const name of ['first.txt', 'second.txt', 'third.txt']) {
      ids.push(await stageViaRest(harness, name, new Uint8Array([1])));
    }
    const res = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#many', uploadIds: ids },
    });
    expect(res.body['files']).toEqual(['first.txt', 'second.txt', 'third.txt']);
    expect(harness.attached[0]?.paths).toHaveLength(3);
  });

  it('refuses an empty uploadIds array rather than clearing the input', async () => {
    const res = await call(harness, 'POST', '/v1/instances/inst_1/targets/tgt_1/files', {
      body: { selector: '#f', uploadIds: [] },
    });
    expect(res.status).toBe(400);
  });
});
