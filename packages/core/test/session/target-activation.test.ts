import type { TargetId } from '@browserglass/protocol';
import { describe, expect, it } from 'vitest';
import { TargetActivationPolicy } from '../../src/session/target-activation.js';
import type { RawFrame } from '../../src/stream/types.js';
import { startFakeRegistry } from '../cdp/test-helpers.js';

/**
 * Measured against real Chrome: at most one target per Chrome window ever
 * produces continuous live screencast frames. These tests assert
 * `TargetActivationPolicy` keeps exactly one subscribed target on a
 * `CdpScreencastSource` and demotes every other one to `ScreenshotPollSource`.
 */
describe('TargetActivationPolicy (one live target)', () => {
  it('the first subscribed target becomes active (screencast); a second one starts in background (poll) mode', async () => {
    const { bridge, registry, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
    ];
    await registry.resync();
    const tabs = registry.tabs();
    const a = tabs[0]!.id;
    const b = tabs[1]!.id;

    const frames: Array<{ targetId: TargetId; frame: RawFrame }> = [];
    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: () => ({
        codec: 'jpeg',
        quality: 80,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
      }),
      onFrame: (targetId, frame) => frames.push({ targetId, frame }),
    });

    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id);
    expect(policy.activeTargetId).toBe(a);
    expect(policy.modeOf(a)).toBe('active');

    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id);
    expect(policy.activeTargetId).toBe(a); // unchanged: b starts backgrounded.
    expect(policy.modeOf(b)).toBe('background');

    void frames;
  });

  it('activate() promotes a background target and demotes the previously active one', async () => {
    const { registry, bridge, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
    ];
    await registry.resync();
    const tabs = registry.tabs();
    const a = tabs[0]!.id;
    const b = tabs[1]!.id;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: () => ({
        codec: 'jpeg',
        quality: 80,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
      }),
      onFrame: () => {},
    });

    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id);
    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id);
    expect(policy.modeOf(a)).toBe('active');
    expect(policy.modeOf(b)).toBe('background');

    await policy.activate(b);
    expect(policy.activeTargetId).toBe(b);
    expect(policy.modeOf(b)).toBe('active');
    expect(policy.modeOf(a)).toBe('background');

    const activateCalls = registry.tabs(); // sanity: registry still tracks both.
    expect(activateCalls).toHaveLength(2);
  });

  it('activate() is a no-op when the target is already active', async () => {
    const { registry, bridge, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: () => ({
        codec: 'jpeg',
        quality: 80,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
      }),
      onFrame: () => {},
    });
    const handle = await registry.attach(a);
    await policy.ensureSubscribed(a, handle.id);
    await policy.activate(a);
    expect(policy.activeTargetId).toBe(a);
    expect(policy.modeOf(a)).toBe('active');
  });

  it('remove() stops and forgets a target, clearing activeTargetId if it was active', async () => {
    const { registry, bridge, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: () => ({
        codec: 'jpeg',
        quality: 80,
        maxWidth: 800,
        maxHeight: 600,
        everyNthFrame: 1,
      }),
      onFrame: () => {},
    });
    const handle = await registry.attach(a);
    await policy.ensureSubscribed(a, handle.id);
    expect(policy.activeTargetId).toBe(a);
    await policy.remove(a);
    expect(policy.activeTargetId).toBeNull();
    expect(policy.current(a)).toBeNull();
  });
});

/**
 * `packages/runtime-host/test/spike/spike-window-isolation.ts` measured
 * that the one live target ceiling is really per OS window, not per
 * Instance: 4 targets in 4 windows held 4/4 streams live at once. These
 * tests assert `TargetActivationPolicy` picks one active target per
 * window rather than one for the whole Instance, and that nothing done to
 * one window's active target ever reaches another window's.
 *
 * `TargetRegistry.windowIdFor` reads `TargetRuntime.windowId` before
 * making any CDP call, so these tests set that field directly on the
 * object `registry.get()` returns rather than teaching the fake CDP
 * responder (owned by the CDP layer's own test suite) to answer
 * `Browser.getWindowForTarget` with anything specific. A target whose
 * `windowId` is left `null` gets the real registry's real behaviour: the
 * fake responder's catch-all success reply carries no `windowId`, so
 * `windowIdFor` resolves `null`, same as an unknown window in production.
 */
describe('TargetActivationPolicy per-window activation (spike-window-isolation.ts)', () => {
  const spec = () => ({
    codec: 'jpeg' as const,
    quality: 80,
    maxWidth: 800,
    maxHeight: 600,
    everyNthFrame: 1,
  });

  it("targets in different windows each become their own window's active target", async () => {
    const { bridge, registry, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;
    const b = registry.tabs()[1]!.id;
    registry.get(a)!.windowId = 100;
    registry.get(b)!.windowId = 200;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: spec,
      onFrame: () => {},
    });
    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id);
    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id);

    // Neither target ever shared a window with the other, so both become
    // active: this is the whole point of the fix, one active screencast
    // isn't a ceiling shared across the Instance any more.
    expect(policy.modeOf(a)).toBe('active');
    expect(policy.modeOf(b)).toBe('active');
    expect(policy.activeTargetIn(100)).toBe(a);
    expect(policy.activeTargetIn(200)).toBe(b);
    expect([...policy.activeTargetIds].sort()).toEqual([a, b].sort());
  });

  it("activate() promotes within its own window and never touches a different window's active target", async () => {
    const { bridge, registry, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
      { targetId: 'cdp-c', type: 'page', title: 'C', url: 'https://c.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;
    const b = registry.tabs()[1]!.id;
    const c = registry.tabs()[2]!.id;
    registry.get(a)!.windowId = 100;
    registry.get(b)!.windowId = 100;
    registry.get(c)!.windowId = 200;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: spec,
      onFrame: () => {},
    });
    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id); // window 100's first: active.
    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id); // window 100's second: background.
    const handleC = await registry.attach(c);
    await policy.ensureSubscribed(c, handleC.id); // window 200's first: active, unrelated to window 100.

    const cSourceBefore = policy.current(c);

    // Input on b promotes it within window 100. Simulates a viewer
    // clicking pane b: this must never disturb window 200's own pane.
    await policy.activate(b);

    expect(policy.modeOf(b)).toBe('active');
    expect(policy.modeOf(a)).toBe('background');
    expect(policy.activeTargetIn(100)).toBe(b);
    // c's window was never read as `windowKey` inside activate(b)'s demotion
    // step, so its capture is neither stopped nor rebuilt: same mode, same
    // `FrameSource` instance.
    expect(policy.modeOf(c)).toBe('active');
    expect(policy.activeTargetIn(200)).toBe(c);
    expect(policy.current(c)).toBe(cSourceBefore);
  });

  it('remove() promotes a subscribed sibling in the same window, and drops the window once it has none left', async () => {
    const { bridge, registry, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;
    const b = registry.tabs()[1]!.id;
    registry.get(a)!.windowId = 100;
    registry.get(b)!.windowId = 100;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: spec,
      onFrame: () => {},
    });
    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id);
    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id);
    expect(policy.modeOf(a)).toBe('active');
    expect(policy.modeOf(b)).toBe('background');

    await policy.remove(a);
    // b is the only remaining subscribed target in window 100: promoted
    // rather than left with nothing live, unlike the old "does not
    // auto-promote" behaviour.
    expect(policy.activeTargetIn(100)).toBe(b);
    expect(policy.modeOf(b)).toBe('active');

    await policy.remove(b);
    // No subscribed target left in window 100 at all: the window key
    // itself is dropped, not left pointing at a removed target.
    expect(policy.activeTargetIn(100)).toBeNull();
    expect(policy.activeTargetIds).toHaveLength(0);
  });

  it("ensureSubscribed rebuilds a stale-mode capture once a target's window resolves to one that already has a different active target", async () => {
    const { bridge, registry, world } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
      { targetId: 'cdp-b', type: 'page', title: 'B', url: 'https://b.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;
    const b = registry.tabs()[1]!.id;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: spec,
      onFrame: () => {},
    });

    // b's window is known from the start: it becomes window 100's active target.
    registry.get(b)!.windowId = 100;
    const handleB = await registry.attach(b);
    await policy.ensureSubscribed(b, handleB.id);
    expect(policy.modeOf(b)).toBe('active');

    // a's window is not resolved yet: it lands in the unknown-window bucket
    // and becomes active there, since nothing else is in that bucket.
    const handleA = await registry.attach(a);
    await policy.ensureSubscribed(a, handleA.id);
    expect(policy.modeOf(a)).toBe('active');
    const aSourceBefore = policy.current(a);

    // a's window now resolves to 100, the same window b already owns as
    // active. Calling ensureSubscribed again must re-evaluate, not return
    // the stale 'active' capture: this is the "first subscriber wins
    // forever" bug, now scoped to windows instead of the whole Instance.
    registry.get(a)!.windowId = 100;
    await policy.ensureSubscribed(a, handleA.id);

    expect(policy.modeOf(a)).toBe('background');
    expect(policy.current(a)).not.toBe(aSourceBefore); // rebuilt, not the same FrameSource.
    expect(policy.modeOf(b)).toBe('active'); // b, the window's rightful active target, is untouched.
    expect(policy.activeTargetIn(100)).toBe(b);
  });

  it('rebuild() stops the previous FrameSource before installing the new one, closing the recovery-driven leak', async () => {
    const { bridge, registry, world, socket } = await startFakeRegistry();
    world.targetInfos = [
      { targetId: 'cdp-a', type: 'page', title: 'A', url: 'https://a.example', attached: false },
    ];
    await registry.resync();
    const a = registry.tabs()[0]!.id;

    const policy = new TargetActivationPolicy({
      bridge,
      registry,
      specFor: spec,
      onFrame: () => {},
    });
    const handle = await registry.attach(a);
    await policy.ensureSubscribed(a, handle.id);
    const startsBefore = socket.allSent('Page.startScreencast').length;
    const stopsBefore = socket.allSent('Page.stopScreencast').length;
    const sourceBefore = policy.current(a);

    // `recovery-target.ts`'s `RecoveryCapture.rebuild` calls this after a
    // rung re-establishes a CDP session, on the same target, same mode.
    await policy.rebuild(a, handle.id);

    // The old bug: `start()` overwrote `this.captures` without stopping
    // whatever was there, so this rebuild leaked a `CdpScreencastSource`
    // and its frame timer. Fixed: exactly one more stop, for the source
    // this rebuild replaced, before the new one starts.
    expect(socket.allSent('Page.stopScreencast').length).toBe(stopsBefore + 1);
    expect(socket.allSent('Page.startScreencast').length).toBe(startsBefore + 1);
    expect(policy.current(a)).not.toBe(sourceBefore);
    expect(policy.modeOf(a)).toBe('active');
  });
});
