/**
 * `cdp/file-input.ts`. A scripted fake `CdpBridge` rather than a real
 * browser: what matters here is the exact sequence of CDP commands and the
 * refusals, both of which are fully determined by the four replies the
 * bridge gives back.
 */

import { describe, expect, it } from 'vitest';
import type { CdpBridge } from '../../src/cdp/bridge.js';
import { FileInputError, setFileInputFiles } from '../../src/cdp/file-input.js';
import type { CdpSessionId } from '../../src/cdp/types.js';

interface Sent {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A `CdpBridge` that records every `send` and answers from `replies`. Only `send` is implemented; nothing in this module touches anything else. */
function fakeBridge(replies: Readonly<Record<string, unknown>>): {
  bridge: CdpBridge;
  sent: Sent[];
} {
  const sent: Sent[] = [];
  const bridge = {
    async send(method: string, params?: Record<string, unknown>): Promise<unknown> {
      sent.push({ method, params: params ?? {} });
      if (!(method in replies)) throw new Error(`unexpected CDP method ${method}`);
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply;
    },
  } as unknown as CdpBridge;
  return { bridge, sent };
}

const SESSION = 'cdpsess_1' as CdpSessionId;

/** `DOM.describeNode`'s flat `[name, value, ...]` attribute shape. */
function fileInputNode(attrs: readonly string[] = ['type', 'file']): unknown {
  return { node: { nodeName: 'INPUT', attributes: [...attrs] } };
}

describe('setFileInputFiles', () => {
  it('resolves the element and attaches, in the documented order', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': fileInputNode(),
      'DOM.setFileInputFiles': {},
    });

    await setFileInputFiles(bridge, SESSION, {
      selector: '#attachment',
      files: ['/srv/staging/abc/report.pdf'],
    });

    expect(sent.map((s) => s.method)).toEqual([
      'DOM.getDocument',
      'DOM.querySelector',
      'DOM.describeNode',
      'DOM.setFileInputFiles',
    ]);
    // `depth: 0` so Chrome does not serialise the whole tree back for a
    // call that only needs the root's id.
    expect(sent[0]?.params).toEqual({ depth: 0 });
    expect(sent[1]?.params).toEqual({ nodeId: 1, selector: '#attachment' });
    expect(sent[3]?.params).toEqual({ nodeId: 42, files: ['/srv/staging/abc/report.pdf'] });
  });

  it('never touches the Runtime domain', async () => {
    // Attaching a file must not require, or quietly grant, arbitrary
    // script execution in the page.
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': fileInputNode(),
      'DOM.setFileInputFiles': {},
    });
    await setFileInputFiles(bridge, SESSION, { selector: 'input', files: ['/a'] });
    expect(sent.every((s) => s.method.startsWith('DOM.'))).toBe(true);
  });

  it('reports a nodeId of 0 as no match, since CDP does not treat it as an error', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 0 },
    });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#nope', files: ['/a'] }),
    ).rejects.toMatchObject({
      code: 'E_FILE_INPUT',
      reason: 'no_match',
    });
    // Nothing was attached anywhere.
    expect(sent.some((s) => s.method === 'DOM.setFileInputFiles')).toBe(false);
  });

  it('names the iframe and shadow-root limitation in the no-match message', async () => {
    const { bridge } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': {},
    });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#nope', files: ['/a'] }),
    ).rejects.toThrow(/iframe/);
  });

  it('refuses an element that is not a file input, before sending the command', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': { node: { nodeName: 'DIV', attributes: [] } },
    });
    const err = await setFileInputFiles(bridge, SESSION, {
      selector: '.dropzone',
      files: ['/a'],
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FileInputError);
    expect((err as FileInputError).reason).toBe('not_a_file_input');
    // The whole point of the describeNode round trip: the caller gets
    // their own selector back and what it actually matched, not a bare
    // CDP protocol error.
    expect((err as FileInputError).message).toContain('.dropzone');
    expect((err as FileInputError).message).toContain('div');
    expect(sent.some((s) => s.method === 'DOM.setFileInputFiles')).toBe(false);
  });

  it('refuses a text input, which is the likeliest wrong selector', async () => {
    const { bridge } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': { node: { nodeName: 'INPUT', attributes: ['type', 'text'] } },
    });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#name', files: ['/a'] }),
    ).rejects.toMatchObject({
      reason: 'not_a_file_input',
    });
  });

  it('refuses several files for an input without "multiple" rather than silently dropping all but one', async () => {
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': fileInputNode(),
    });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#one', files: ['/a', '/b'] }),
    ).rejects.toMatchObject({
      reason: 'not_multiple',
    });
    expect(sent.some((s) => s.method === 'DOM.setFileInputFiles')).toBe(false);
  });

  it('accepts several files when "multiple" is present, including as a bare attribute', async () => {
    // `multiple` in HTML is usually written with no value at all, which
    // CDP reports as an empty-string value, not as an absent attribute.
    const { bridge, sent } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': fileInputNode(['type', 'file', 'multiple', '']),
      'DOM.setFileInputFiles': {},
    });
    await setFileInputFiles(bridge, SESSION, { selector: '#many', files: ['/a', '/b'] });
    expect(sent[3]?.params).toEqual({ nodeId: 42, files: ['/a', '/b'] });
  });

  it('is case insensitive about the type attribute, as HTML is', async () => {
    const { bridge } = fakeBridge({
      'DOM.getDocument': { root: { nodeId: 1 } },
      'DOM.querySelector': { nodeId: 42 },
      'DOM.describeNode': { node: { nodeName: 'input', attributes: ['TYPE', 'FILE'] } },
      'DOM.setFileInputFiles': {},
    });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#r', files: ['/a'] }),
    ).resolves.toBeUndefined();
  });

  it('refuses when the document itself cannot be resolved', async () => {
    const { bridge } = fakeBridge({ 'DOM.getDocument': {} });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#r', files: ['/a'] }),
    ).rejects.toMatchObject({
      reason: 'no_match',
    });
  });

  it('lets a genuine CDP failure propagate unchanged rather than relabelling it', async () => {
    const boom = new Error('Session closed. Most likely the page has been closed.');
    const { bridge } = fakeBridge({ 'DOM.getDocument': boom });
    await expect(
      setFileInputFiles(bridge, SESSION, { selector: '#r', files: ['/a'] }),
    ).rejects.toBe(boom);
  });
});
