# `@browserglass/plugin-api`

The contract for a BrowserGlass plugin: the manifest every plugin's default
export must satisfy, the two kind specific interfaces (`FrameEncoderPlugin`
and `PermissionAssistPlugin`), and the run-time validator that checks a
loaded plugin's shape rather than casting a type onto it. Zero runtime
dependencies, no `node:` imports. See
[`docs/plugins.md`](../../docs/plugins.md) for how plugins are installed,
loaded, and gated.

This package is not loaded by `bgls serve` or by anything in
`packages/core`. It exists so a plugin author can build against real types
and run the same validator this repository's own loader
(`packages/cli/src/plugins/`) runs, and so the gateway, which never loads a
plugin, never needs to depend on it either.

## Install

Nothing under `@browserglass/*` is on npm yet: `npm view
@browserglass/plugin-api` returns a 404, and so does every sibling package.
The only way to get this package today is cloning the repository and
building it; see [`docs/quickstart.md`](../../docs/quickstart.md) for the
exact commands.

Once a version is published, every package here will use the `alpha` npm
dist-tag, never `latest`, so a plain `npm install @browserglass/plugin-api`
still will not resolve. You will ask for the alpha explicitly:

```sh
npm install @browserglass/plugin-api@alpha
```

## Writing a plugin

A `frame-encoder` plugin's default export must satisfy
`FrameEncoderPlugin`:

```ts
import type { FrameEncoderPlugin } from '@browserglass/plugin-api';

const plugin: FrameEncoderPlugin = {
  id: '@your-scope/plugin-video-export',
  kind: 'frame-encoder',
  hostApi: '^1.0.0',
  platforms: ['darwin', 'linux', 'win32'],
  summary: 'Encodes exported frames to mp4 via a system ffmpeg.',
  async probe() {
    // Locate ffmpeg, verify it reports a version, never throw.
    return { usable: true, detail: 'ffmpeg 7.1 at /opt/homebrew/bin/ffmpeg' };
  },
  async encode(req, signal) {
    // req.inputDir, req.frames, req.outPath, req.fps: nothing else.
    return { outcome: 'encoded', detail: 'wrote 412 frames at 30fps', bytesWritten: 8_213_004 };
  },
};

export default plugin;
```

A `permission-assist` plugin satisfies `PermissionAssistPlugin` the same
way, exporting an `assist(situation, signal)` instead of `encode`.

Before shipping, run the same check the host runs at load time:

```ts
import { validatePluginManifest } from '@browserglass/plugin-api';

const result = validatePluginManifest((await import('./dist/plugin.mjs')).default);
if (!result.ok) throw new Error(result.reason);
```

`validatePluginManifest` checks shape only: that `id`, `kind`, `hostApi`,
`platforms`, `summary` and `probe` are present and well typed, and that the
kind specific verb (`encode` or `assist`) exists. It does not check that
`id` matches a `bgls-plugins.json` record, that `platforms` includes the
running `process.platform`, or that `hostApi` satisfies the host's
contract version: those checks need data only the host has, and are made
by the CLI's loader when a plugin is actually loaded.

## Where to go next

[`docs/plugins.md`](../../docs/plugins.md) covers what a plugin can and
cannot reach, why it is loaded only by the
CLI and never by the gateway, and the failure and absence rules every
plugin call is held to.
