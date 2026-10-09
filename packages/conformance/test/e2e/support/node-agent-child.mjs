import { DEFAULT_BROWSER_SPEC } from '@browserglass/protocol';
/**
 * Chaos scenario 2's "the node agent": a real, separate OS process, launched via `node`, that
 * starts a real `@browserglass/runtime-host` `HostRuntime`, launches a
 * real Chrome, navigates it to a known URL, and then goes idle. The
 * parent test process SIGKILLs this process (not a graceful `dispose()`)
 * and then starts a fresh `HostRuntime` in its own process, pointed at
 * the same `stateDir`/`profileRoot`, to prove the real startup reattach
 * path: Chrome was never asked to restart, because nothing in this
 * process's control flow ever runs after the kill signal arrives.
 *
 * Run as: `node node-agent-child.mjs <stateDir> <profileRoot> <nodeId> <instanceId> <initialUrl>`.
 * Prints one JSON line to stdout once the browser is up:
 * `{pid, browserGuid, profilePath, cdpUrl}`.
 */
import { createHostRuntime } from '@browserglass/runtime-host';

const [, , stateDir, profileRoot, nodeId, instanceId, initialUrl] = process.argv;

const { runtime } = await createHostRuntime({
  nodeId,
  stateDir,
  profileRoot,
  killOnShutdown: false,
});

// `BrowserSpec.initialUrl` is not read anywhere in `@browserglass/runtime-host`
// (confirmed directly: no reference to `initialUrl` in `packages/runtime-host/src`),
// so it is not this build's real navigation mechanism. The tab is navigated after launch instead, via
// Chrome's own `/json/new?<url>` HTTP endpoint, real and independent of
// any router/core wiring.
const spec = { ...DEFAULT_BROWSER_SPEC };
const profile = {
  profileId: `prf-${instanceId}`,
  path: `${profileRoot}/prf-${instanceId}`,
  containerPath: null,
  mode: 'ephemeral',
  lease: { fence: 1, expiresAt: Date.now() + 300_000 },
};

const handle = await runtime.launch({
  instanceId,
  spec,
  profile,
  deadlineAt: Date.now() + 45_000,
  labels: {},
  signal: { aborted: false },
});

const cdpBase = handle.transport.kind === 'http' ? handle.transport.cdpUrl : null;
if (cdpBase && initialUrl) {
  // A genuinely new tab, navigated to `initialUrl` by Chrome's own HTTP
  // endpoint, real and independent of any router/core CDP wiring.
  await fetch(`${cdpBase}/json/new?${encodeURIComponent(initialUrl)}`, { method: 'PUT' });
}

process.stdout.write(
  `${JSON.stringify({
    pid: handle.pid,
    browserGuid: handle.browserGuid,
    profilePath: handle.profilePath,
    cdpUrl: handle.transport.kind === 'http' ? handle.transport.cdpUrl : null,
  })}\n`,
);

// Idle forever: this process is killed by SIGKILL from the parent test,
// never asked to shut down gracefully. No `dispose()` call is reachable
// from here on purpose. `HostRuntime`'s own internal timers are all
// `.unref()`'d (this build's universal rule for lease/idle/watchdog
// timers), so a bare unresolved `Promise` registers no handle at all and
// Node exits the moment the event loop otherwise drains; a real,
// `ref()`'d interval is what actually keeps this process alive until the
// parent's SIGKILL arrives.
setInterval(() => {}, 60_000);
