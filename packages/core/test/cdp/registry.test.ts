import { describe, expect, it, vi } from 'vitest';
import type { ProxyAuthCredentials } from '../../src/cdp/proxy-auth.js';
import {
  type StealthProfileHooks,
  TargetRegistryImpl,
  assertStreamable,
} from '../../src/cdp/target-registry.js';
import { classifyTarget } from '../../src/cdp/target-types.js';
import type { FakeCdpWebSocket } from './fake-cdp-endpoint.js';
import { connectFakeBridgeReconnectable, startFakeRegistry } from './test-helpers.js';

describe('classifyTarget', () => {
  it('classifies an ordinary page as streamable and in the tab list', () => {
    const c = classifyTarget('page', 'https://example.com/');
    expect(c).toEqual({ type: 'page', autoAttach: true, streamable: true, inTabList: true });
  });

  it('classifies a chrome-extension:// page as other, not streamable, not in the tab list', () => {
    const c = classifyTarget('page', 'chrome-extension://abcdefgh/popup.html');
    expect(c).toEqual({ type: 'other', autoAttach: false, streamable: false, inTabList: false });
  });

  it('classifies a devtools:// page as other', () => {
    const c = classifyTarget('page', 'devtools://devtools/bundled/inspector.html');
    expect(c.type).toBe('other');
    expect(c.streamable).toBe(false);
  });

  it('classifies an iframe as streamable but not in the tab list', () => {
    const c = classifyTarget('iframe', 'https://example.com/frame');
    expect(c).toEqual({ type: 'iframe', autoAttach: false, streamable: true, inTabList: false });
  });

  it('classifies a service_worker as not streamable, not in the tab list', () => {
    const c = classifyTarget('service_worker', 'https://example.com/sw.js');
    expect(c.type).toBe('service_worker');
    expect(c.streamable).toBe(false);
    expect(c.inTabList).toBe(false);
  });

  it('classifies an unrecognised type as other', () => {
    const c = classifyTarget('auction_worklet', 'https://example.com');
    expect(c.type).toBe('other');
  });
});

describe('assertStreamable', () => {
  it('does not throw for a streamable target', () => {
    expect(() => assertStreamable({ id: 'tgt_x' as never, streamable: true })).not.toThrow();
  });

  it('throws E_NOT_STREAMABLE for a non-streamable target', () => {
    try {
      assertStreamable({ id: 'tgt_x' as never, streamable: false });
      throw new Error('expected assertStreamable to throw');
    } catch (err) {
      expect((err as { code: string }).code).toBe('E_NOT_STREAMABLE');
    }
  });
});

describe('TargetRegistry.resync', () => {
  it('starts empty when the world has no targets', async () => {
    const { registry } = await startFakeRegistry();
    expect(registry.all()).toHaveLength(0);
  });

  it('reports added, removed, and changed correctly across a diverged world', async () => {
    const { registry, world } = await startFakeRegistry();

    world.targetInfos.push(
      { targetId: 'T1', type: 'page', title: 'One', url: 'https://one.example', attached: false },
      { targetId: 'T2', type: 'page', title: 'Two', url: 'https://two.example', attached: false },
    );
    const firstDiff = await registry.resync();
    expect(firstDiff).toEqual({ added: 2, removed: 0, changed: 0 });
    expect(registry.all()).toHaveLength(2);

    // T1 changes title, T2 is removed, T3 is added.
    world.targetInfos[0] = { ...world.targetInfos[0]!, title: 'One renamed' };
    world.targetInfos.splice(1, 1);
    world.targetInfos.push({
      targetId: 'T3',
      type: 'page',
      title: 'Three',
      url: 'https://three.example',
      attached: false,
    });

    const secondDiff = await registry.resync();
    expect(secondDiff).toEqual({ added: 1, removed: 1, changed: 1 });

    const remainingIds = registry
      .all()
      .map((t) => t.cdpTargetId)
      .sort();
    expect(remainingIds).toEqual(['T1', 'T3']);

    const t1 = registry.all().find((t) => t.cdpTargetId === 'T1');
    expect(t1?.title).toBe('One renamed');
  });

  it('mints a stable tgt_ id on first sighting and keeps it across resync updates', async () => {
    const { registry, world } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'One',
      url: 'https://one.example',
      attached: false,
    });
    await registry.resync();
    const first = registry.all()[0];
    expect(first?.id).toMatch(/^tgt_/);

    world.targetInfos[0] = { ...world.targetInfos[0]!, title: 'One updated' };
    await registry.resync();
    const second = registry.all()[0];
    expect(second?.id).toBe(first?.id);
    expect(second?.cdpTargetId).toBe('T1');
  });
});

describe('TargetRegistry.tabs vs all', () => {
  it('tabs() excludes extension pages that all() includes', async () => {
    const { registry, world } = await startFakeRegistry();
    world.targetInfos.push(
      { targetId: 'T1', type: 'page', title: 'Tab', url: 'https://example.com', attached: false },
      {
        targetId: 'T2',
        type: 'page',
        title: 'Ext',
        url: 'chrome-extension://abc/popup.html',
        attached: false,
      },
    );
    await registry.resync();

    expect(registry.all()).toHaveLength(2);
    const tabIds = registry.tabs().map((t) => t.cdpTargetId);
    expect(tabIds).toEqual(['T1']);
  });
});

describe('TargetRegistry attach delegation', () => {
  it('attach() delegates to CdpBridge.sessionFor and stamps cdpSessionId', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    const handle = await registry.attach(target.id);

    expect(handle.targetId).toBe('T1');
    expect(target.attached).toBe(true);
    expect(target.cdpSessionId).toBe(handle.id);
    expect(socket.allSent('Target.attachToTarget')).toHaveLength(1);
  });
});

describe('TargetRegistry destroy dedupe', () => {
  it('a duplicate Target.targetDestroyed for the same target only emits closed once', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    await registry.resync();

    let closedCount = 0;
    registry.on('closed', () => {
      closedCount += 1;
    });

    socket.emitEvent('Target.targetDestroyed', { targetId: 'T1' });
    socket.emitEvent('Target.targetDestroyed', { targetId: 'T1' });

    expect(closedCount).toBe(1);
    expect(registry.get('tgt_does_not_exist' as never)).toBeUndefined();
    expect(registry.all()).toHaveLength(0);
  });
});

describe('TargetRegistry.create newWindow', () => {
  it('passes newWindow: true through to Target.createTarget when requested', async () => {
    const { registry, socket } = await startFakeRegistry();
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Target.createTarget') {
        s.emitResult(msg.id, { targetId: 'NEWT1' });
        return;
      }
      if (msg.method === 'Target.getTargetInfo') {
        s.emitResult(msg.id, {
          targetInfo: {
            targetId: 'NEWT1',
            type: 'page',
            title: '',
            url: 'https://example.com',
            attached: false,
          },
        });
        return;
      }
      defaultRespond?.(msg, s);
    };

    const target = await registry.create({ url: 'https://example.com', newWindow: true });

    expect(target.cdpTargetId).toBe('NEWT1');
    const sent = socket.lastSent('Target.createTarget');
    expect(sent?.params?.['newWindow']).toBe(true);
  });

  it('omits newWindow from Target.createTarget when not requested', async () => {
    const { registry, socket } = await startFakeRegistry();
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Target.createTarget') {
        s.emitResult(msg.id, { targetId: 'NEWT2' });
        return;
      }
      if (msg.method === 'Target.getTargetInfo') {
        s.emitResult(msg.id, {
          targetInfo: {
            targetId: 'NEWT2',
            type: 'page',
            title: '',
            url: 'https://example.com',
            attached: false,
          },
        });
        return;
      }
      defaultRespond?.(msg, s);
    };

    await registry.create({ url: 'https://example.com' });

    const sent = socket.lastSent('Target.createTarget');
    expect(sent?.params && 'newWindow' in sent.params).toBe(false);
  });
});

describe('TargetRegistry.windowIdFor', () => {
  it('caches a successful result, sending Browser.getWindowForTarget only once', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    let calls = 0;
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Browser.getWindowForTarget') {
        calls += 1;
        s.emitResult(msg.id, { windowId: 7 });
        return;
      }
      defaultRespond?.(msg, s);
    };

    const first = await registry.windowIdFor(target.id);
    const second = await registry.windowIdFor(target.id);

    expect(first).toBe(7);
    expect(second).toBe(7);
    expect(calls).toBe(1);
    expect(target.windowId).toBe(7);
  });

  it('resolves null and never throws when Browser.getWindowForTarget fails', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Browser.getWindowForTarget') {
        s.emitError(msg.id, { code: -32000, message: 'No window found for target' });
        return;
      }
      defaultRespond?.(msg, s);
    };

    await expect(registry.windowIdFor(target.id)).resolves.toBeNull();
    expect(target.windowId).toBeNull();
  });
});

describe('TargetRegistry.targetsInWindow', () => {
  it('returns only the live targets in the given window, in tab order', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push(
      { targetId: 'T1', type: 'page', title: 'a', url: 'https://a.example', attached: false },
      { targetId: 'T2', type: 'page', title: 'b', url: 'https://b.example', attached: false },
      { targetId: 'T3', type: 'page', title: 'c', url: 'https://c.example', attached: false },
    );
    await registry.resync();
    const [t1, t2, t3] = registry.all();
    t1!.windowId = 100;
    t2!.windowId = 200;
    t3!.windowId = 100;

    expect(registry.targetsInWindow(100).map((t) => t.cdpTargetId)).toEqual(['T1', 'T3']);
    expect(registry.targetsInWindow(200).map((t) => t.cdpTargetId)).toEqual(['T2']);
    expect(registry.targetsInWindow(999)).toEqual([]);

    socket.emitEvent('Target.targetCrashed', { targetId: 'T1' });
    expect(registry.targetsInWindow(100).map((t) => t.cdpTargetId)).toEqual(['T3']);
  });
});

describe('TargetRegistry init scripts', () => {
  const GATE_SCRIPT = {
    name: 'gate',
    source: 'window.HTMLFormElement.prototype.submit = () => {};',
  };

  it('attach() installs every configured init script on the new session, in order, before returning', async () => {
    const { registry, world, socket } = await startFakeRegistry([GATE_SCRIPT]);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    const handle = await registry.attach(target.id);

    const sent = socket.allSent('Page.addScriptToEvaluateOnNewDocument');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.sessionId).toBe(handle.id);
    expect(sent[0]?.params).toEqual({ source: GATE_SCRIPT.source });
    expect(target.scriptIdentifiers).toEqual(['SCRIPT_1']);
  });

  it('a target with no configured init scripts sends no Page.addScriptToEvaluateOnNewDocument at all', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    expect(socket.allSent('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(0);
    expect(target.scriptIdentifiers).toEqual([]);
  });

  it('the auto-attach path installs init scripts BEFORE releasing the paused renderer via Runtime.runIfWaitingForDebugger', async () => {
    const { registry, socket } = await startFakeRegistry([GATE_SCRIPT]);

    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: {
        targetId: 'T1',
        type: 'page',
        title: '',
        url: 'https://a.example',
        attached: true,
      },
      sessionId: 'S1',
      waitingForDebugger: true,
    });
    // `handleAttachedToTarget` awaits its own CDP round trips synchronously
    // within one microtask chain against this fake bridge (every response
    // is emitted synchronously from `send`), so by the time this line runs
    // the whole handler, `finally` included, has settled.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const scriptSent = socket.lastSent('Page.addScriptToEvaluateOnNewDocument');
    const resumeSent = socket.lastSent('Runtime.runIfWaitingForDebugger');
    expect(scriptSent).toBeDefined();
    expect(resumeSent).toBeDefined();
    expect(socket.sent.indexOf(scriptSent!)).toBeLessThan(socket.sent.indexOf(resumeSent!));

    const target = registry.all().find((t) => t.cdpTargetId === 'T1');
    expect(target?.scriptIdentifiers).toEqual(['SCRIPT_1']);
  });

  it('a cross origin navigation (new Target.attachedToTarget, fresh session, same target) reinstalls the init script rather than leaving it silently off', async () => {
    const { registry, socket } = await startFakeRegistry([GATE_SCRIPT]);

    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: {
        targetId: 'T1',
        type: 'page',
        title: '',
        url: 'https://a.example',
        attached: true,
      },
      sessionId: 'S1',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    const target = registry.all().find((t) => t.cdpTargetId === 'T1')!;
    expect(target.scriptIdentifiers).toEqual(['SCRIPT_1']);

    // Chrome's own sequence for a cross origin navigation: the old
    // renderer's session detaches, then a fresh one attaches for the SAME
    // target id (`session.ts`'s `rebuildCaptureAndDiagnostics` doc comment
    // describes the identical event pair for diagnostics/the request gate).
    socket.emitEvent('Target.detachedFromTarget', { targetId: 'T1', sessionId: 'S1' });
    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: { targetId: 'T1', type: 'page', title: '', url: 'https://b.example' },
      sessionId: 'S2',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const sent = socket.allSent('Page.addScriptToEvaluateOnNewDocument');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.sessionId).toBe('S1');
    expect(sent[1]?.sessionId).toBe('S2');
    // The script is installed again, under a NEW identifier issued on the
    // new session, not the stale one from the session Chrome already tore
    // down: the gate is still armed after the navigation, which is the
    // whole point.
    expect(target.scriptIdentifiers).toEqual(['SCRIPT_2']);
  });

  it('handleAttachedToTarget does not double-install when it somehow reaches the same target and session twice', async () => {
    const { socket } = await startFakeRegistry([GATE_SCRIPT]);
    const attach = () =>
      socket.emitEvent('Target.attachedToTarget', {
        targetInfo: {
          targetId: 'T1',
          type: 'page',
          title: '',
          url: 'https://a.example',
          attached: true,
        },
        sessionId: 'S1',
        waitingForDebugger: true,
      });

    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.allSent('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
  });

  it('removeInitScripts removes every tracked identifier on the live session and clears the array', async () => {
    const { registry, world, socket } = await startFakeRegistry([GATE_SCRIPT]);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;
    const handle = await registry.attach(target.id);
    expect(target.scriptIdentifiers).toEqual(['SCRIPT_1']);

    await registry.removeInitScripts(target.id);

    const removed = socket.lastSent('Page.removeScriptToEvaluateOnNewDocument');
    expect(removed?.sessionId).toBe(handle.id);
    expect(removed?.params).toEqual({ identifier: 'SCRIPT_1' });
    expect(target.scriptIdentifiers).toEqual([]);
  });

  it('removeInitScripts is a no-op, never throwing, for a target with no init scripts installed', async () => {
    const { registry, world } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await expect(registry.removeInitScripts(target.id)).resolves.toBeUndefined();
    expect(target.scriptIdentifiers).toEqual([]);
  });

  it('a worker target never gets an init script installed', async () => {
    const { registry, world, socket } = await startFakeRegistry([GATE_SCRIPT]);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'worker',
      title: 'a',
      url: 'https://a.example/worker.js',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    expect(socket.allSent('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(0);
  });
});

describe('TargetRegistry stealth profile hooks', () => {
  const STEALTH_SCRIPT = {
    name: 'stealth:navigator-webdriver',
    source: 'Object.defineProperty(navigator, "webdriver", { get: () => undefined });',
  };
  const SPEC_SCRIPT = {
    name: 'spec-gate',
    source: 'window.HTMLFormElement.prototype.submit = () => {};',
  };

  it('installs the stealth profile init script BEFORE spec.initScripts, in one installInitScripts pass', async () => {
    const stealth: StealthProfileHooks = {
      initScripts: [STEALTH_SCRIPT],
      onTargetAttached: vi.fn(async () => {}),
    };
    const { registry, world, socket } = await startFakeRegistry([SPEC_SCRIPT], stealth);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    const sent = socket.allSent('Page.addScriptToEvaluateOnNewDocument');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.params).toEqual({ source: STEALTH_SCRIPT.source });
    expect(sent[1]?.params).toEqual({ source: SPEC_SCRIPT.source });
    expect(target.scriptIdentifiers).toEqual(['SCRIPT_1', 'SCRIPT_2']);
  });

  it('calls onTargetAttached once for a newly attached page target, after init scripts are installed on its session', async () => {
    let scriptCountAtCall = -1;
    const onTargetAttached = vi.fn(async () => {
      scriptCountAtCall = socket.allSent('Page.addScriptToEvaluateOnNewDocument').length;
    });
    const stealth: StealthProfileHooks = { initScripts: [STEALTH_SCRIPT], onTargetAttached };
    const { socket } = await startFakeRegistry([], stealth);

    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: {
        targetId: 'T1',
        type: 'page',
        title: '',
        url: 'https://a.example',
        attached: true,
      },
      sessionId: 'S1',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTargetAttached).toHaveBeenCalledTimes(1);
    const ctx = onTargetAttached.mock.calls[0]?.[0];
    expect(ctx).toMatchObject({ cdpSessionId: 'S1', targetId: 'T1' });
    expect(typeof ctx.evaluate).toBe('function');
    expect(typeof ctx.send).toBe('function');
    // The init script for this session was already sent by the time
    // onTargetAttached ran, per handleAttachedToTarget's own ordering.
    expect(scriptCountAtCall).toBe(1);
  });

  it('does not call onTargetAttached a second time for the same target and session', async () => {
    const onTargetAttached = vi.fn(async () => {});
    const stealth: StealthProfileHooks = { initScripts: [], onTargetAttached };
    const { socket } = await startFakeRegistry([], stealth);
    const attach = () =>
      socket.emitEvent('Target.attachedToTarget', {
        targetInfo: {
          targetId: 'T1',
          type: 'page',
          title: '',
          url: 'https://a.example',
          attached: true,
        },
        sessionId: 'S1',
        waitingForDebugger: true,
      });

    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTargetAttached).toHaveBeenCalledTimes(1);
  });

  it('calls onTargetAttached again on a cross origin navigation (fresh session, same target)', async () => {
    const onTargetAttached = vi.fn(async () => {});
    const stealth: StealthProfileHooks = { initScripts: [], onTargetAttached };
    const { socket } = await startFakeRegistry([], stealth);

    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: {
        targetId: 'T1',
        type: 'page',
        title: '',
        url: 'https://a.example',
        attached: true,
      },
      sessionId: 'S1',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    socket.emitEvent('Target.detachedFromTarget', { targetId: 'T1', sessionId: 'S1' });
    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: { targetId: 'T1', type: 'page', title: '', url: 'https://b.example' },
      sessionId: 'S2',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(onTargetAttached).toHaveBeenCalledTimes(2);
    expect(onTargetAttached.mock.calls[0]?.[0]).toMatchObject({ cdpSessionId: 'S1' });
    expect(onTargetAttached.mock.calls[1]?.[0]).toMatchObject({ cdpSessionId: 'S2' });
  });

  it('never calls onTargetAttached for a worker target', async () => {
    const onTargetAttached = vi.fn(async () => {});
    const stealth: StealthProfileHooks = { initScripts: [], onTargetAttached };
    const { registry, world } = await startFakeRegistry([], stealth);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'worker',
      title: 'a',
      url: 'https://a.example/worker.js',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    expect(onTargetAttached).not.toHaveBeenCalled();
  });

  it("a target attach still completes, and its own init scripts still install, when the stealth profile's onTargetAttached throws", async () => {
    const onTargetAttached = vi.fn(async () => {
      throw new Error('profile bug');
    });
    const stealth: StealthProfileHooks = { initScripts: [STEALTH_SCRIPT], onTargetAttached };
    const { registry, world, socket } = await startFakeRegistry([], stealth);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await expect(registry.attach(target.id)).resolves.toBeDefined();
    expect(socket.allSent('Page.addScriptToEvaluateOnNewDocument')).toHaveLength(1);
    expect(onTargetAttached).toHaveBeenCalledTimes(1);
  });

  it('createTargetRegistry with no stealth argument behaves exactly as before: no onTargetAttached call, no extra init scripts', async () => {
    const { registry, world, socket } = await startFakeRegistry([SPEC_SCRIPT]);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    const sent = socket.allSent('Page.addScriptToEvaluateOnNewDocument');
    expect(sent).toHaveLength(1);
    expect(sent[0]?.params).toEqual({ source: SPEC_SCRIPT.source });
  });
});

describe('TargetRegistry proxy auth (installProxyAuth)', () => {
  const CREDS: ProxyAuthCredentials = { username: 'proxy-user', password: 'hunter2-super-secret' };

  it('arms proxy auth on the session attach() returns, with a Request-stage catchall and handleAuthRequests: true', async () => {
    const { registry, world, socket } = await startFakeRegistry([], null, undefined, CREDS);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    const handle = await registry.attach(target.id);

    const enable = socket.lastSent('Fetch.enable');
    expect(enable?.sessionId).toBe(handle.id);
    expect(enable?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });
  });

  it('a registry built with no proxy credentials never sends Fetch.enable at all', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    expect(socket.allSent('Fetch.enable')).toHaveLength(0);
  });

  it('does not re-arm on the auto-attach path when it reaches the same target and session twice', async () => {
    const { socket } = await startFakeRegistry([], null, undefined, CREDS);
    const attach = () =>
      socket.emitEvent('Target.attachedToTarget', {
        targetInfo: {
          targetId: 'T1',
          type: 'page',
          title: '',
          url: 'https://a.example',
          attached: true,
        },
        sessionId: 'S1',
        waitingForDebugger: true,
      });

    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    attach();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.allSent('Fetch.enable')).toHaveLength(1);
  });

  it('a cross origin navigation (new Target.attachedToTarget, fresh session, same target) re-arms proxy auth on the new session rather than leaving it silently off', async () => {
    const { socket } = await startFakeRegistry([], null, undefined, CREDS);

    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: {
        targetId: 'T1',
        type: 'page',
        title: '',
        url: 'https://a.example',
        attached: true,
      },
      sessionId: 'S1',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    socket.emitEvent('Target.detachedFromTarget', { targetId: 'T1', sessionId: 'S1' });
    socket.emitEvent('Target.attachedToTarget', {
      targetInfo: { targetId: 'T1', type: 'page', title: '', url: 'https://b.example' },
      sessionId: 'S2',
      waitingForDebugger: true,
    });
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    const sent = socket.allSent('Fetch.enable');
    expect(sent).toHaveLength(2);
    expect(sent[0]?.sessionId).toBe('S1');
    expect(sent[1]?.sessionId).toBe('S2');
  });

  it('never arms proxy auth on a worker target (never auto-attached by this registry in the first place)', async () => {
    const { registry, world, socket } = await startFakeRegistry([], null, undefined, CREDS);
    world.targetInfos.push({
      targetId: 'T1',
      type: 'worker',
      title: 'a',
      url: 'https://a.example/worker.js',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;

    await registry.attach(target.id);

    expect(socket.allSent('Fetch.enable')).toHaveLength(0);
  });

  it('re-arms proxy auth after a transport reconnect: the fresh session a post-reconnect re-attach gets is armed on the NEW socket', async () => {
    const { bridge, sockets, world, instanceId } = await connectFakeBridgeReconnectable({
      backoffMs: [1],
      dialTimeoutMs: 200,
    });
    const registry = new TargetRegistryImpl(instanceId, bridge, [], null, CREDS);
    await registry.start();

    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://a.example',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;
    await registry.attach(target.id);
    expect(sockets[0]?.allSent('Fetch.enable')).toHaveLength(1);

    // An unexpected transport drop. `CdpBridgeImpl.handleUnexpectedClose`
    // invalidates every session immediately, but deliberately holds the
    // synthesized `Target.detachedFromTarget` back until the redial
    // actually succeeds: announcing it up front turns a dead browser into
    // one unrecoverable per target recovery each and tears viewers down,
    // which `chaos-1-kill-browser` catches. So the target is still marked
    // attached at this instant, and only goes unattached once the browser
    // has answered on the new socket.
    sockets[0]?.simulateClose(1006, 'abnormal', false);
    expect(target.attached).toBe(true);

    // The redial itself. Scripted by hand rather than a second
    // `installDefaultResponder` (whose own `attachCounter` starts fresh per
    // world, and would coincidentally reissue the exact same session id
    // `T1` already had, masking a genuine re-arm behind the idempotency
    // guard's "same session, skip" path): real Chrome never reuses a
    // session id across a reattach, so this responder deliberately mints a
    // DIFFERENT one to prove the re-arm below is real, not a false pass.
    (sockets[1] as FakeCdpWebSocket).autoRespond = (msg, sock) => {
      if (msg.method === 'Browser.getVersion') {
        sock.emitResult(msg.id, {
          protocolVersion: '1.3',
          product: 'Chrome/131.0.6778.86',
          revision: '@abcdef',
          userAgent: 'Mozilla/5.0 (fake)',
          jsVersion: '13.1.0',
        });
        return;
      }
      if (msg.method === 'Target.attachToTarget') {
        sock.emitResult(msg.id, { sessionId: 'S1-reconnected' });
        return;
      }
      sock.emitResult(msg.id, {});
    };
    sockets[1]?.open();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.state).toBe('open');
    // The detach lands here, once the browser has proved it is alive, and
    // the registry turns it into the target going unattached exactly as a
    // real Chrome-side detach would.
    expect(target.attached).toBe(false);

    // `recovery-target.ts`'s `reattachSession` is the real caller here;
    // this reproduces its own re-attach call directly against the SAME
    // target id, now that the bridge is open again on the new socket.
    await registry.attach(target.id);

    const rearmed = sockets[1]?.allSent('Fetch.enable') ?? [];
    expect(rearmed).toHaveLength(1);
    expect(rearmed[0]?.params).toEqual({
      patterns: [{ urlPattern: '*', requestStage: 'Request' }],
      handleAuthRequests: true,
    });
  });
});

describe('TargetRegistry.setWindowBounds', () => {
  it('sends Browser.setWindowBounds with the windowId and given bounds', async () => {
    const { registry, socket } = await startFakeRegistry();
    await registry.setWindowBounds(5, { left: 10, top: 20, width: 800, height: 600 });
    const sent = socket.lastSent('Browser.setWindowBounds');
    expect(sent?.params).toEqual({
      windowId: 5,
      bounds: { left: 10, top: 20, width: 800, height: 600 },
    });
  });

  it('never throws when Browser.setWindowBounds fails', async () => {
    const { registry, socket } = await startFakeRegistry();
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Browser.setWindowBounds') {
        s.emitError(msg.id, { code: -32000, message: 'no such window' });
        return;
      }
      defaultRespond?.(msg, s);
    };

    await expect(registry.setWindowBounds(5, { width: 100 })).resolves.toBeUndefined();
  });
});

describe('TargetRegistry navigation history', () => {
  it('a history reading after a navigation carries the new URL with it, before any targetInfoChanged', async () => {
    // `Target.targetInfoChanged` is debounced, so the URL used to trail the
    // back and forward flags: a tab strip could show forward available
    // next to the page it had just gone back from.
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com/a',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;
    let history = { currentIndex: 0, entries: [{ url: 'https://example.com/a' }] };
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Page.getNavigationHistory') {
        s.emitResult(msg.id, history);
        return;
      }
      defaultRespond?.(msg, s);
    };
    const handle = await registry.attach(target.id);
    await vi.waitFor(() => expect(socket.allSent('Page.getNavigationHistory').length).toBe(1));

    history = {
      currentIndex: 1,
      entries: [{ url: 'https://example.com/a' }, { url: 'https://example.com/b' }],
    };
    socket.emitEvent('Page.frameNavigated', { frame: { id: 'F1' } }, handle.id);
    await vi.waitFor(() => expect(target.canGoBack).toBe(true));
    expect(target.url).toBe('https://example.com/b');

    history = { ...history, currentIndex: 0 };
    socket.emitEvent('Page.frameNavigated', { frame: { id: 'F1' } }, handle.id);
    await vi.waitFor(() => expect(target.canGoForward).toBe(true));
    expect(target.canGoBack).toBe(false);
    expect(target.url).toBe('https://example.com/a');
  });

  it("leaves a Chrome page's URL to targetInfoChanged, which can spell it differently from the history entry", async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'New Tab',
      url: 'chrome://newtab/',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;
    const defaultRespond = socket.autoRespond;
    socket.autoRespond = (msg, s) => {
      if (msg.method === 'Page.getNavigationHistory') {
        s.emitResult(msg.id, { currentIndex: 0, entries: [{ url: 'chrome://new-tab-page/' }] });
        return;
      }
      defaultRespond?.(msg, s);
    };
    await registry.attach(target.id);
    await vi.waitFor(() => expect(socket.allSent('Page.getNavigationHistory').length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(target.url).toBe('chrome://newtab/');
  });
});

describe('TargetRegistry.isClosing', () => {
  it('is true from an accepted Target.closeTarget until Target.targetDestroyed, and never for a plain detach', async () => {
    const { registry, world, socket } = await startFakeRegistry();
    world.targetInfos.push({
      targetId: 'T1',
      type: 'page',
      title: 'a',
      url: 'https://example.com',
      attached: false,
    });
    await registry.resync();
    const target = registry.all()[0]!;
    await registry.attach(target.id);
    await registry.detach(target.id);
    expect(registry.isClosing(target.id)).toBe(false);

    await registry.close(target.id);
    expect(registry.tabs()).toHaveLength(1);
    expect(registry.isClosing(target.id)).toBe(true);

    socket.emitEvent('Target.targetDestroyed', { targetId: 'T1' });
    expect(registry.tabs()).toHaveLength(0);
    expect(registry.isClosing(target.id)).toBe(false);
  });
});
