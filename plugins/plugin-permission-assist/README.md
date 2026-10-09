# `@browserglass/plugin-permission-assist`

The reference `permission-assist` plugin (see `docs/plugins.md`). It
clicks Chrome's own "Allow remote debugging?" sheet via macOS accessibility
traversal, without ever foregrounding Chrome, when `bgls attach` finds a
Chrome that is running but not yet reachable over CDP.

This is a real, separate npm project, deliberately excluded from the root
`pnpm-workspace.yaml`, the same way `plugins/plugin-video-export` and
`examples/nextjs-demo` are: it is a plugin, not a BrowserGlass workspace
package, so it must not be dragged into `check-deps`, the workspace build,
or the published package set.

## The platform split, stated plainly

Only the macOS half lives in this package. Opening
`chrome://inspect/#remote-debugging`, rate limited by a marker file's mtime,
is cross platform and lives in `packages/cli/src/commands/attach.ts`
instead, right next to the discovery call it complements: it helps whether
or not this plugin is installed, so it is never gated behind installing
anything.

What this plugin does is the part that only exists on macOS: pressing the
"Allow" button on Chrome's own permission sheet via `System Events`
accessibility traversal (`src/macos.ts`). `platforms: ['darwin']` in
`src/index.ts`'s manifest is checked twice before this file ever runs on
another platform: once at
`bgls plugins add` time, and once by the loader itself before the entry
file is even read off disk.

## Not yet verified on a real Mac

This package was written on a Windows machine. Everything
in `src/macos.ts` beyond argument and script construction is marked in that
file's own header as never executed on the machine that wrote it: no test
here spawns a real `osascript`, clicks a real sheet, or checks a real
Accessibility grant. What is genuinely tested from this machine: the plugin
manifest's shape against `@browserglass/plugin-api`'s own validator, the
platform gate (`probe()` refuses honestly off macOS), the `chrome://inspect`
toggle reader against real fixture `Local State` files, and every branch of
`approveRemoteDebugging()`'s outcome classification, driven through an
injected fake in place of a real `osascript` call.

The real macOS half still needs to be verified on a Mac before this plugin
is relied on.

## `assist()`'s `'resolved'` is not proof

This plugin's `assist()` reports `'resolved'` when it believes it clicked
the sheet. `packages/cli/src/commands/attach.ts` never takes that on trust:
it re-probes `discoverLocalBrowser()` before retrying an attach, the same
"a file existing is not proof, a live round trip is" rule
`local-browser-discovery.ts` already applies to its own
`DevToolsActivePort` file.

## Build and test

```bash
npm install
npm run typecheck
npm run build   # -> dist/plugin.mjs, one file, zero runtime dependencies
npm run test
```

`npm run build` bundles everything except Node's own builtins into one
`dist/plugin.mjs`, so the sha512 `bgls plugins add` records for this plugin
covers every line that will execute.
