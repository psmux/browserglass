import { describe, expect, it } from 'vitest';
import { MAX_A11Y_RESULT_BYTES } from '../../src/wire/messages/a11y.js';
import { MAX_EVALUATE_RESULT_BYTES } from '../../src/wire/messages/evaluate.js';
import {
  MAX_PAGEMAP_RESULT_BYTES,
  PAGE_MAP_ATTRIBUTES,
  type PageMapGot,
  type PageMapNode,
  type PageMapStamp,
  type PageMapStamped,
} from '../../src/wire/messages/pagemap.js';

/**
 * `MAX_PAGEMAP_RESULT_BYTES` is defined as `MAX_A11Y_RESULT_BYTES * 2`
 * rather than a repeated literal, so this is the check that the derived
 * relationship (double the
 * accessibility ceiling, half the evaluate ceiling) actually holds and
 * cannot silently drift if either sibling constant changes.
 */
describe('MAX_PAGEMAP_RESULT_BYTES', () => {
  it('is double the a11y ceiling', () => {
    expect(MAX_PAGEMAP_RESULT_BYTES).toBe(MAX_A11Y_RESULT_BYTES * 2);
  });

  it('is half the evaluate ceiling', () => {
    expect(MAX_PAGEMAP_RESULT_BYTES).toBe(MAX_EVALUATE_RESULT_BYTES / 2);
  });
});

/**
 * A `page.map.got` reply's `nodes`/`total`/`truncated`/`truncatedByReason`/
 * `degraded` group is present exactly when `include` asked for `'nodes'`,
 * and ABSENT rather than empty when it did not, so a caller that asked for
 * `include: ['text']` alone never reads a false "zero interactive
 * elements" out of a capture that never ran the node pipeline at all.
 */
describe('PageMapGot node fields are absent, not empty, when nodes were not requested', () => {
  it('round trips a text-only reply with no node fields', () => {
    const msg: PageMapGot = {
      v: 1,
      t: 'page.map.got',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      epoch: 'sess_abc:loader_123',
      text: [{ kind: 'heading', text: 'Example', level: 1 }],
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PageMapGot;
    expect('nodes' in roundTripped).toBe(false);
    expect('total' in roundTripped).toBe(false);
    expect('truncated' in roundTripped).toBe(false);
    expect('truncatedByReason' in roundTripped).toBe(false);
    expect('degraded' in roundTripped).toBe(false);
    expect(roundTripped.text).toEqual([{ kind: 'heading', text: 'Example', level: 1 }]);
  });

  it('round trips a nodes reply with truncation reported by reason, never silently', () => {
    const node: PageMapNode = {
      index: 4711,
      tag: 'button',
      role: 'button',
      name: 'Submit',
      rect: { x: 10, y: 20, w: 80, h: 30 },
      inViewport: true,
      occluded: false,
      attributes: { id: 'submit-btn', type: 'submit' },
    };
    const msg: PageMapGot = {
      v: 1,
      t: 'page.map.got',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      epoch: 'sess_abc:loader_123',
      nodes: [node],
      total: 401,
      truncated: true,
      truncatedByReason: { offscreen: 400, onscreen: 0 },
      degraded: { framesAttempted: 1, framesFailed: 0, failures: [] },
    };
    const roundTripped = JSON.parse(JSON.stringify(msg)) as PageMapGot;
    expect(roundTripped.nodes).toEqual([node]);
    expect(roundTripped.total).toBe(401);
    expect(roundTripped.truncated).toBe(true);
    expect(roundTripped.truncatedByReason).toEqual({ offscreen: 400, onscreen: 0 });
    expect(roundTripped.degraded?.framesFailed).toBe(0);
  });
});

/**
 * `PageMapNode.role`/`name` degrade to `null` independently of `tag`,
 * `rect` and `attributes`, which is the exact contract for a frame whose accessibility read
 * failed (see "Accessibility degradation" in `docs/page-map.md`).
 */
describe('PageMapNode role/name degradation', () => {
  it('keeps tag, rect and attributes when role/name are null', () => {
    const node: PageMapNode = {
      index: 99,
      tag: 'div',
      role: null,
      name: null,
      rect: { x: 0, y: 0, w: 10, h: 10 },
      inViewport: false,
      occluded: null,
      attributes: {},
    };
    const roundTripped = JSON.parse(JSON.stringify(node)) as PageMapNode;
    expect(roundTripped.role).toBeNull();
    expect(roundTripped.name).toBeNull();
    expect(roundTripped.tag).toBe('div');
    expect(roundTripped.rect).toEqual({ x: 0, y: 0, w: 10, h: 10 });
  });
});

describe('PageMapAttributes carries only the fixed subset', () => {
  it('every declared key is one of PAGE_MAP_ATTRIBUTES', () => {
    const node: PageMapNode = {
      index: 1,
      tag: 'a',
      role: 'link',
      name: 'Home',
      rect: { x: 0, y: 0, w: 1, h: 1 },
      inViewport: true,
      occluded: null,
      attributes: { href: '/home', id: 'nav-home' },
    };
    for (const key of Object.keys(node.attributes)) {
      expect(PAGE_MAP_ATTRIBUTES).toContain(key);
    }
  });
});

/** `page.map.stamp` / `page.map.stamped`: per-index results, never a batch failure over one detached node. */
describe('PageMapStamp / PageMapStamped', () => {
  it('reports one result per requested index, including a per-node failure reason', () => {
    const stamp: PageMapStamp = {
      v: 1,
      t: 'page.map.stamp',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      epoch: 'sess_abc:loader_123',
      indices: [4711, 4712],
    };
    const stamped: PageMapStamped = {
      v: 1,
      t: 'page.map.stamped',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      results: [
        { index: 4711, stamped: true },
        { index: 4712, stamped: false, reason: 'detached' },
      ],
      marker: 'data-bgls-map-9f2c',
    };
    expect(stamp.indices).toHaveLength(2);
    const roundTripped = JSON.parse(JSON.stringify(stamped)) as PageMapStamped;
    expect(roundTripped.results).toEqual([
      { index: 4711, stamped: true },
      { index: 4712, stamped: false, reason: 'detached' },
    ]);
    expect(roundTripped.marker).toBe('data-bgls-map-9f2c');
  });

  it('marker is null, not omitted, when nothing was actually stamped', () => {
    const stamped: PageMapStamped = {
      v: 1,
      t: 'page.map.stamped',
      ts: Date.now(),
      targetId: 'tgt_00000000000000000000000001',
      results: [{ index: 4711, stamped: false, reason: 'detached' }],
      marker: null,
    };
    const roundTripped = JSON.parse(JSON.stringify(stamped)) as PageMapStamped;
    expect(roundTripped.marker).toBeNull();
    expect('marker' in roundTripped).toBe(true);
  });
});
